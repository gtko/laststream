import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { encodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { AllDebridError, type ResolveOptions, type ResolvedLink } from '../src/sources/alldebrid.js';
import { serveApp } from './serve.js';

const SECRET = 'play-test-secret';
const API_KEY = 'AD-PLAY-KEY-SECRETE-789';
const HASH = 'b'.repeat(40);
const LINK = 'https://dl.alldebrid.example/file.mkv?token=T1';

interface ResolveCall {
  infoHash: string;
  fileIdx: number | undefined;
  opts: ResolveOptions | undefined;
}

type ResolveImpl = (infoHash: string, fileIdx?: number, opts?: ResolveOptions) => Promise<ResolvedLink>;

/** Fabrique de client factice : enregistre les appels et délègue `resolve` à `impl`. */
function makeFactory(impl: { resolve: ResolveImpl }): {
  factory: NonNullable<AppDeps['alldebridFactory']>;
  calls: ResolveCall[];
  factoryCalls: { count: number };
} {
  const calls: ResolveCall[] = [];
  const factoryCalls = { count: 0 };
  const factory: NonNullable<AppDeps['alldebridFactory']> = () => {
    factoryCalls.count += 1;
    return {
      resolve: async (infoHash: string, fileIdx?: number, opts?: ResolveOptions) => {
        calls.push({ infoHash, fileIdx, opts });
        return impl.resolve(infoHash, fileIdx, opts);
      },
      resolveTorrentFile: async () => {
        throw new AllDebridError('unknown', 'non attendu dans ce test');
      },
      call: async () => {
        throw new AllDebridError('unknown', 'non attendu dans ce test');
      },
      checkCached: async () => new Map<string, boolean>(),
      checkApiKey: async () => ({ ok: true, premium: true }),
    };
  };
  return { factory, calls, factoryCalls };
}

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

async function start(deps: AppDeps): Promise<Running> {
  const server: Server = serveApp(createApp(deps));
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const okLink: ResolveImpl = async () => ({ url: LINK, filename: 'file.mkv', size: 10 });
const debridConfig = (apiKey = API_KEY): string => encodeConfig({ debrid: { service: 'alldebrid', apiKey } }, SECRET);

describe('GET /:config/play/:infoHash/:fileIdx? (factory injectée)', () => {
  const { factory, calls } = makeFactory({ resolve: okLink });
  let main: Running;
  let plain: Running;

  beforeAll(async () => {
    main = await start({ secret: SECRET, allowPlain: false, alldebridFactory: factory });
    plain = await start({ secret: SECRET, allowPlain: true, alldebridFactory: factory });
  });

  afterAll(async () => {
    await main.close();
    await plain.close();
  });

  const play = (base: string, path: string): Promise<Response> => fetch(`${base}${path}`, { redirect: 'manual' });

  it('répond 302 vers le lien debrid avec Cache-Control no-store', async () => {
    const res = await play(main.baseUrl, `/${debridConfig()}/play/${HASH}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(LINK);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('transmet le hash et l\'index de fichier à resolve', async () => {
    calls.length = 0;
    const res = await play(main.baseUrl, `/${debridConfig()}/play/${HASH}/3`);
    expect(res.status).toBe(302);
    expect(calls.at(-1)).toEqual({
      infoHash: HASH,
      fileIdx: 3,
      opts: { season: undefined, episode: undefined },
    });
  });

  it('transmet les paramètres de série ?s= et ?e=', async () => {
    calls.length = 0;
    await play(main.baseUrl, `/${debridConfig()}/play/${HASH}?s=1&e=2`);
    expect(calls.at(-1)?.opts).toEqual({ season: 1, episode: 2 });
  });

  it('ignore les paramètres de série mal formés', async () => {
    calls.length = 0;
    await play(main.baseUrl, `/${debridConfig()}/play/${HASH}?s=abc&e=-1`);
    expect(calls.at(-1)?.opts).toEqual({ season: undefined, episode: undefined });
  });

  it('transmet le nom et la taille attendus (?filename=&size=) et ignore les valeurs mal formées', async () => {
    calls.length = 0;
    await play(main.baseUrl, `/${debridConfig()}/play/${HASH}/1?s=1&e=2&filename=${encodeURIComponent('Show.S01E02.mkv')}&size=1234`);
    expect(calls.at(-1)?.opts).toEqual({ season: 1, episode: 2, filename: 'Show.S01E02.mkv', size: 1234 });

    calls.length = 0;
    await play(main.baseUrl, `/${debridConfig()}/play/${HASH}/1?size=12abc&filename=`);
    expect(calls.at(-1)?.opts).toEqual({ season: undefined, episode: undefined, filename: undefined, size: undefined });
  });

  it('répond 400 à un hash invalide sans appeler le debrid', async () => {
    calls.length = 0;
    const short = await play(main.baseUrl, `/${debridConfig()}/play/${'b'.repeat(39)}`);
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'invalid_hash' });
    const notHex = await play(main.baseUrl, `/${debridConfig()}/play/${'z'.repeat(40)}`);
    expect(notHex.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('répond 400 à un index de fichier non numérique', async () => {
    const res = await play(main.baseUrl, `/${debridConfig()}/play/${HASH}/abc`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_file_idx' });
  });

  it('répond 400 à une configuration illisible', async () => {
    const res = await play(main.baseUrl, `/abcdef/play/${HASH}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config' });
  });

  it('répond 400 à une configuration chiffrée avec une autre clé', async () => {
    const foreign = encodeConfig({ debrid: { service: 'alldebrid', apiKey: API_KEY } }, 'autre-secret');
    const res = await play(main.baseUrl, `/${foreign}/play/${HASH}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_config' });
  });

  it('répond 404 no_debrid quand la configuration n\'a pas de debrid', async () => {
    const res = await play(main.baseUrl, `/${encodeConfig({}, SECRET)}/play/${HASH}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_debrid' });
  });

  it('répond 503 avec Retry-After: 5 quand le magnet n\'est pas prêt (page d\'échec, JSON si demandé)', async () => {
    const notReady = makeFactory({
      resolve: async () => {
        throw new AllDebridError('not_ready', 'not_ready');
      },
    });
    const running = await start({ secret: SECRET, allowPlain: false, alldebridFactory: notReady.factory });
    try {
      const json = await fetch(`${running.baseUrl}/${debridConfig()}/play/${HASH}`, {
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      expect(json.status).toBe(503);
      expect(json.headers.get('retry-after')).toBe('5');
      expect(json.headers.get('cache-control')).toBe('no-store');
      expect(await json.json()).toEqual({
        error: 'play_failed',
        reason: 'host_unavailable',
        message: expect.stringContaining('Hébergeur indisponible'),
      });

      const html = await play(running.baseUrl, `/${debridConfig()}/play/${HASH}`);
      expect(html.status).toBe(503);
      expect(html.headers.get('content-type')).toContain('text/html');
      expect(await html.text()).toContain('Hébergeur indisponible');
    } finally {
      await running.close();
    }
  });

  it('répond 401 invalid_key sans détail ni clé pour une erreur API', async () => {
    const failing = makeFactory({
      resolve: async () => {
        throw new AllDebridError('AUTH_BAD_APIKEY', `refusé ${API_KEY}`);
      },
    });
    const running = await start({ secret: SECRET, allowPlain: false, alldebridFactory: failing.factory });
    try {
      const res = await fetch(`${running.baseUrl}/${debridConfig()}/play/${HASH}`, {
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'play_failed',
        reason: 'invalid_key',
        message: expect.any(String),
      });
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain('AUTH_BAD_APIKEY');
    } finally {
      await running.close();
    }
  });

  it('répond 500 unknown pour une erreur inattendue sans fuite de la clé', async () => {
    const broken = makeFactory({
      resolve: async () => {
        throw new TypeError(`échec ${API_KEY}`);
      },
    });
    const running = await start({ secret: SECRET, allowPlain: false, alldebridFactory: broken.factory });
    try {
      const res = await play(running.baseUrl, `/${debridConfig()}/play/${HASH}`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain('Erreur inconnue');
      expect(text).not.toContain(API_KEY);
    } finally {
      await running.close();
    }
  });

  it('accepte une configuration en JSON brut seulement si allowPlain est actif', async () => {
    const plainConfig = Buffer.from(JSON.stringify({ debrid: { service: 'alldebrid', apiKey: API_KEY } })).toString(
      'base64url',
    );
    const accepted = await play(plain.baseUrl, `/${plainConfig}/play/${HASH}`);
    expect(accepted.status).toBe(302);
    const refused = await play(main.baseUrl, `/${plainConfig}/play/${HASH}`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_config' });
  });

  it('ne fait apparaître la clé API dans aucune réponse', async () => {
    const paths = [
      `/${debridConfig()}/play/${HASH}`,
      `/${debridConfig()}/play/${HASH}/1`,
      `/${debridConfig()}/play/xyz`,
      `/${encodeConfig({}, SECRET)}/play/${HASH}`,
      `/abcdef/play/${HASH}`,
    ];
    for (const path of paths) {
      const res = await play(main.baseUrl, path);
      const body = await res.text();
      expect(body).not.toContain(API_KEY);
      expect([...res.headers.values()].join(' ')).not.toContain(API_KEY);
    }
  });
});

describe('GET /:config/play (cache de client)', () => {
  it('crée un seul client par clé API', async () => {
    const { factory, factoryCalls } = makeFactory({ resolve: okLink });
    const running = await start({ secret: SECRET, allowPlain: false, alldebridFactory: factory });
    try {
      await fetch(`${running.baseUrl}/${debridConfig()}/play/${HASH}`, { redirect: 'manual' });
      await fetch(`${running.baseUrl}/${debridConfig()}/play/${HASH}/2`, { redirect: 'manual' });
      expect(factoryCalls.count).toBe(1);
      await fetch(`${running.baseUrl}/${debridConfig('AUTRE-CLE-123')}/play/${HASH}`, { redirect: 'manual' });
      expect(factoryCalls.count).toBe(2);
    } finally {
      await running.close();
    }
  });
});

describe('GET /:config/play (client AllDebrid réel, fetch injecté)', () => {
  it('résout via l\'API mockée et envoie la clé dans Authorization uniquement', async () => {
    const seen: { path: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seen.push({ path: url.pathname, auth: new Headers(init?.headers).get('authorization') });
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      switch (url.pathname) {
        case '/v4/magnet/upload':
          return json({ status: 'success', data: { magnets: [{ hash: HASH, ready: true, id: 5 }] } });
        case '/v4/magnet/files':
          return json({
            status: 'success',
            data: { magnets: [{ id: 5, files: [{ n: 'movie.mkv', s: 42, l: 'locked' }] }] },
          });
        case '/v4/link/unlock':
          return json({ status: 'success', data: { link: 'https://dl.example.com/real.mkv', filename: 'movie.mkv', filesize: 42 } });
        default:
          return json({ status: 'error', error: { code: 'UNEXPECTED', message: 'x' } });
      }
    }) as unknown as typeof fetch;

    const running = await start({ secret: SECRET, allowPlain: false, fetch: fetchImpl });
    try {
      const res = await fetch(`${running.baseUrl}/${debridConfig()}/play/${HASH}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://dl.example.com/real.mkv');
      expect(seen.every((call) => call.auth === `Bearer ${API_KEY}`)).toBe(true);
      expect(seen.map((call) => call.path)).toEqual(['/v4/magnet/upload', '/v4/magnet/files', '/v4/link/unlock']);
    } finally {
      await running.close();
    }
  });
});
