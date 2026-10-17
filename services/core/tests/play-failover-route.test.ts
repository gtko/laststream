import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { encodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { HostHealth } from '../src/play/hosts.js';
import { PackStore } from '../src/play/packs.js';
import type { PlayState } from '../src/play/state.js';
import { type PlayCopy, encodeCopiesToken } from '../src/play/token.js';
import { registerPlayRoutes } from '../src/routes/play.js';
import { AllDebridClient, AllDebridError, type ResolvedLink } from '../src/sources/alldebrid.js';

const SECRET = 'play-failover-route-secret';
const API_KEY = 'AD-FAILOVER-KEY-SECRETE-456';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const LINK_A = 'https://dl.alldebrid.example/a.mkv?token=TA';
const LINK_B = 'https://dl.alldebrid.example/b.mkv?token=TB';
const DIRECT = 'https://direct.example.org/film.mkv';

/** Issue simulée d'une résolution : lien, code d'erreur AllDebrid, ou attente infinie (dépassement du budget). */
type Outcome = { link: string } | { code: string } | 'hang';

/** Client AllDebrid factice : une issue par hash, appels journalisés dans l'ordre. */
function fakeDebrid(outcomes: Record<string, Outcome>): { factory: NonNullable<AppDeps['alldebridFactory']>; calls: string[] } {
  const calls: string[] = [];
  const factory: NonNullable<AppDeps['alldebridFactory']> = () => ({
    resolve: async (infoHash: string): Promise<ResolvedLink> => {
      calls.push(infoHash);
      const outcome = outcomes[infoHash];
      if (outcome === undefined) throw new Error('hash inattendu');
      if (outcome === 'hang') return new Promise<ResolvedLink>(() => undefined);
      if ('code' in outcome) throw new AllDebridError(outcome.code, `AllDebrid : ${outcome.code}`);
      return { url: outcome.link, filename: 'film.mkv', size: 10 };
    },
    checkCached: async () => new Map<string, boolean>(),
    checkApiKey: async () => ({ ok: true, premium: true }),
  });
  return { factory, calls };
}

/** État neuf par test : aucune marque d'hébergeur ni pack ne fuit d'un test à l'autre. */
const freshState = (): PlayState => ({ packStore: new PackStore(), hostHealth: new HostHealth() });

/** Lance l'application minimale (la seule route /play) le temps de `run`, puis la ferme. */
async function withServer<T>(deps: AppDeps, state: PlayState, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  registerPlayRoutes(app, deps, state);
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const get = (base: string, path: string, accept?: string): Promise<Response> =>
  fetch(`${base}${path}`, { redirect: 'manual', headers: accept === undefined ? {} : { Accept: accept } });

const debridConfig = (budgetMs?: number): string =>
  encodeConfig(
    budgetMs === undefined
      ? { debrid: { service: 'alldebrid', apiKey: API_KEY } }
      : { debrid: { service: 'alldebrid', apiKey: API_KEY }, play: { budgetMs } },
    SECRET,
  );

/** Chemin de lecture pour une liste ordonnée de copies. */
const tokenPath = (copies: PlayCopy[], config: string = debridConfig()): string =>
  `/${config}/play/c/${encodeCopiesToken(copies, { secret: SECRET })}`;

const torrent = (infoHash: string): PlayCopy => ({ infoHash, fileIdx: 0 });

describe('GET /:config/play/c/:token (failover)', () => {
  it('copie 1 non cachée puis copie 2 OK : 302 vers le lien de la copie 2, Cache-Control no-store', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'not_ready' }, [HASH_B]: { link: LINK_B } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(LINK_B);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
    expect(calls).toEqual([HASH_A, HASH_B]);
  });

  it('une copie directe (url) est renvoyée telle quelle après un échec torrent', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'LINK_DOWN' } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), { url: DIRECT }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
    expect(calls).toEqual([HASH_A]);
  });

  it('toutes les copies échouent : page HTML en français, ou JSON si Accept le demande', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: { code: 'LINK_DOWN' }, [HASH_B]: { code: 'not_ready' } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const path = tokenPath([torrent(HASH_A), torrent(HASH_B)]);

      const html = await get(base, path);
      expect(html.status).toBe(404);
      expect(html.headers.get('content-type')).toContain('text/html');
      expect(html.headers.get('cache-control')).toBe('no-store');
      const page = await html.text();
      expect(page).toContain('lang="fr"');
      expect(page).toContain('Pas en cache');
      expect(page).not.toContain(API_KEY);
      expect(page).not.toContain('dl.alldebrid.example');

      const json = await get(base, path, 'application/json');
      expect(json.status).toBe(404);
      expect(json.headers.get('content-type')).toContain('application/json');
      const body = await json.text();
      expect(JSON.parse(body)).toEqual({ error: 'play_failed', reason: 'not_cached', message: expect.any(String) });
      expect(body).not.toContain(API_KEY);
    });
  });

  it('dernière erreur dead_link : 410 avec la page « Lien mort »', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: { code: 'LINK_DOWN' }, [HASH_B]: { code: 'LINK_DOWN' } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(res.status).toBe(410);
      expect(await res.text()).toContain('Lien mort');
    });
  });

  it('AUTH_BAD_APIKEY (invalid_key) arrête la tentative tout de suite : la copie suivante n\'est pas appelée', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'AUTH_BAD_APIKEY' }, [HASH_B]: { link: LINK_B } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]), 'application/json');
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ reason: 'invalid_key' });
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain('AUTH_BAD_APIKEY');
      expect(res.headers.get('location')).toBeNull();
    });
    expect(calls).toEqual([HASH_A]);
  });

  it('host_unavailable marque l\'hôte pour 1 h : les copies torrent suivantes sont sautées, une copie directe reste utilisable', async () => {
    const { factory, calls } = fakeDebrid({
      [HASH_A]: { code: 'LINK_HOST_UNAVAILABLE' },
      [HASH_B]: { link: LINK_B },
    });
    const state = freshState();
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, state, async (base) => {
      const first = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(first.status).toBe(503);
      expect(await first.text()).toContain('Hébergeur indisponible');
      expect(state.hostHealth.isDown('alldebrid')).toBe(true);

      const second = await get(base, tokenPath([torrent(HASH_B), { url: DIRECT }]));
      expect(second.status).toBe(302);
      expect(second.headers.get('location')).toBe(DIRECT);
    });
    // HASH_B n'est jamais appelé : son hôte (alldebrid) est marqué en panne après le premier échec.
    expect(calls).toEqual([HASH_A]);
  });

  it('budget dépassé : 504 timeout', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: 'hang' });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)], debridConfig(1000)), 'application/json');
      expect(res.status).toBe(504);
      expect(JSON.parse(await res.text())).toMatchObject({ reason: 'timeout' });
    });
  }, 10_000);

  it('jeton altéré ou signé avec une autre clé : 400 invalid_token, sans appel au debrid', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const valid = encodeCopiesToken([torrent(HASH_A)], { secret: SECRET });
      const last = valid.at(-1);
      const altered = `${valid.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
      const foreign = encodeCopiesToken([torrent(HASH_A)], { secret: 'autre-secret' });

      for (const token of [altered, foreign, 'pas-un-jeton']) {
        const res = await get(base, `/${debridConfig()}/play/c/${token}`);
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(JSON.parse(body)).toEqual({ error: 'invalid_token', message: expect.any(String) });
        expect(body).not.toContain(API_KEY);
      }
    });
    expect(calls).toEqual([]);
  });

  it('configuration illisible : 400 invalid_config', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)], 'abcdef'));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_config' });
    });
  });

  it('copie directe au schéma non http(s) : jamais de Location', async () => {
    const { factory } = fakeDebrid({});
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const res = await get(base, tokenPath([{ url: 'javascript:alert(1)' }]));
      expect(res.status).toBe(500);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  it('sans debrid : les copies torrent sont écartées, la copie directe reste utilisable', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    const noDebrid = encodeConfig({}, SECRET);
    await withServer({ secret: SECRET, allowPlain: false, alldebridFactory: factory }, freshState(), async (base) => {
      const direct = await get(base, tokenPath([torrent(HASH_A), { url: DIRECT }], noDebrid));
      expect(direct.status).toBe(302);
      expect(direct.headers.get('location')).toBe(DIRECT);

      const onlyTorrents = await get(base, tokenPath([torrent(HASH_A)], noDebrid), 'application/json');
      expect(onlyTorrents.status).toBe(404);
      expect(JSON.parse(await onlyTorrents.text())).toMatchObject({ reason: 'no_copy' });
    });
    expect(calls).toEqual([]);
  });

  it('apprentissage des packs : les fichiers d\'un pack alimentent le PackStore de l\'état', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seen.push(url.pathname);
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      switch (url.pathname) {
        case '/v4/magnet/upload':
          return json({ status: 'success', data: { magnets: [{ hash: HASH_A, ready: true, id: 7 }] } });
        case '/v4/magnet/files':
          return json({
            status: 'success',
            data: {
              magnets: [
                {
                  id: 7,
                  files: [
                    { n: 'Show.S01E01.mkv', s: 100, l: 'L1' },
                    { n: 'Show.S01E02.mkv', s: 200, l: 'L2' },
                  ],
                },
              ],
            },
          });
        case '/v4/link/unlock':
          return json({ status: 'success', data: { link: 'https://dl.example.com/real.mkv', filename: 'Show.S01E02.mkv', filesize: 200 } });
        default:
          return json({ status: 'error', error: { code: 'UNEXPECTED', message: 'x' } });
      }
    }) as unknown as typeof fetch;

    const state = freshState();
    await withServer({ secret: SECRET, allowPlain: false, fetch: fetchImpl }, state, async (base) => {
      const res = await get(base, tokenPath([{ infoHash: HASH_A, fileIdx: 1 }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://dl.example.com/real.mkv');
    });
    expect(seen).toEqual(['/v4/magnet/upload', '/v4/magnet/files', '/v4/link/unlock']);
    expect(state.packStore.get(HASH_A)).toEqual([
      { idx: 0, name: 'Show.S01E01.mkv', size: 100 },
      { idx: 1, name: 'Show.S01E02.mkv', size: 200 },
    ]);
  });
});

describe('AllDebridClient : rappel onFiles', () => {
  const packFetch = (files: { n: string; s: number; l: string }[]): typeof fetch =>
    (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      switch (url.pathname) {
        case '/v4/magnet/upload':
          return json({ status: 'success', data: { magnets: [{ hash: HASH_A, ready: true, id: 9 }] } });
        case '/v4/magnet/files':
          return json({ status: 'success', data: { magnets: [{ id: 9, files }] } });
        case '/v4/link/unlock':
          return json({ status: 'success', data: { link: 'https://dl.example.com/x.mkv' } });
        default:
          return json({ status: 'error', error: { code: 'UNEXPECTED', message: 'x' } });
      }
    }) as unknown as typeof fetch;

  it('un rappel qui lève ne fait pas échouer la résolution', async () => {
    const client = new AllDebridClient(API_KEY, {
      fetch: packFetch([
        { n: 'a.mkv', s: 1, l: 'L1' },
        { n: 'b.mkv', s: 2, l: 'L2' },
      ]),
      onFiles: () => {
        throw new Error('rappel défaillant');
      },
    });
    await expect(client.resolve(HASH_A, 1)).resolves.toMatchObject({ url: 'https://dl.example.com/x.mkv' });
  });

  it('n\'est appelé que pour un pack (plusieurs fichiers), avec idx = position dans la liste', async () => {
    const seen: { hash: string; files: unknown }[] = [];
    const onFiles = (hash: string, files: unknown): void => {
      seen.push({ hash, files });
    };

    const single = new AllDebridClient(API_KEY, { fetch: packFetch([{ n: 'film.mkv', s: 5, l: 'L' }]), onFiles });
    await single.resolve(HASH_A);
    expect(seen).toEqual([]);

    const pack = new AllDebridClient(API_KEY, {
      fetch: packFetch([
        { n: 'a.txt', s: 1, l: 'L1' },
        { n: 'b.mkv', s: 2, l: 'L2' },
      ]),
      onFiles,
    });
    await pack.resolve(HASH_A, 1);
    expect(seen).toEqual([
      {
        hash: HASH_A,
        files: [
          { idx: 0, name: 'a.txt', size: 1 },
          { idx: 1, name: 'b.mkv', size: 2 },
        ],
      },
    ]);
  });
});
