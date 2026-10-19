import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

interface WatchedTitlesBody {
  items: { type: string; tmdbId: number | null; imdbId: string | null; watched: number; lastWatchedAt: string }[];
}

let app: RunningApp;
let token: string;
let profile: string;

beforeEach(async () => {
  app = await startApp({});
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  profile = (await createProfileVia(app, token, { name: 'Greg' })).body.id;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Date de l'écriture suivante (horloge figée sur `iso`). */
const at = (iso: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(iso));
};

const base = (id: string = profile): string => `/user/profiles/${id}`;

async function putWatched(body: Record<string, unknown>, id: string = profile) {
  return request<ErrorBody | undefined>(app, 'PUT', `${base(id)}/watched`, { token, body });
}

async function putProgress(body: Record<string, unknown>) {
  return request(app, 'PUT', `${base()}/progress`, { token, body });
}

async function history(id: string = profile) {
  return request<WatchedTitlesBody>(app, 'GET', `${base(id)}/watched`, { token });
}

/** Épisodes `from` à `to` de la saison `season`, au format attendu par l'API. */
const episodes = (season: number, from: number, to: number): { season: number; episode: number }[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ season, episode: from + index }));

describe('vu : historique du profil (liste)', () => {
  it('liste films et séries vus, les plus récents d’abord, sans lecture en cours', async () => {
    at('2026-01-01T10:00:00.000Z');
    await putWatched({ type: 'movie', tmdbId: 603, watched: true });
    at('2026-01-02T10:00:00.000Z');
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 3), watched: true });
    at('2026-01-03T10:00:00.000Z');
    await putProgress({ type: 'series', tmdbId: 1399, season: 1, episode: 1, positionSec: 300, durationSec: 1000 });

    const res = await history();
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { type: 'series', tmdbId: 1396, imdbId: null, watched: 3, lastWatchedAt: '2026-01-02T10:00:00.000Z' },
      { type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' },
    ]);
  });

  it('une série partiellement vue compte les épisodes vus (pas le total)', async () => {
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 4), watched: true });
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 2, 2), watched: false });
    const res = await history();
    expect(res.body.items).toEqual([expect.objectContaining({ tmdbId: 1396, watched: 3 })]);
  });

  it('un film démarqué disparaît de l’historique ; une série vidée aussi', async () => {
    await putWatched({ type: 'movie', tmdbId: 603, watched: true });
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 2), watched: true });
    expect((await history()).body.items).toHaveLength(2);

    await putWatched({ type: 'movie', tmdbId: 603, watched: false });
    await putWatched({ type: 'series', tmdbId: 1396, episodes: episodes(1, 1, 2), watched: false });
    expect((await history()).body.items).toEqual([]);
  });

  it('un film terminé en lecture (progression finie) figure dans l’historique', async () => {
    at('2026-02-01T20:00:00.000Z');
    await putProgress({ type: 'movie', tmdbId: 550, positionSec: 990, durationSec: 1000 });
    const res = await history();
    expect(res.body.items).toEqual([{ type: 'movie', tmdbId: 550, imdbId: null, watched: 1, lastWatchedAt: '2026-02-01T20:00:00.000Z' }]);
  });

  it('les spéciaux (saison 0) seuls ne font pas entrer une série dans l’historique', async () => {
    await putWatched({ type: 'series', tmdbId: 1396, episodes: [{ season: 0, episode: 1 }], watched: true });
    expect((await history()).body.items).toEqual([]);
  });

  it('l’historique est propre à chaque profil', async () => {
    await putWatched({ type: 'movie', tmdbId: 603, watched: true });
    const other = (await createProfileVia(app, token, { name: 'Autre' })).body.id;
    expect((await history(other)).body.items).toEqual([]);
    expect((await history()).body.items).toHaveLength(1);
  });

  it('profil inconnu : refusé', async () => {
    const res = await request<ErrorBody>(app, 'GET', `${base('inconnu')}/watched`, { token });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
