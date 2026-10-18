import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

const STREMIO = 'https://api.strem.io/api';
const TMDB = 'https://api.themoviedb.org/3';
const STREMIO_EMAIL = 'greg@example.test';
const STREMIO_PASSWORD = 'mdp-stremio-test-42';
const AUTH_KEY = 'authkey-stremio-test-xyz';

/** Bibliothèque Stremio simulée : un film, une série terminée, un film sans progression, et trois entrées ignorées ou partielles. */
const LIBRARY = [
  {
    _id: 'tt0133093',
    type: 'movie',
    name: 'The Matrix',
    poster: 'https://img.example/matrix.jpg',
    removed: false,
    _ctime: '2024-01-02T00:00:00.000Z',
    _mtime: '2024-03-01T10:00:00.000Z',
    state: { timeOffset: 3_000_000, duration: 8_000_000, lastWatched: '2024-03-01T10:00:00.000Z', video_id: 'tt0133093' },
  },
  {
    _id: 'tt0944947',
    type: 'series',
    name: 'Game of Thrones',
    poster: null,
    removed: false,
    _ctime: '2024-01-03T00:00:00.000Z',
    state: { timeOffset: 3_000_000, duration: 3_000_000, lastWatched: '2024-03-02T10:00:00.000Z', video_id: 'tt0944947:2:5' },
  },
  { _id: 'tt7654321', type: 'movie', name: 'Film inconnu', removed: false, state: { timeOffset: 0, duration: 0, video_id: 'tt7654321' } },
  { _id: 'tt9999999', type: 'movie', name: 'Supprimé', removed: true },
  { _id: 'tt1111111', type: 'anime', name: 'Anime', removed: false },
  {
    _id: 'tt0903747',
    type: 'series',
    name: 'Breaking Bad',
    removed: false,
    state: { timeOffset: 1000, duration: 2000, lastWatched: '2024-03-03T10:00:00.000Z', video_id: 'tt0000001:1:1' },
  },
];

function stremioUpstream(): MockUpstream {
  return mockUpstream({
    [`${STREMIO}/login`]: (call) => {
      const body = JSON.parse(call.body) as { email: string; password: string };
      if (body.email === STREMIO_EMAIL && body.password === STREMIO_PASSWORD) {
        return json({ result: { authKey: AUTH_KEY, user: { _id: 'u1' } } });
      }
      return json({ error: { code: 1, message: 'Wrong email or password' } });
    },
    [`${STREMIO}/datastoreGet`]: (call) => {
      const body = JSON.parse(call.body) as { authKey: string; collection: string };
      if (body.authKey !== AUTH_KEY || body.collection !== 'libraryItem') return json({ error: { code: 2 } });
      return json({ result: LIBRARY });
    },
    [`${TMDB}/find/tt0133093`]: (call) => {
      if (call.headers.authorization !== `Bearer ${KEYS.tmdbToken}`) return json({}, 401);
      return json({ movie_results: [{ id: 603 }], tv_results: [] });
    },
    [`${TMDB}/find/tt0944947`]: () => json({ movie_results: [], tv_results: [{ id: 1396 }] }),
    [`${TMDB}/find/tt0903747`]: () => json({ movie_results: [], tv_results: [{ id: 1399 }] }),
  });
}

let dir: string;
let file: string;
let upstream: MockUpstream;
let app: RunningApp;
let token: string;
let profile: string;

