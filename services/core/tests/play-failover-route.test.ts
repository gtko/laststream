import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { encodeConfig } from '../src/config/codec.js';
import type { AppDeps } from '../src/deps.js';
import { newApp } from '../src/http/app-env.js';
import { HostHealth } from '../src/play/hosts.js';
import { PackStore } from '../src/play/packs.js';
import type { PlayState } from '../src/play/state.js';
import { type EncodeCopiesOptions, type PlayCopy, encodeCopiesToken } from '../src/play/token.js';
import { registerPlayRoutes } from '../src/routes/play.js';
import { TorrentCache } from '../src/torrent/fetch-torrent.js';
import { serveApp } from './serve.js';

// Lecture directe uniquement : le serveur ne débride jamais. Les copies torrent et hébergeur ne sont pas jouées ici.

const SECRET = 'play-failover-route-secret';
const HASH_A = 'a'.repeat(40);
const DIRECT = 'https://direct.example.org/film.mkv';
const DIRECT_OTHER = 'https://direct.example.org/autre.mkv';
const FUTURE = '2999-01-01';
const PAST = '2000-01-01';

/** État neuf par test : aucune marque d'hébergeur ni de pack ne fuit d'un test à l'autre. */
const freshState = (): PlayState => ({
  packStore: new PackStore(),
  hostHealth: new HostHealth(),
  torrentCache: new TorrentCache(),
});

const depsWith = (): AppDeps => ({ secret: SECRET, allowPlain: false });

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

const configToken = (input: Record<string, unknown> = {}): string => encodeConfig(input, SECRET);

/** Chemin de lecture pour une liste ordonnée de copies, avec des champs de jeton optionnels (date, âge, saison). */
const tokenPath = (copies: PlayCopy[], config: string = configToken(), extra: Omit<EncodeCopiesOptions, 'secret'> = {}): string =>
  `/${config}/play/c/${encodeCopiesToken(copies, { secret: SECRET, ...extra })}`;

const torrent = (infoHash: string): PlayCopy => ({ infoHash, fileIdx: 0 });
const direct = (url: string): PlayCopy => ({ url, filename: 'film.mkv' });

describe('GET /:config/play/c/:token (failover direct)', () => {
  it('copie directe : 302 vers le lien, Cache-Control no-store', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct(DIRECT)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  it('copie au schéma non http(s) écartée : la copie directe suivante est renvoyée', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct('ftp://direct.example.org/bad.mkv'), direct(DIRECT_OTHER)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT_OTHER);
    });
  });

  it('copie au schéma non http(s) seule : jamais de Location', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct('ftp://direct.example.org/bad.mkv')]));
      expect(res.headers.get('location')).toBeNull();
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  it('toutes les copies échouent : JSON si Accept le demande', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct('ftp://direct.example.org/bad.mkv')]), 'application/json');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  it('copie torrent seule : aucune copie jouable, 404 « Aucune copie disponible » (no_copy)', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A)]));
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  it('sans debrid, la copie torrent est écartée et la copie directe reste utilisable', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([torrent(HASH_A), direct(DIRECT)]));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
  });

  it('jeton altéré : 400 invalid_token, sans lecture', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const token = tokenPath([direct(DIRECT)]);
      const res = await get(base, `${token}x`);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_token' });
    });
  });

  it('configuration illisible : 400 invalid_config', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const path = tokenPath([direct(DIRECT)], 'configuration-illisible');
      const res = await get(base, path);
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_config' });
    });
  });
});

describe('GET /:config/play/c/:token : contrôles avant toute résolution', () => {
  it('date de sortie future : 404 « Épisode non sorti », même pour une copie directe', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct(DIRECT)], configToken(), { releasedAt: FUTURE }));
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  it('date de sortie passée : la lecture suit son cours', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const res = await get(base, tokenPath([direct(DIRECT)], configToken(), { releasedAt: PAST }));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(DIRECT);
    });
  });

  it('limite d’âge : 403 si la certification dépasse ageLimit', async () => {
    await withServer(depsWith(), freshState(), async (base) => {
      const config = configToken({ filters: { ageLimit: 12 } });
      const res = await get(base, tokenPath([direct(DIRECT)], config, { ageFr: 16 }));
      expect(res.status).toBe(403);
    });
  });
});
