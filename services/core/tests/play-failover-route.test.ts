import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { newApp } from '../src/http/app-env.js';
import { HostHealth } from '../src/play/hosts.js';
import { PackStore } from '../src/play/packs.js';
import type { PlayState } from '../src/play/state.js';
import { type EncodeCopiesOptions, type PlayCopy, encodeCopiesToken } from '../src/play/token.js';
import { registerPlayRoutes } from '../src/routes/play.js';
import { AllDebridClient, AllDebridError, type ResolvedLink } from '../src/sources/alldebrid.js';
import { TorrentCache } from '../src/torrent/fetch-torrent.js';
import { serveApp } from './serve.js';

// Mode serveur AllDebrid explicitement activé (opt-in) : ces scénarios débrident côté serveur.
beforeEach(() => vi.stubEnv('LASTADDON_DEBRID_SERVER_SIDE', '1'));
afterEach(() => vi.unstubAllEnvs());

const SECRET = 'play-failover-route-secret';
const API_KEY = 'AD-FAILOVER-KEY-SECRETE-456';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const LINK_A = 'https://dl.alldebrid.example/a.mkv?token=TA';
const LINK_B = 'https://dl.alldebrid.example/b.mkv?token=TB';
const DIRECT = 'https://direct.example.org/film.mkv';
const HOSTER_URL = 'https://1fichier.example/x7Qa';
const HOSTER_OTHER = 'https://1fichier.example/k2Pz';
const HOSTER_LINK = 'https://dl.1fichier.example/file/abc.mkv?token=TH';
const GUID = 'release-guid-42';
const PRIVATE_BYTES = Buffer.from('d8:announce20:https://tracker.example/e');
const FUTURE = '2999-01-01';
const PAST = '2000-01-01';

/** Issue simulée d'une résolution : lien, code d'erreur AllDebrid, ou attente infinie (dépassement du budget). */
type Outcome = { link: string } | { code: string } | 'hang';

interface FakeOutcomes {
  /** Issue de resolve (magnet), par hash. */
  resolve?: Record<string, Outcome>;
  /** Réponse de /v4/link/unlock, par lien d'hébergeur. Un code est un code AllDebrid brut (ex. LINK_DOWN). */
  unlock?: Record<string, Outcome>;
  /** Issue de resolveTorrentFile (torrent privé), par hash. */
  torrentFile?: Record<string, Outcome>;
}

interface FakeDebrid {
  factory: NonNullable<AppDeps['alldebridFactory']>;
  /** Hashes passés à resolve (magnet), dans l'ordre. */
  calls: string[];
  /** Liens passés à /v4/link/unlock, dans l'ordre. */
  unlocks: string[];
  /** Torrents privés envoyés à resolveTorrentFile : hash, index demandé et octets reçus. */
  torrentFiles: { infoHash: string; fileIdx: number | undefined; bytes: Buffer }[];
}

const linkOk = (url: string): ResolvedLink => ({ url, filename: 'film.mkv', size: 10 });

/** Issue d'un appel simulé : lien, erreur AllDebrid (code brut), ou attente infinie. */
function settle(outcome: Outcome | undefined, label: string): Promise<ResolvedLink> {
  if (outcome === undefined) return Promise.reject(new Error(`${label} inattendu`));
  if (outcome === 'hang') return new Promise<ResolvedLink>(() => undefined);
  if ('code' in outcome) return Promise.reject(new AllDebridError(outcome.code, `AllDebrid : ${outcome.code}`));
  return Promise.resolve(linkOk(outcome.link));
}

