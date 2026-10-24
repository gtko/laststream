import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const ARM = 'https://arm.haglund.dev/api/v2/imdb';
const JIKAN = 'https://api.jikan.moe/v4/anime';

type Handlers = Record<string, Handler>;

/** Série TMDB plate de deux saisons de deux épisodes, avec son identifiant IMDb. */
const series = (id: number, imdb: string): Handlers => ({
  [`${TMDB}/tv/${id}`]: () =>
    json({
      id,
      number_of_seasons: 2,
      seasons: [
        { season_number: 1, name: 'Saison 1', episode_count: 2, air_date: '2020-01-01', poster_path: null },
        { season_number: 2, name: 'Saison 2', episode_count: 2, air_date: '2021-01-01', poster_path: null },
      ],
      external_ids: { tvdb_id: null, imdb_id: imdb },
      episode_groups: { results: [] },
    }),
  ...Object.fromEntries(
    [1, 2].map((season) => [
      `${TMDB}/tv/${id}/season/${season}`,
      () =>
        json({
          season_number: season,
          episodes: [1, 2].map((episode) => ({
            season_number: season,
            episode_number: episode,
            name: `S${season}E${episode}`,
            overview: '',
            air_date: '2020-01-01',
            runtime: 24,
            still_path: null,
          })),
        }),
    ]),
  ),
});

/** Fixtures : anime découpé par saison TMDB, anime long (fiche MAL unique), série non anime, panne Jikan. */
const BY_SEASON = 'tt2000001';
const LONG = 'tt2000002';
const LIVE = 'tt2000003';
const BROKEN = 'tt2000004';

/** Page Jikan : épisodes `[numéro, filler, recap]`. */
const jikanPage = (episodes: [number, boolean, boolean][], hasNext: boolean): Response =>
  json({
    pagination: { last_visible_page: 2, has_next_page: hasNext },
    data: episodes.map(([mal_id, filler, recap]) => ({ mal_id, title: `Ep ${mal_id}`, filler, recap })),
  });

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    ...series(3001, BY_SEASON),
    ...series(3002, LONG),
    ...series(3003, LIVE),
    ...series(3004, BROKEN),
    [ARM]: (call) => {
      switch (call.url.searchParams.get('id')) {
        case BY_SEASON:
          return json([
            { myanimelist: 501, anilist: 1, 'themoviedb-season': 1 },
            { myanimelist: 502, anilist: 2, 'themoviedb-season': 2 },
          ]);
        case LONG:
          return json([{ myanimelist: 600, anilist: 3 }]);
        case BROKEN:
          return json([{ myanimelist: 700, anilist: 4 }]);
        default:
          return json([]);
      }
    },
    [`${JIKAN}/501/episodes`]: () => jikanPage([[1, false, false], [2, true, false]], false),
    // Un épisode à la fois filler et récap compte comme récap.
    [`${JIKAN}/502/episodes`]: () => jikanPage([[1, true, true], [2, false, false]], false),
    [`${JIKAN}/600/episodes`]: (call) =>
      call.url.searchParams.get('page') === '2'
        ? jikanPage([[3, true, false], [4, false, false]], false)
        : jikanPage([[1, false, false], [2, true, false]], true),
    [`${JIKAN}/700/episodes`]: () => json({ status: 500 }, 500),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const get = async (id: number): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/lt/series/${id}/fillers`);
  return { status: res.status, body: await res.json() };
};

describe('lt/series/fillers', () => {
  it('anime par saison TMDB : une fiche MAL par saison, numéro d’épisode TMDB', async () => {
    expect(await get(3001)).toEqual({
      status: 200,
      body: {
        fillers: [
          { season: 1, episode: 2, kind: 'filler' },
          { season: 2, episode: 1, kind: 'recap' },
        ],
      },
    });
  });

  it('anime long : fiche MAL unique, numéro absolu, pages Jikan lues à la suite et mises en cache', async () => {
    expect(await get(3002)).toEqual({
      status: 200,
      body: {
        fillers: [
          { season: 1, episode: 2, kind: 'filler' },
          { season: 2, episode: 1, kind: 'filler' },
        ],
      },
    });
    expect(upstream.callsTo(`${JIKAN}/600/episodes`).map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    await get(3002);
    expect(upstream.callsTo(`${JIKAN}/600/episodes`)).toHaveLength(2);
  });

  it('série non anime : liste vide, sans appel Jikan', async () => {
    const before = upstream.calls.filter((c) => c.url.origin === 'https://api.jikan.moe').length;
    expect(await get(3003)).toEqual({ status: 200, body: { fillers: [] } });
    expect(upstream.calls.filter((c) => c.url.origin === 'https://api.jikan.moe')).toHaveLength(before);
  });

  it('panne Jikan : liste vide, pas d’erreur', async () => {
    expect(await get(3004)).toEqual({ status: 200, body: { fillers: [] } });
  });

  it('identifiant TMDB invalide : 404', async () => {
    expect((await get(0)).status).toBe(404);
  });
});
