import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';
import { request } from './user-harness.js';

interface LibraryBody {
  items: { type: string; tmdbId: number | null; imdbId: string | null; title: string; poster: string | null; addedAt: string }[];
  total: number;
  limit: number;
  offset: number;
}
interface HistoryBody {
  items: {
    type: string;
    tmdbId: number;
    title?: string;
    poster?: string;
    season?: number;
    episode?: number;
    pos: number;
    duration?: number;
    watched: boolean;
    updatedAt: number;
  }[];
}

const NOW = '2026-05-01T10:00:00.000Z';
const T0 = Date.parse(NOW);

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  app = await startApp({});
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Titre de bibliothèque d’un profil d’alice (même compte que alice2 : foyer). */
const putTitle = (type: 'movie' | 'series', tmdbId: number, title: string) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/library/${type}/${tmdbId}`, { token: cast.alice.token, body: { title } });
const setVisibility = (type: 'movie' | 'series', tmdbId: number, visibility: 'private' | 'friends') =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/library/${type}/${tmdbId}/visibility`, {
    token: cast.alice.token,
    body: { visibility },
  });
const writeProgress = (body: Record<string, unknown>) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/progress`, { token: cast.alice.token, body });
const library = (who: Persona, pid: string, query = '') => as<LibraryBody & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/library${query}`);
const history = (who: Persona, pid: string, query = '') => as<HistoryBody & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/history${query}`);

describe('bibliothèque (GET /user/social/friends/:pid/library)', () => {
  beforeEach(async () => {
    await putTitle('movie', 603, 'Matrix');
    await putTitle('movie', 604, 'Matrix 2');
    await putTitle('series', 1399, 'Game of Thrones');
    await setVisibility('movie', 604, 'friends');
    await setVisibility('series', 1399, 'friends');
  }, HOOK_TIMEOUT_MS);

  it('un ami ne voit que les titres en visibilité « friends », dans la forme de l’ancienne route', async () => {
    const res = await library(cast.bob, cast.alice.pid);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.title).sort()).toEqual(['Game of Thrones', 'Matrix 2']);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(Object.keys(res.body.items[0] ?? {}).sort()).toEqual(['addedAt', 'imdbId', 'poster', 'title', 'tmdbId', 'type']);
    expect(JSON.stringify(res.body)).not.toContain(cast.alice.profile);
  });

  it('le foyer voit toute la bibliothèque, titres privés compris ; filtre par type et pagination', async () => {
    const household = await library(cast.alice2, cast.alice.pid);
    expect(household.body.total).toBe(3);
    expect(household.body.items.map((i) => i.title)).toContain('Matrix');
    const movies = await library(cast.alice2, cast.alice.pid, '?type=movie');
    expect(movies.body.total).toBe(2);
    expect(movies.body.items.every((i) => i.type === 'movie')).toBe(true);
    const page = await library(cast.alice2, cast.alice.pid, '?limit=1&offset=1');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(3);
    expect(page.body.offset).toBe(1);
    const friendSeries = await library(cast.bob, cast.alice.pid, '?type=series');
    expect(friendSeries.body.total).toBe(1);
  });

  it('un titre repassé en privé disparaît de la vue de l’ami', async () => {
    await setVisibility('movie', 604, 'private');
    const res = await library(cast.bob, cast.alice.pid);
    expect(res.body.items.map((i) => i.title)).toEqual(['Game of Thrones']);
  });

  it('sans lien d’amitié ni foyer : 404 friend_not_found, comme pour un pid inconnu ou mal formé', async () => {
    const stranger = await library(cast.carol, cast.alice.pid);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe('friend_not_found');
    const unknown = await library(cast.bob, 'AAAAAAAAAAAAAAAA');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('friend_not_found');
    expect((await library(cast.bob, 'pas-un-pid')).status).toBe(404);
  });

  it('un profil enfant n’est jamais partagé : son identifiant interne ne donne aucune bibliothèque', async () => {
    const res = await library(cast.bob, cast.kid.profile);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('friend_not_found');
  });

  it('paramètres de requête invalides refusés (400)', async () => {
    expect((await library(cast.bob, cast.alice.pid, '?type=livre')).body.error).toBe('invalid_body');
    expect((await library(cast.bob, cast.alice.pid, '?limit=0')).body.error).toBe('invalid_body');
    expect((await library(cast.bob, cast.alice.pid, '?limit=101')).body.error).toBe('invalid_body');
  });
});

describe('historique (GET /user/social/friends/:pid/history)', () => {
  beforeEach(async () => {
    await putTitle('movie', 603, 'Matrix');
    await putTitle('series', 1399, 'Game of Thrones');
    // Trois lectures, de la plus ancienne à la plus récente.
    await writeProgress({ type: 'series', tmdbId: 1399, season: 2, episode: 4, positionSec: 754, durationSec: 3600 });
    vi.setSystemTime(new Date(T0 + 3_600_000));
    await writeProgress({ type: 'movie', tmdbId: 603, positionSec: 7000, durationSec: 7200 });
    vi.setSystemTime(new Date(T0 + 7_200_000));
    await writeProgress({ type: 'movie', tmdbId: 550, positionSec: 100, durationSec: 7200 });
  }, HOOK_TIMEOUT_MS);

  it('un ami reçoit l’historique du plus récent au plus ancien, avec titre, saison et épisode, et l’état vu', async () => {
    const res = await history(cast.bob, cast.alice.pid);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.tmdbId)).toEqual([550, 603, 1399]);
    const [recent, movie, series] = res.body.items;
    expect(recent?.title).toBeUndefined();
    expect(recent?.watched).toBe(false);
    expect(recent?.season).toBeUndefined();
    expect(movie).toMatchObject({ type: 'movie', title: 'Matrix', watched: true, pos: 7000, duration: 7200 });
    expect(movie?.season).toBeUndefined();
    expect(movie?.updatedAt).toBe(T0 + 3_600_000);
    expect(series).toMatchObject({ type: 'series', title: 'Game of Thrones', season: 2, episode: 4, pos: 754, duration: 3600, watched: false });
    expect(series?.updatedAt).toBe(T0);
  });

  it('limite : 20 par défaut, 1 à 50 ; hors bornes refusé', async () => {
    expect((await history(cast.bob, cast.alice.pid, '?limit=1')).body.items.map((i) => i.tmdbId)).toEqual([550]);
    expect((await history(cast.bob, cast.alice.pid)).body.items).toHaveLength(3);
    expect((await history(cast.bob, cast.alice.pid, '?limit=0')).body.error).toBe('invalid_body');
    expect((await history(cast.bob, cast.alice.pid, '?limit=51')).body.error).toBe('invalid_body');
  });

  it('une progression sans identifiant TMDB n’apparaît pas ; le foyer a accès, un inconnu non', async () => {
    await writeProgress({ type: 'movie', imdbId: 'tt0111161', positionSec: 10, durationSec: 100 });
    expect((await history(cast.bob, cast.alice.pid)).body.items).toHaveLength(3);
    const household = await history(cast.alice2, cast.alice.pid);
    expect(household.status).toBe(200);
    expect(household.body.items).toHaveLength(3);
    const stranger = await history(cast.carol, cast.alice.pid);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error).toBe('friend_not_found');
    expect((await history(cast.bob, cast.kid.profile)).status).toBe(404);
  });
});