/** Client AllDebrid factice : une issue par hash et par lien, appels journalisés dans l'ordre. */
function fakeDebrid(outcomes: Record<string, Outcome>, more: FakeOutcomes = {}): FakeDebrid {
  const calls: string[] = [];
  const unlocks: string[] = [];
  const torrentFiles: FakeDebrid['torrentFiles'] = [];
  const factory: NonNullable<AppDeps['alldebridFactory']> = () => ({
    resolve: async (infoHash: string): Promise<ResolvedLink> => {
      calls.push(infoHash);
      return settle(outcomes[infoHash], infoHash);
    },
    resolveTorrentFile: async (bytes: Buffer, infoHash: string, fileIdx?: number): Promise<ResolvedLink> => {
      torrentFiles.push({ infoHash, fileIdx, bytes: Buffer.from(bytes) });
      return settle(more.torrentFile?.[infoHash], infoHash);
    },
    // Appel brut utilisé par le HosterClient : seul /v4/link/unlock est attendu ici.
    call: async (_method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<Record<string, unknown>> => {
      if (path !== '/v4/link/unlock') throw new AllDebridError('unexpected', 'appel inattendu');
      const link = form?.get('link') ?? '';
      unlocks.push(link);
      const outcome = await settle(more.unlock?.[link], 'unlock');
      return { link: outcome.url, filename: outcome.filename, filesize: outcome.size };
    },
    checkCached: async () => new Map<string, boolean>(),
    checkApiKey: async () => ({ ok: true, premium: true }),
  });
  return { factory, calls, unlocks, torrentFiles };
}

/** État neuf par test : aucune marque d'hébergeur, pack ni torrent ne fuit d'un test à l'autre. */
const freshState = (): PlayState => ({
  packStore: new PackStore(),
  hostHealth: new HostHealth(),
  torrentCache: new TorrentCache(),
});

const depsWith = (factory: NonNullable<AppDeps['alldebridFactory']>): AppDeps => ({
  secret: SECRET,
  allowPlain: false,
  alldebridFactory: factory,
});

/** Lance l'application minimale (la seule route /play) le temps de `run`, puis la ferme. */
async function withServer<T>(deps: AppDeps, state: PlayState, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = newApp();
  registerPlayRoutes(app, deps, state);
  const server: Server = serveApp(app);
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

/** Chemin de lecture pour une liste ordonnée de copies, avec des champs de jeton optionnels (date, âge, saison). */
const tokenPath = (copies: PlayCopy[], config: string = debridConfig(), extra: Omit<EncodeCopiesOptions, 'secret'> = {}): string =>
  `/${config}/play/c/${encodeCopiesToken(copies, { secret: SECRET, ...extra })}`;

const torrent = (infoHash: string): PlayCopy => ({ infoHash, fileIdx: 0 });
const hoster = (url: string): PlayCopy => ({ url, kind: 'hoster', filename: 'film.mkv' });
const privateCopy = (infoHash: string, guid: string | undefined = GUID): PlayCopy => ({
  infoHash,
  fileIdx: 1,
  guid,
  privateTorrent: true,
  filename: 'film.mkv',
});

describe('GET /:config/play/c/:token (failover)', () => {
  it('copie 1 non cachée puis copie 2 OK : 302 vers le lien de la copie 2, Cache-Control no-store', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'not_ready' }, [HASH_B]: { link: LINK_B } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(LINK_B);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
    expect(calls).toEqual([HASH_A, HASH_B]);
  });

  it('une copie directe (url) est renvoyée telle quelle après un échec torrent', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'LINK_DOWN' } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), { url: DIRECT }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
    expect(calls).toEqual([HASH_A]);
  });

  it('toutes les copies échouent : page HTML en français, ou JSON si Accept le demande', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: { code: 'LINK_DOWN' }, [HASH_B]: { code: 'not_ready' } });
    await withServer(depsWith(factory), freshState(), async (base) => {
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
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(res.status).toBe(410);
      expect(await res.text()).toContain('Lien mort');
    });
  });

  it('AUTH_BAD_APIKEY (invalid_key) arrête la tentative tout de suite : la copie suivante n\'est pas appelée', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'AUTH_BAD_APIKEY' }, [HASH_B]: { link: LINK_B } });
    await withServer(depsWith(factory), freshState(), async (base) => {
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

  it('budget dépassé : 504 timeout', async () => {
    const { factory } = fakeDebrid({ [HASH_A]: 'hang' });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)], debridConfig(1000)), 'application/json');
      expect(res.status).toBe(504);
      expect(JSON.parse(await res.text())).toMatchObject({ reason: 'timeout' });
    });
  }, 10_000);

  it('jeton altéré ou signé avec une autre clé : 400 invalid_token, sans appel au debrid', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    await withServer(depsWith(factory), freshState(), async (base) => {
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
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)], 'abcdef'));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_config' });
    });
  });

  it('copie directe au schéma non http(s) : jamais de Location', async () => {
    const { factory } = fakeDebrid({});
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([{ url: 'javascript:alert(1)' }]));
      expect(res.status).toBe(500);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  it('sans debrid : les copies torrent sont écartées, la copie directe reste utilisable', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    const noDebrid = encodeConfig({}, SECRET);
    await withServer(depsWith(factory), freshState(), async (base) => {
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

describe('GET /:config/play/c/:token : contrôles avant toute résolution', () => {
  it('date de sortie future : 404 « Épisode non sorti », aucun appel au debrid, même pour une copie directe', async () => {
    const { factory, calls, unlocks } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), { url: DIRECT }], debridConfig(), { releasedAt: FUTURE }), 'application/json');
      expect(res.status).toBe(404);
      expect(JSON.parse(await res.text())).toMatchObject({ reason: 'not_released' });
      expect(res.headers.get('location')).toBeNull();
    });
    expect(calls).toEqual([]);
    expect(unlocks).toEqual([]);
  });

  it('date de sortie passée : la lecture suit son cours', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)], debridConfig(), { releasedAt: PAST }));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(LINK_A);
    });
    expect(calls).toEqual([HASH_A]);
  });

  it('limite d âge : 403 si la certification dépasse ageLimit, lecture permise sinon ou sans certification connue', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { link: LINK_A } });
    const limited = encodeConfig({ debrid: { service: 'alldebrid', apiKey: API_KEY }, filters: { ageLimit: 12 } }, SECRET);
    await withServer(depsWith(factory), freshState(), async (base) => {
      const refused = await get(base, tokenPath([torrent(HASH_A)], limited, { ageFr: 16 }), 'application/json');
      expect(refused.status).toBe(403);
      expect(JSON.parse(await refused.text())).toMatchObject({ reason: 'age_limit' });

      const allowed = await get(base, tokenPath([torrent(HASH_A)], limited, { ageFr: 12 }));
      expect(allowed.status).toBe(302);

      const unknownAge = await get(base, tokenPath([torrent(HASH_A)], limited));
      expect(unknownAge.status).toBe(302);

      // Sans limite (« none », défaut), la certification n'est pas contrôlée.
      const noLimit = await get(base, tokenPath([torrent(HASH_A)], debridConfig(), { ageFr: 18 }));
      expect(noLimit.status).toBe(302);
    });
    expect(calls).toEqual([HASH_A, HASH_A, HASH_A]);
  });
});

