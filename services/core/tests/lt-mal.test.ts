import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeriesEpisode, type SeriesEpisodes, withMalNumbering } from '../src/lt/episodes.js';
import { jikanTiming } from '../src/lt/filler.js';
import { FRIBB_LIST_URL, malNumbers, parseMalIndex } from '../src/lt/mal.js';
import { fakeLookup, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

/** Entrées Fribb : anime en plusieurs cours (saison 3 partagée entre deux fiches), OVA, film, série longue, hors anime. */
const FRIBB = [
  { type: 'TV', mal_id: 16498, kitsu_id: 7442, themoviedb_id: { tv: 1429 }, season: { tvdb: 1, tmdb: 1 } },
  { type: 'OVA', mal_id: 18397, themoviedb_id: { tv: 1429 }, season: { tvdb: 0, tmdb: 0 } },
  { type: 'MOVIE', mal_id: 36702, themoviedb_id: { tv: 1429 }, season: { tvdb: 0, tmdb: 0 } },
  { type: 'TV', mal_id: 25777, themoviedb_id: { tv: 1429 }, season: { tvdb: 2, tmdb: 2 } },
  { type: 'TV', mal_id: 35760, themoviedb_id: { tv: 1429 }, season: { tvdb: 3, tmdb: 3 } },
  { type: 'TV', mal_id: 38524, themoviedb_id: { tv: 1429 }, season: { tvdb: 3, tmdb: 3 }, episode_offset: { tvdb: 2, tmdb: 2 } },
  { type: 'TV', mal_id: 21, kitsu_id: 12, themoviedb_id: { tv: 37854 }, season: null },
  { type: 'TV', mal_id: null, themoviedb_id: { tv: 999 }, season: { tvdb: 1, tmdb: 1 } },
  { type: 'TV', mal_id: 77, themoviedb_id: { movie: 5 } },
];

/** Structure plate : `counts[i]` épisodes dans la saison i + 1, identifiants de flux `tt1:S:E`. */
function structure(counts: number[], source: SeriesEpisodes['source'] = 'tmdb', specials = 0): SeriesEpisodes {
  let absolute = 0;
  const episode = (season: number, n: number): SeriesEpisode => ({
    season,
    episode: n,
    absolute: season === 0 ? null : ++absolute,
    name: `S${season}E${n}`,
    overview: null,
    airDate: null,
    runtime: 24,
    still: null,
    tmdbSeason: season,
    tmdbEpisode: n,
    streamId: `tt1:${season}:${n}`,
  });
  const episodes = counts.flatMap((count, i) => Array.from({ length: count }, (_, k) => episode(i + 1, k + 1)));
  const extra = Array.from({ length: specials }, (_, k) => episode(0, k + 1));
  const seasons: SeriesEpisodes['seasons'] = counts.map((count, i) => ({ number: i + 1, name: `Saison ${i + 1}`, episodeCount: count, airDate: null, poster: `/p${i + 1}.jpg` }));
  if (specials > 0) seasons.push({ number: 0, name: 'Spéciaux', episodeCount: specials, airDate: null, poster: null });
  return { source, seasons, episodes: [...episodes, ...extra] };
}

const coords = (body: SeriesEpisodes): string[] => body.episodes.map((e) => `${e.season}:${e.episode}=${e.streamId}${e.mal === undefined ? '' : `@${e.mal}:${e.malEpisode}`}`);

describe('index des fiches MAL (liste Fribb)', () => {
  const index = parseMalIndex(FRIBB);

  it('garde les fiches MAL de séries TMDB, sans film, spécial ni entrée sans identifiant', () => {
    expect(Object.keys(index).sort()).toEqual(['1429', '37854']);
    expect(index['1429']?.map((e) => e.mal)).toEqual([16498, 25777, 35760, 38524]);
    expect(index['1429']?.[0]).toEqual({ mal: 16498, kitsu: 7442, tvdb: { season: 1, offset: 0 }, tmdb: { season: 1, offset: 0 } });
    expect(index['1429']?.[3]).toMatchObject({ mal: 38524, tmdb: { season: 3, offset: 2 } });
    // Série longue : pas de saison, numérotation continue.
    expect(index['37854']).toEqual([{ mal: 21, kitsu: 12, tvdb: { offset: 0 }, tmdb: { offset: 0 } }]);
  });

  it('refuse une liste qui n’est pas un tableau', () => {
    expect(() => parseMalIndex({})).toThrow();
  });

  it('numéros MAL : décalage dans la saison, fiche sans saison sur le rang absolu', () => {
    const entries = index['1429'] ?? [];
    const numbers = malNumbers(entries, 'tmdb', [
      { season: 3, episode: 2, absolute: 10 },
      { season: 3, episode: 3, absolute: 11 },
      { season: 4, episode: 1, absolute: 20 },
      { season: null, episode: null, absolute: 30 },
    ]);
    expect(numbers).toEqual([{ mal: 35760, episode: 2 }, { mal: 38524, episode: 1 }, undefined, undefined]);
    expect(malNumbers(index['37854'] ?? [], 'tvdb', [{ season: 21, episode: 5, absolute: 900 }])).toEqual([{ mal: 21, kitsu: 12, episode: 900 }]);
  });
});

describe('numérotation MAL d’une structure', () => {
  const index = parseMalIndex(FRIBB);

  it('une saison par fiche MAL, saison partagée coupée en deux, identifiants de flux inchangés', () => {
    const body = withMalNumbering(structure([2, 2, 4], 'tmdb', 1), index['1429'] ?? []);
    expect(body.numbering).toBe('mal');
    expect(coords(body)).toEqual([
      '1:1=tt1:1:1@16498:1',
      '1:2=tt1:1:2@16498:2',
      '2:1=tt1:2:1@25777:1',
      '2:2=tt1:2:2@25777:2',
      '3:1=tt1:3:1@35760:1',
      '3:2=tt1:3:2@35760:2',
      '4:1=tt1:3:3@38524:1',
      '4:2=tt1:3:4@38524:2',
      '0:1=tt1:0:1',
    ]);
    expect(body.seasons.map((s) => [s.number, s.name, s.episodeCount, s.poster])).toEqual([
      [1, 'Saison 1', 2, '/p1.jpg'],
      [2, 'Saison 2', 2, '/p2.jpg'],
      [3, 'Saison 3', 2, '/p3.jpg'],
      [4, 'Saison 4', 2, '/p3.jpg'],
      [0, 'Spéciaux', 1, null],
    ]);
    expect(body.episodes[0]).toMatchObject({ kitsu: 7442, absolute: 1 });
  });

  it('saison sans fiche MAL : gardée à sa place, avec ses numéros', () => {
    const body = withMalNumbering(structure([2, 2, 4, 3]), index['1429'] ?? []);
    expect(coords(body).slice(-3)).toEqual(['5:1=tt1:4:1', '5:2=tt1:4:2', '5:3=tt1:4:3']);
    expect(body.seasons.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('série longue : une seule saison, numéros continus', () => {
    const body = withMalNumbering(structure([3, 2], 'tvdb'), index['37854'] ?? []);
    expect(coords(body)).toEqual(['1:1=tt1:1:1@21:1', '1:2=tt1:1:2@21:2', '1:3=tt1:1:3@21:3', '1:4=tt1:2:1@21:4', '1:5=tt1:2:2@21:5']);
    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0]).toMatchObject({ number: 1, episodeCount: 5 });
  });

  it('série hors anime ou fiches inapplicables : structure inchangée', () => {
    const plain = structure([2, 2]);
    expect(withMalNumbering(plain, [])).toBe(plain);
    expect(withMalNumbering(plain, [{ mal: 5, tmdb: { season: 9, offset: 0 } }])).toBe(plain);
  });
});

describe('routes : anime renuméroté d’après MAL', () => {
  const TMDB = 'https://api.themoviedb.org/3';
  const JIKAN = 'https://api.jikan.moe/v4/anime';
  let upstream: MockUpstream;
  let app: RunningApp;

  beforeAll(async () => {
    upstream = mockUpstream({
      [FRIBB_LIST_URL]: () =>
        json([
          { type: 'TV', mal_id: 901, kitsu_id: 91, themoviedb_id: { tv: 4001 }, season: { tvdb: 1, tmdb: 1 } },
          { type: 'TV', mal_id: 902, themoviedb_id: { tv: 4001 }, season: { tvdb: 1, tmdb: 1 }, episode_offset: { tmdb: 2 } },
        ]),
      [`${TMDB}/tv/4001`]: () =>
        json({
          id: 4001,
          number_of_seasons: 1,
          seasons: [{ season_number: 1, name: 'Saison 1', episode_count: 4, air_date: '2020-01-01', poster_path: null }],
          external_ids: { tvdb_id: null, imdb_id: 'tt4000001' },
          episode_groups: { results: [] },
        }),
      [`${TMDB}/tv/4001/season/1`]: () =>
        json({
          season_number: 1,
          episodes: [1, 2, 3, 4].map((n) => ({ season_number: 1, episode_number: n, name: `E${n}`, overview: '', air_date: '2020-01-01', runtime: 24, still_path: null })),
        }),
      [`${JIKAN}/901/episodes`]: () => json({ pagination: { has_next_page: false }, data: [{ mal_id: 2, filler: true, recap: false }] }),
      // Deuxième cours : son épisode 1 (épisode 3 de la saison TMDB) est un récap.
      [`${JIKAN}/902/episodes`]: () => json({ pagination: { has_next_page: false }, data: [{ mal_id: 1, filler: false, recap: true }] }),
    });
    Object.assign(jikanTiming, { pageGapMs: 0, retryDefaultMs: 5, retryMaxMs: 5 });
    app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
  });

  afterAll(async () => {
    await app.close();
  });

  interface Body {
    numbering?: string;
    seasons: { number: number; episodeCount: number }[];
    episodes: { season: number; episode: number; streamId?: string; mal?: number; malEpisode?: number; kitsu?: number }[];
    fillers: unknown;
  }
  const get = async (path: string): Promise<Body> =>
    (await (await fetch(`${app.baseUrl}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/lt/${path}`)).json()) as Body;

  it('épisodes : deux saisons MAL, identifiants de flux IMDb d’origine, fiches MAL et Kitsu', async () => {
    const body = await get('series/4001/episodes');
    expect(body.numbering).toBe('mal');
    expect(body.seasons.map((s) => [s.number, s.episodeCount])).toEqual([[1, 2], [2, 2]]);
    expect(body.episodes.map((e) => [e.season, e.episode, e.streamId, e.mal, e.malEpisode, e.kitsu])).toEqual([
      [1, 1, 'tt4000001:1:1', 901, 1, 91],
      [1, 2, 'tt4000001:1:2', 901, 2, 91],
      [2, 1, 'tt4000001:1:3', 902, 1, undefined],
      [2, 2, 'tt4000001:1:4', 902, 2, undefined],
    ]);
  });

  it('fillers : lus par fiche MAL, y compris pour une saison en deux cours', async () => {
    expect(await get('series/4001/fillers')).toEqual({
      fillers: [
        { season: 1, episode: 2, kind: 'filler' },
        { season: 2, episode: 1, kind: 'recap' },
      ],
    });
  });
});