async function start(fetchImpl: typeof fetch): Promise<void> {
  app = await startApp({ fetch: fetchImpl, lookupHost: fakeLookup(), userDbPath: file });
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  profile = (await createProfileVia(app, token, { name: 'Greg' })).body.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lastaddon-stremio-'));
  file = join(dir, 'laststream.db');
  upstream = stremioUpstream();
  await start(upstream.fetch);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Peut déjà être fermée par le test (base relue ensuite) : la seconde fermeture est sans effet.
  await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

interface ImportBody {
  library: number;
  progress: number;
  skipped: number;
  tmdbResolved: number;
}

const importBody = (extra: Record<string, unknown> = {}) => ({
  email: STREMIO_EMAIL,
  password: STREMIO_PASSWORD,
  ...extra,
});

function importStremio(body: Record<string, unknown>) {
  return request<ImportBody | ErrorBody>(app, 'POST', `/user/profiles/${profile}/import/stremio`, { token, body });
}

describe('import Stremio', () => {
  it('importe bibliothèque et progression, résout les identifiants TMDB, et renvoie les compteurs', async () => {
    const res = await importStremio(importBody({ config: tokenFor({ tmdbToken: KEYS.tmdbToken }) }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ library: 4, progress: 2, skipped: 2, tmdbResolved: 3, truncated: false });

    const library = await request<{ items: { title: string; tmdbId: number | null; imdbId: string | null }[] }>(
      app,
      'GET',
      `/user/profiles/${profile}/library?sort=title`,
      { token },
    );
    expect(library.body.items.map((item) => [item.title, item.tmdbId, item.imdbId])).toEqual([
      ['Breaking Bad', 1399, 'tt0903747'],
      ['Film inconnu', null, 'tt7654321'],
      ['Game of Thrones', 1396, 'tt0944947'],
      ['The Matrix', 603, 'tt0133093'],
    ]);
  });

  it('progression importée : temps Stremio (ms) convertis en secondes, épisode lu depuis video_id', async () => {
    await importStremio(importBody({ config: tokenFor({ tmdbToken: KEYS.tmdbToken }) }));
    const movie = await request<{ items: { positionSec: number; durationSec: number; finished: boolean; updatedAt: string }[] }>(
      app,
      'GET',
      `/user/profiles/${profile}/progress/movie/603`,
      { token },
    );
    expect(movie.body.items).toEqual([
      expect.objectContaining({ positionSec: 3000, durationSec: 8000, finished: false, updatedAt: '2024-03-01T10:00:00.000Z' }),
    ]);
    const series = await request<{ items: { season: number; episode: number; finished: boolean }[] }>(
      app,
      'GET',
      `/user/profiles/${profile}/progress/series/1396`,
      { token },
    );
    expect(series.body.items).toEqual([expect.objectContaining({ season: 2, episode: 5, finished: true })]);
  });

  it('après import, « continuer à regarder » reprend le film et propose l épisode suivant de la série', async () => {
    await importStremio(importBody({ config: tokenFor({ tmdbToken: KEYS.tmdbToken }) }));
    const res = await request<{ items: { type: string; tmdbId: number | null; season: number | null; episode: number | null; suggested: boolean }[] }>(
      app,
      'GET',
      `/user/profiles/${profile}/continue`,
      { token },
    );
    expect(res.body.items).toEqual([
      expect.objectContaining({ type: 'series', tmdbId: 1396, season: 2, episode: 6, suggested: true }),
      expect.objectContaining({ type: 'movie', tmdbId: 603, season: null, suggested: false }),
    ]);
  });

  it('sans configuration TMDB : identifiants IMDb seuls, aucun appel TMDB', async () => {
    const res = await importStremio(importBody());
    expect(res.body).toEqual({ library: 4, progress: 2, skipped: 2, tmdbResolved: 0, truncated: false });
    expect(upstream.callsTo(`${TMDB}/find/tt0133093`)).toHaveLength(0);
    const library = await request<{ items: { tmdbId: number | null; imdbId: string | null }[] }>(app, 'GET', `/user/profiles/${profile}/library`, { token });
    expect(library.body.items.every((item) => item.tmdbId === null)).toBe(true);
  });

  it('une progression locale plus récente n est pas écrasée par l import', async () => {
    await request(app, 'PUT', `/user/profiles/${profile}/progress`, {
      token,
      body: { type: 'movie', tmdbId: 603, positionSec: 100, durationSec: 8000 },
    });
    await importStremio(importBody({ config: tokenFor({ tmdbToken: KEYS.tmdbToken }) }));
    const movie = await request<{ items: { positionSec: number }[] }>(app, 'GET', `/user/profiles/${profile}/progress/movie/603`, { token });
    expect(movie.body.items[0]?.positionSec).toBe(100);
  });

  it('identifiants refusés par Stremio : 422 stremio_login_failed, aucune donnée lue, aucun secret renvoyé', async () => {
    const res = await importStremio({ email: STREMIO_EMAIL, password: 'mauvais-mot-de-passe' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'stremio_login_failed' });
    expect(JSON.stringify(res.body)).not.toContain('mauvais-mot-de-passe');
    expect(upstream.callsTo(`${STREMIO}/datastoreGet`)).toHaveLength(0);
  });

  it('Stremio en erreur serveur : 502 stremio_unavailable', async () => {
    await app.close();
    const broken = mockUpstream({ [`${STREMIO}/login`]: () => json({ error: 'boom' }, 500) });
    await start(broken.fetch);
    const res = await importStremio(importBody());
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'stremio_unavailable' });
  });

  it('configuration illisible : 400 invalid_config, sans appel à Stremio', async () => {
    const res = await importStremio(importBody({ config: 'pas-une-configuration' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_config' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('bibliothèque plus grande que 5000 entrées : seules les 5000 premières sont importées, truncated = true', async () => {
    const huge = Array.from({ length: 5001 }, (_, index) => ({
      _id: `tt${String(1_000_000 + index)}`,
      type: 'movie',
      name: `Film ${index}`,
      state: {},
    }));
    const bigUpstream = mockUpstream({
      [`${STREMIO}/login`]: () => json({ result: { authKey: AUTH_KEY } }),
      [`${STREMIO}/datastoreGet`]: () => json({ result: huge }),
    });
    await app.close();
    await start(bigUpstream.fetch);
    const res = await importStremio(importBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ library: 5000, progress: 0, skipped: 1, tmdbResolved: 0, truncated: true });
  });

  it('identifiants Stremio jamais stockés ni journalisés', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      await importStremio(importBody({ config: tokenFor({ tmdbToken: KEYS.tmdbToken }) }));
      await importStremio({ email: STREMIO_EMAIL, password: 'mauvais-mot-de-passe' });
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(STREMIO_PASSWORD);
      expect(logged).not.toContain(AUTH_KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    await app.close();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      for (const { name } of tables) {
        const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
        expect(dump, name).not.toContain(STREMIO_PASSWORD);
        expect(dump, name).not.toContain(AUTH_KEY);
        expect(dump, name).not.toContain(STREMIO_EMAIL);
      }
    } finally {
      db.close();
    }
  });
});