describe('copies hébergeur (kind hoster) : débridage via AllDebrid', () => {
  it('débride le lien par /v4/link/unlock et renvoie 302 vers le lien débridé, sans appel magnet', async () => {
    const { factory, calls, unlocks } = fakeDebrid({}, { unlock: { [HOSTER_URL]: { link: HOSTER_LINK } } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([hoster(HOSTER_URL)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(HOSTER_LINK);
    });
    expect(unlocks).toEqual([HOSTER_URL]);
    expect(calls).toEqual([]);
  });

  it('une URL sans kind hoster reste un lien direct : 302 sans débridage', async () => {
    const { factory, unlocks } = fakeDebrid({});
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([{ url: HOSTER_URL }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(HOSTER_URL);
    });
    expect(unlocks).toEqual([]);
  });

  it('sans debrid, la copie hébergeur est écartée : jamais de redirection vers le lien brut', async () => {
    const { factory, unlocks } = fakeDebrid({});
    const noDebrid = encodeConfig({}, SECRET);
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([hoster(HOSTER_URL)], noDebrid), 'application/json');
      expect(res.status).toBe(404);
      expect(JSON.parse(await res.text())).toMatchObject({ reason: 'no_copy' });
      expect(res.headers.get('location')).toBeNull();
    });
    expect(unlocks).toEqual([]);
  });

  it('un débridage en erreur (LINK_DOWN) passe à la copie suivante', async () => {
    const { factory, unlocks } = fakeDebrid({}, { unlock: { [HOSTER_URL]: { code: 'LINK_DOWN' } } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([hoster(HOSTER_URL), { url: DIRECT }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
    expect(unlocks).toEqual([HOSTER_URL]);
  });
});

describe('torrents privés (privateTorrent + guid) : octets relus dans le cache', () => {
  it('les octets du cache partent à resolveTorrentFile (pas le magnet), avec l index demandé : 302', async () => {
    const { factory, calls, torrentFiles } = fakeDebrid({}, { torrentFile: { [HASH_A]: { link: LINK_A } } });
    const state = freshState();
    state.torrentCache.set(GUID, { kind: 'torrent', infoHash: HASH_A, files: [], private: true, bytes: PRIVATE_BYTES });
    await withServer(depsWith(factory), state, async (base) => {
      const res = await get(base, tokenPath([privateCopy(HASH_A)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(LINK_A);
    });
    expect(calls).toEqual([]);
    expect(torrentFiles).toEqual([{ infoHash: HASH_A, fileIdx: 1, bytes: PRIVATE_BYTES }]);
  });

  it('octets absents du cache : la copie est « no_copy » et la copie suivante est essayée', async () => {
    const { factory, calls, torrentFiles } = fakeDebrid({ [HASH_B]: { link: LINK_B } });
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([privateCopy(HASH_A), torrent(HASH_B)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(LINK_B);
    });
    expect(torrentFiles).toEqual([]);
    expect(calls).toEqual([HASH_B]);
  });

  it('cache manquant sans autre copie : 404 « Aucune copie disponible » (no_copy), aucun appel au debrid', async () => {
    const { factory, calls, torrentFiles } = fakeDebrid({});
    await withServer(depsWith(factory), freshState(), async (base) => {
      const res = await get(base, tokenPath([privateCopy(HASH_A)]), 'application/json');
      expect(res.status).toBe(404);
      expect(JSON.parse(await res.text())).toMatchObject({ reason: 'no_copy' });
    });
    expect(calls).toEqual([]);
    expect(torrentFiles).toEqual([]);
  });

  it('entrée du cache d un autre hash, ou sans octets (torrent public) : traitée comme absente', async () => {
    const { factory, torrentFiles } = fakeDebrid({});
    const state = freshState();
    state.torrentCache.set(GUID, { kind: 'torrent', infoHash: HASH_B, files: [], private: true, bytes: PRIVATE_BYTES });
    await withServer(depsWith(factory), state, async (base) => {
      const wrongHash = await get(base, tokenPath([privateCopy(HASH_A)]), 'application/json');
      expect(wrongHash.status).toBe(404);
      expect(JSON.parse(await wrongHash.text())).toMatchObject({ reason: 'no_copy' });
    });
    const publicState = freshState();
    publicState.torrentCache.set(GUID, { kind: 'torrent', infoHash: HASH_A, files: [], private: false });
    await withServer(depsWith(factory), publicState, async (base) => {
      const publicRes = await get(base, tokenPath([privateCopy(HASH_A)]), 'application/json');
      expect(JSON.parse(await publicRes.text())).toMatchObject({ reason: 'no_copy' });
    });
    expect(torrentFiles).toEqual([]);
  });

  it('une erreur AllDebrid sur resolveTorrentFile suit le même chemin que resolve (LINK_DOWN : copie suivante)', async () => {
    const { factory, torrentFiles } = fakeDebrid({}, { torrentFile: { [HASH_A]: { code: 'LINK_DOWN' } } });
    const state = freshState();
    state.torrentCache.set(GUID, { kind: 'torrent', infoHash: HASH_A, files: [], private: true, bytes: PRIVATE_BYTES });
    await withServer(depsWith(factory), state, async (base) => {
      const res = await get(base, tokenPath([privateCopy(HASH_A), { url: DIRECT }]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
    expect(torrentFiles).toHaveLength(1);
  });
});

describe('host_unavailable : seul l hôte réel du lien est marqué', () => {
  it('une copie torrent en host_unavailable ne marque pas alldebrid et n empêche pas les torrents suivants', async () => {
    const { factory, calls } = fakeDebrid({ [HASH_A]: { code: 'LINK_HOST_UNAVAILABLE' }, [HASH_B]: { link: LINK_B } });
    const state = freshState();
    await withServer(depsWith(factory), state, async (base) => {
      const first = await get(base, tokenPath([torrent(HASH_A), torrent(HASH_B)]));
      expect(first.status).toBe(302);
      expect(first.headers.get('location')).toBe(LINK_B);
      expect(state.hostHealth.isDown('alldebrid')).toBe(false);

      const second = await get(base, tokenPath([torrent(HASH_B)]));
      expect(second.status).toBe(302);
    });
    expect(calls).toEqual([HASH_A, HASH_B, HASH_B]);
  });

  it('une copie hébergeur en host_unavailable marque son hôte pour 1 h : ses autres liens sont sautés, un lien direct reste utilisable', async () => {
    const { factory, unlocks } = fakeDebrid({}, { unlock: { [HOSTER_URL]: { code: 'LINK_HOST_UNAVAILABLE' }, [HOSTER_OTHER]: { link: HOSTER_LINK } } });
    const state = freshState();
    await withServer(depsWith(factory), state, async (base) => {
      const first = await get(base, tokenPath([hoster(HOSTER_URL), { url: DIRECT }]));
      expect(first.status).toBe(302);
      expect(first.headers.get('location')).toBe(DIRECT);
      expect(state.hostHealth.isDown('1fichier.example')).toBe(true);
      expect(state.hostHealth.isDown('alldebrid')).toBe(false);

      const second = await get(base, tokenPath([hoster(HOSTER_OTHER), { url: DIRECT }]));
      expect(second.status).toBe(302);
      expect(second.headers.get('location')).toBe(DIRECT);

      const onlyHoster = await get(base, tokenPath([hoster(HOSTER_OTHER)]), 'application/json');
      expect(onlyHoster.status).toBe(503);
      const body = await onlyHoster.text();
      expect(JSON.parse(body)).toMatchObject({ reason: 'host_unavailable' });
      expect(body).not.toContain(HOSTER_OTHER);
      expect(body).not.toContain(API_KEY);
    });
    // Le lien de l'hôte en panne n'est débridé qu'une fois ; le second hébergeur est sauté sans appel.
    expect(unlocks).toEqual([HOSTER_URL]);
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
