import { afterEach, describe, expect, it } from 'vitest';
import { discoverParams, hasExcludedTvGenre, isLongRunner, movieAvailable, movieFresh, seriesAired, seriesFresh, shiftDays, sourcesOf, todayOf } from '../src/lt/top10.js';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

/** Top 10 de l'accueil (lt/top10.ts) : disponibilité et fraîcheur des films et séries, découverte régionale, remplissage sur plusieurs pages, route. */

const TMDB = 'https://api.themoviedb.org/3';
/** Dates fixes, loin du jour courant : les tests unitaires ne dépendent pas de l'horloge. */
const TODAY = '2026-10-19';
const PAST = '2020-02-01T00:00:00.000Z';
const FUTURE = '2099-07-17';

/**
 * Les tests de route lisent l'horloge (Date.now) : leurs dates « récentes » sont calculées à partir du jour réel.
 * Un film sorti il y a 30 jours est frais ; une série dont la première diffusion remonte à 200 jours l'est aussi.
 */
const NOW_DAY = todayOf(Date.now());
const RECENT = shiftDays(NOW_DAY, -30);
const RECENT_SERIES = shiftDays(NOW_DAY, -200);

let running: RunningApp | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('Top 10 : disponibilité des films', () => {
  const release = (iso_3166_1: string, dates: Array<{ type: number; release_date: string }>) => ({ iso_3166_1, release_dates: dates });

  it('sortie numérique (4) passée dans la région : disponible', () => {
    const detail = { release_dates: { results: [release('FR', [{ type: 4, release_date: PAST }])] } };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(true);
  });

  it('sortie physique (5) passée : disponible ; numérique future : non', () => {
    expect(movieAvailable({ release_dates: { results: [release('FR', [{ type: 5, release_date: PAST }])] } }, 'FR', TODAY)).toBe(true);
    expect(movieAvailable({ release_dates: { results: [release('FR', [{ type: 4, release_date: FUTURE }])] } }, 'FR', TODAY)).toBe(false);
  });

  it('seulement en salle (1 à 3), sans fournisseur : pas disponible', () => {
    const detail = { release_dates: { results: [release('FR', [{ type: 3, release_date: PAST }])] } };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(false);
  });

  it('abonnement, gratuit ou publicité dans la région : disponible, même sans date numérique', () => {
    expect(movieAvailable({ 'watch/providers': { results: { FR: { flatrate: [{ provider_name: 'X' }] } } } }, 'FR', TODAY)).toBe(true);
    expect(movieAvailable({ 'watch/providers': { results: { FR: { free: [{}] } } } }, 'FR', TODAY)).toBe(true);
    expect(movieAvailable({ 'watch/providers': { results: { FR: { ads: [{}] } } } }, 'FR', TODAY)).toBe(true);
    expect(movieAvailable({ 'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Y' }] } } } }, 'FR', TODAY)).toBe(false);
  });

  it('location ou achat seuls, sortie numérique future (précommande) : pas disponible', () => {
    const preorder = (kind: string) => ({
      release_dates: { results: [release('FR', [{ type: 4, release_date: FUTURE }])] },
      'watch/providers': { results: { FR: { [kind]: [{ provider_name: 'Z' }] } } },
    });
    expect(movieAvailable(preorder('rent'), 'FR', TODAY)).toBe(false);
    expect(movieAvailable(preorder('buy'), 'FR', TODAY)).toBe(false);
  });

  it('location ou achat avec sortie numérique passée : disponible', () => {
    const detail = {
      release_dates: { results: [release('FR', [{ type: 4, release_date: PAST }])] },
      'watch/providers': { results: { FR: { rent: [{ provider_name: 'Z' }] } } },
    };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(true);
  });

  it('repli US quand la région n’a aucune date de sortie', () => {
    const detail = { release_dates: { results: [release('US', [{ type: 5, release_date: PAST }])] } };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(true);
  });

  it('pas de donnée TMDB : écarté', () => {
    expect(movieAvailable({}, 'FR', TODAY)).toBe(false);
  });
});

describe('Top 10 : fraîcheur des films', () => {
  it('sortie dans les 365 derniers jours (bornes incluses) : frais', () => {
    expect(movieFresh({ release_date: '2026-01-15' }, TODAY)).toBe(true);
    expect(movieFresh({ release_date: '2025-10-19' }, TODAY)).toBe(true);
  });

  it('sortie plus ancienne, à venir ou absente : pas fraîche', () => {
    expect(movieFresh({ release_date: '2025-10-18' }, TODAY)).toBe(false);
    expect(movieFresh({ release_date: '2019-05-01' }, TODAY)).toBe(false);
    expect(movieFresh({ release_date: FUTURE }, TODAY)).toBe(false);
    expect(movieFresh({}, TODAY)).toBe(false);
  });
});

describe('Top 10 : disponibilité des séries', () => {
  it('au moins un épisode diffusé : première diffusion ou dernier épisode passés', () => {
    expect(seriesAired({ first_air_date: '2020-01-01' }, TODAY)).toBe(true);
    expect(seriesAired({ first_air_date: null, last_episode_to_air: { air_date: '2021-05-05' } }, TODAY)).toBe(true);
  });

  it('aucun épisode diffusé (première diffusion future) : écarté', () => {
    expect(seriesAired({ first_air_date: FUTURE }, TODAY)).toBe(false);
    expect(seriesAired({}, TODAY)).toBe(false);
  });

  it('todayOf donne la date AAAA-MM-JJ', () => {
    expect(todayOf(Date.UTC(2026, 9, 19, 12))).toBe('2026-10-19');
  });
});

describe('Top 10 : fraîcheur des séries', () => {
  it('première diffusion dans les 365 derniers jours : fraîche', () => {
    expect(seriesFresh({ first_air_date: '2026-01-10' }, TODAY)).toBe(true);
  });

  it('vieille série sans saison récente : pas fraîche ; saison diffusée il y a 120 jours (borne) : fraîche', () => {
    const old = { first_air_date: '2010-03-01' };
    expect(seriesFresh({ ...old, seasons: [{ season_number: 1, air_date: '2010-03-01' }, { season_number: 2, air_date: '2026-06-20' }] }, TODAY)).toBe(false);
    expect(seriesFresh({ ...old, seasons: [{ season_number: 1, air_date: '2010-03-01' }, { season_number: 2, air_date: '2026-06-21' }] }, TODAY)).toBe(true);
  });

  it('vieille série avec une saison diffusée il y a 30 jours : fraîche', () => {
    const detail = { first_air_date: '2010-03-01', seasons: [{ season_number: 1, air_date: '2010-03-01' }, { season_number: 2, air_date: '2026-09-19' }] };
    expect(seriesFresh(detail, TODAY)).toBe(true);
  });

  it('la saison la plus récente est celle de plus grand numéro, pas la dernière de la liste', () => {
    const newest = { first_air_date: '2010-03-01', seasons: [{ season_number: 3, air_date: '2026-09-19' }, { season_number: 2, air_date: '2026-06-01' }] };
    const older = { first_air_date: '2010-03-01', seasons: [{ season_number: 2, air_date: '2026-09-19' }, { season_number: 3, air_date: '2026-03-01' }] };
    expect(seriesFresh(newest, TODAY)).toBe(true);
    expect(seriesFresh(older, TODAY)).toBe(false);
  });

  it('saisons à venir et spéciaux (numéro 0) ignorés', () => {
    const futureSeason = { first_air_date: '2010-03-01', seasons: [{ season_number: 1, air_date: '2010-03-01' }, { season_number: 2, air_date: '2026-09-19' }, { season_number: 3, air_date: FUTURE }, { season_number: 0, air_date: '2026-10-10' }] };
    const specialOnly = { first_air_date: '2010-03-01', seasons: [{ season_number: 1, air_date: '2010-03-01' }, { season_number: 0, air_date: '2026-10-10' }, { season_number: 2, air_date: FUTURE }] };
    expect(seriesFresh(futureSeason, TODAY)).toBe(true);
    expect(seriesFresh(specialOnly, TODAY)).toBe(false);
  });

  it('sans date de première diffusion ni saison : pas fraîche', () => {
    expect(seriesFresh({}, TODAY)).toBe(false);
    expect(seriesFresh({ first_air_date: null, seasons: null }, TODAY)).toBe(false);
  });
});

describe('Top 10 : série fleuve et genres TV exclus', () => {
  it('plus de 100 épisodes et première diffusion plus vieille que 3 ans : fleuve (One Piece, Les Simpson)', () => {
    expect(isLongRunner({ number_of_episodes: 1100, first_air_date: '1999-10-20' }, TODAY)).toBe(true);
    expect(isLongRunner({ number_of_episodes: 750, first_air_date: '1989-12-17' }, TODAY)).toBe(true);
  });

  it('pas fleuve : 100 épisodes ou moins, ou première diffusion de moins de 3 ans', () => {
    expect(isLongRunner({ number_of_episodes: 60, first_air_date: '1999-10-20' }, TODAY)).toBe(false);
    expect(isLongRunner({ number_of_episodes: 100, first_air_date: '1999-10-20' }, TODAY)).toBe(false);
    expect(isLongRunner({ number_of_episodes: 150, first_air_date: '2025-01-01' }, TODAY)).toBe(false);
  });

  it('première diffusion absente : ancienneté inconnue, donc fleuve si plus de 100 épisodes', () => {
    expect(isLongRunner({ number_of_episodes: 150 }, TODAY)).toBe(true);
    expect(isLongRunner({ number_of_episodes: 8 }, TODAY)).toBe(false);
  });

  it('genres actualités (10763), téléréalité (10764), feuilleton (10766), talk-show (10767) : exclus', () => {
    expect(hasExcludedTvGenre({ genres: [{ id: 10767, name: 'Talk' }] })).toBe(true);
    expect(hasExcludedTvGenre({ genres: [{ id: 18 }, { id: 10764 }] })).toBe(true);
    expect(hasExcludedTvGenre({ genres: [{ id: 10763 }] })).toBe(true);
    expect(hasExcludedTvGenre({ genres: [{ id: 10766 }] })).toBe(true);
  });

  it('autres genres ou aucun genre : gardés', () => {
    expect(hasExcludedTvGenre({ genres: [{ id: 18 }, { id: 16 }] })).toBe(false);
    expect(hasExcludedTvGenre({})).toBe(false);
  });
});

describe('Top 10 : découverte régionale et ordre des sources', () => {
  it('jours décalés : un an en arrière, et passage d’une fin de mois', () => {
    expect(shiftDays('2026-10-19', -365)).toBe('2025-10-19');
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('films : tendances de la semaine, découverte régionale récente, populaires', () => {
    expect(sourcesOf('movie', 'FR', TODAY)).toEqual([
      { path: 'trending/movie/week', params: {} },
      {
        path: 'discover/movie',
        params: {
          watch_region: 'FR',
          with_watch_monetization_types: 'flatrate|free|ads',
          sort_by: 'popularity.desc',
          include_adult: 'false',
          'primary_release_date.gte': '2025-10-19',
          'primary_release_date.lte': TODAY,
        },
      },
      { path: 'movie/popular', params: {} },
    ]);
  });

  it('séries : découverte avec les bornes first_air_date et sans les genres TV exclus', () => {
    expect(discoverParams('tv', 'BE', TODAY)).toEqual({
      watch_region: 'BE',
      with_watch_monetization_types: 'flatrate|free|ads',
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'first_air_date.gte': '2025-10-19',
      'first_air_date.lte': TODAY,
      without_genres: '10763,10764,10766,10767',
    });
  });

  it('rangée du jour : tendances du jour, puis tendances de la semaine', () => {
    expect(sourcesOf('all', 'FR', TODAY)).toEqual([
      { path: 'trending/all/day', params: {} },
      { path: 'trending/all/week', params: {} },
    ]);
  });
});

/** Liste TMDB simulée : `pages[n - 1]` est la page n ; au-delà, page vide (fin de la source). */
const listing =
  (pages: unknown[][]): Handler =>
  (call) =>
    json({ results: pages[Number(call.url.searchParams.get('page') ?? '1') - 1] ?? [] });

/**
 * TMDB simulé : tendances de la semaine, découverte régionale et populaires (pages par type), détails par titre.
 * Une source absente des paramètres renvoie une liste vide.
 */
function tmdbTop(
  trendingMovies: unknown[][],
  trendingTv: unknown[][],
  details: Record<string, unknown>,
  popularMovies: unknown[][] = [],
  popularTv: unknown[][] = [],
  discoverMovies: unknown[][] = [],
  discoverTv: unknown[][] = [],
): MockUpstream {
  const handlers: Record<string, Handler> = {
    [`${TMDB}/trending/movie/week`]: listing(trendingMovies),
    [`${TMDB}/trending/tv/week`]: listing(trendingTv),
    [`${TMDB}/movie/popular`]: listing(popularMovies),
    [`${TMDB}/tv/popular`]: listing(popularTv),
    [`${TMDB}/discover/movie`]: listing(discoverMovies),
    [`${TMDB}/discover/tv`]: listing(discoverTv),
  };
  for (const [path, body] of Object.entries(details)) handlers[`${TMDB}/${path}`] = () => json(body);
  return mockUpstream(handlers);
}

/** Entrée de liste TMDB (tendances, découverte ou populaires) d'un film. */
const movieEntry = (id: number) => ({ id, title: `Film ${id}`, release_date: '2020-01-01', poster_path: '/p.jpg', vote_count: 900 });
/** Entrée de liste TMDB d'une série. */
const tvEntry = (id: number) => ({ id, name: `Série ${id}`, first_air_date: '2020-01-01', poster_path: '/p.jpg', vote_count: 500 });

/**
 * Détail TMDB d'un film : date de sortie (récente par défaut), dates de sortie FR et fournisseurs FR
 * (au plus une clé de fournisseur par appel).
 */
const movieDetail = (id: number, dates: Array<{ type: number; release_date: string }>, providers: Record<string, unknown[]> = {}, releaseDate = RECENT) => ({
  [`movie/${id}`]: {
    id,
    release_date: releaseDate,
    release_dates: { results: [{ iso_3166_1: 'FR', release_dates: dates }] },
    'watch/providers': { results: { FR: providers } },
  },
});

/** Film disponible (sortie numérique passée) ou non (sortie numérique future, pas de fournisseur). */
const available = (id: number) => movieDetail(id, [{ type: 4, release_date: PAST }]);
const unavailable = (id: number) => movieDetail(id, [{ type: 4, release_date: FUTURE }]);

/** Détail TMDB d'une série : diffusée récemment par défaut, huit épisodes, drame, sans saison. */
const tvDetail = (id: number, fields: Record<string, unknown> = {}) => ({
  [`tv/${id}`]: { id, first_air_date: RECENT_SERIES, number_of_episodes: 8, genres: [{ id: 18, name: 'Drame' }], seasons: [], ...fields },
});

async function getTop(type: string, query = 'region=FR&page=1'): Promise<Response> {
  const token = tokenFor({ tmdbToken: KEYS.tmdbToken });
  return fetch(`${running?.baseUrl ?? ''}/${token}/lt/top10/${type}?${query}`);
}

describe('Top 10 : route /lt/top10/:type', () => {
  it('films : ne garde que les titres disponibles (numérique, fournisseur, repli US), pas la sortie future ni la salle seule', async () => {
    const upstream = tmdbTop(
      [
        [
          { id: 1001, title: 'L’Odyssée', release_date: FUTURE, poster_path: '/a.jpg', vote_count: 900 },
          { id: 1002, title: 'Numérique FR', release_date: '2020-01-01', poster_path: '/b.jpg', vote_count: 900 },
          { id: 1003, title: 'Salle seule', release_date: '2026-10-01', poster_path: '/c.jpg', vote_count: 900 },
          { id: 1004, title: 'Repli US', release_date: '2020-01-01', poster_path: '/d.jpg', vote_count: 900 },
          { id: 1005, title: 'Fournisseur', release_date: '2026-10-01', poster_path: '/e.jpg', vote_count: 900 },
        ],
      ],
      [],
      {
        'movie/1001': { id: 1001, release_date: RECENT, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: FUTURE }] }] } },
        'movie/1002': { id: 1002, release_date: RECENT, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: PAST }] }] } },
        'movie/1003': { id: 1003, release_date: RECENT, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: RECENT }] }] } },
        'movie/1004': { id: 1004, release_date: RECENT, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 5, release_date: PAST }] }] } },
        'movie/1005': {
          id: 1005,
          release_date: RECENT,
          release_dates: { results: [] },
          'watch/providers': { results: { FR: { flatrate: [{ provider_name: 'Svc' }] } } },
        },
      },
    );
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const res = await getTop('movie');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; raw: number; results: Array<{ id: number }> };
    expect(body.raw).toBe(5);
    expect(body.results.map((r) => r.id)).toEqual([1002, 1004, 1005]);
    expect(body.page).toBe(1);
  });

  it('films : aucun titre disponible sur la page : résultats vides, raw reste > 0', async () => {
    const upstream = tmdbTop([[{ id: 2001, title: 'Pas encore', release_date: FUTURE, poster_path: '/a.jpg', vote_count: 900 }]], [], {
      'movie/2001': { id: 2001, release_date: RECENT, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: FUTURE }] }] } },
    });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: unknown[] };
    expect(body).toMatchObject({ raw: 1, results: [] });
  });

  it('films : sortie ancienne en abonnement exclue ; film récent en abonnement gardé ; sortie ancienne en numérique exclue', async () => {
    const upstream = tmdbTop(
      [[movieEntry(7001), movieEntry(7002), movieEntry(7003)]],
      [],
      {
        ...movieDetail(7001, [], { flatrate: [{ provider_name: 'Svc' }] }, '2019-05-01'),
        ...movieDetail(7002, [], { flatrate: [{ provider_name: 'Svc' }] }),
        ...movieDetail(7003, [{ type: 4, release_date: PAST }], {}, '2019-05-01'),
      },
    );
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.raw).toBe(3);
    expect(body.results.map((r) => r.id)).toEqual([7002]);
  });

  it('page 1 donne 8 disponibles : la page 2 complète la rangée à 10', async () => {
    const page1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(movieEntry);
    const page2 = [11, 12, 13, 14].map(movieEntry);
    const details = {
      ...Object.assign({}, ...[1, 2, 3, 4, 5, 6, 7, 8].map(available)),
      ...Object.assign({}, ...[9, 10].map(unavailable)),
      ...Object.assign({}, ...[11, 12, 13, 14].map((id) => movieDetail(id, [], { flatrate: [{ provider_name: 'Svc' }] }))),
    };
    const upstream = tmdbTop([page1, page2], [], details);
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { page: number; raw: number; results: Array<{ id: number }> };
    expect(body.results.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
    expect(body.raw).toBe(14);
    expect(upstream.callsTo(`${TMDB}/trending/movie/week`)).toHaveLength(2);
    expect(upstream.callsTo(`${TMDB}/discover/movie`)).toHaveLength(0);
    expect(upstream.callsTo(`${TMDB}/movie/popular`)).toHaveLength(0);
  });

  it('précommande : location ou achat avec sortie numérique future exclus ; abonnement sans date et location passée inclus', async () => {
    const upstream = tmdbTop(
      [[movieEntry(4001), movieEntry(4002), movieEntry(4003), movieEntry(4004)]],
      [],
      {
        ...movieDetail(4001, [{ type: 4, release_date: FUTURE }], { rent: [{ provider_name: 'Loc' }] }),
        ...movieDetail(4002, [{ type: 5, release_date: FUTURE }], { buy: [{ provider_name: 'Achat' }] }),
        ...movieDetail(4003, [], { flatrate: [{ provider_name: 'Svc' }] }),
        ...movieDetail(4004, [{ type: 4, release_date: PAST }], { rent: [{ provider_name: 'Loc' }] }),
      },
    );
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.results.map((r) => r.id)).toEqual([4003, 4004]);
    expect(body.raw).toBe(4);
  });

  it('repli sur les populaires : complète à partir de populaires, sans revérifier un titre déjà lu', async () => {
    const upstream = tmdbTop(
      [[movieEntry(5001), movieEntry(5002)]],
      [],
      { ...Object.assign({}, ...[5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010].map((id) => movieDetail(id, [], { flatrate: [{ provider_name: 'Svc' }] }))) },
      [[movieEntry(5001), ...[5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010].map(movieEntry)]],
    );
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.results.map((r) => r.id)).toEqual([5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010]);
    expect(upstream.callsTo(`${TMDB}/movie/5001`)).toHaveLength(1);
    expect(upstream.callsTo(`${TMDB}/movie/popular`)).toHaveLength(1);
  });

  it('plafond : au plus 8 pages lues au total (tendances seules), même sans dix titres', async () => {
    const pages = Array.from({ length: 10 }, (_, n) => [movieEntry(6001 + n)]);
    const details = Object.assign({}, ...Array.from({ length: 10 }, (_, n) => unavailable(6001 + n)));
    const upstream = tmdbTop(pages, [], details);
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: unknown[] };
    expect(body).toMatchObject({ raw: 8, results: [] });
    expect(upstream.callsTo(`${TMDB}/trending/movie/week`)).toHaveLength(8);
    expect(upstream.callsTo(`${TMDB}/discover/movie`)).toHaveLength(0);
    expect(upstream.callsTo(`${TMDB}/movie/popular`)).toHaveLength(0);
  });

  it('découverte régionale : discover reçoit la région, les fournisseurs directs et la fenêtre des 365 derniers jours', async () => {
    const today = todayOf(Date.now());
    const upstream = tmdbTop([], [], { ...tvDetail(7302) }, [], [], [[movieEntry(7301)]], [[tvEntry(7302)]]);
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    await getTop('movie', 'region=BE&page=1');
    await getTop('tv', 'region=BE&page=1');
    const [movieCall] = upstream.callsTo(`${TMDB}/discover/movie`);
    const [tvCall] = upstream.callsTo(`${TMDB}/discover/tv`);
    expect(movieCall?.url.searchParams.get('watch_region')).toBe('BE');
    expect(movieCall?.url.searchParams.get('with_watch_monetization_types')).toBe('flatrate|free|ads');
    expect(movieCall?.url.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(movieCall?.url.searchParams.get('include_adult')).toBe('false');
    expect(movieCall?.url.searchParams.get('primary_release_date.gte')).toBe(shiftDays(today, -365));
    expect(movieCall?.url.searchParams.get('primary_release_date.lte')).toBe(today);
    expect(movieCall?.url.searchParams.get('without_genres')).toBeNull();
    expect(tvCall?.url.searchParams.get('watch_region')).toBe('BE');
    expect(tvCall?.url.searchParams.get('with_watch_monetization_types')).toBe('flatrate|free|ads');
    expect(tvCall?.url.searchParams.get('first_air_date.gte')).toBe(shiftDays(today, -365));
    expect(tvCall?.url.searchParams.get('first_air_date.lte')).toBe(today);
    expect(tvCall?.url.searchParams.get('without_genres')).toBe('10763,10764,10766,10767');
  });

  it('séries : garde celles qui ont un épisode diffusé et une date fraîche, écarte les séries à venir', async () => {
    const upstream = tmdbTop([], [[tvEntry(3001), tvEntry(3002), tvEntry(3003)]], {
      ...tvDetail(3001),
      ...tvDetail(3002, { first_air_date: FUTURE }),
      ...tvDetail(3003, {
        first_air_date: null,
        last_episode_to_air: { air_date: RECENT },
        seasons: [{ season_number: 1, air_date: RECENT }],
      }),
    });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('tv')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.raw).toBe(3);
    expect(body.results.map((r) => r.id)).toEqual([3001, 3003]);
  });

  it('séries : One Piece-like exclue, nouvelle série et vieille série à saison récente gardées, vieille sans saison récente et talk-show exclus', async () => {
    const ago = (days: number) => shiftDays(NOW_DAY, -days);
    const upstream = tmdbTop([], [[tvEntry(3101), tvEntry(3102), tvEntry(3103), tvEntry(3104), tvEntry(3105)]], {
      ...tvDetail(3101, {
        first_air_date: '1999-10-20',
        number_of_episodes: 1100,
        seasons: [
          { season_number: 1, air_date: '1999-10-20' },
          { season_number: 23, air_date: ago(30) },
        ],
      }),
      ...tvDetail(3102, { first_air_date: ago(200), seasons: [{ season_number: 1, air_date: ago(200) }] }),
      ...tvDetail(3103, {
        first_air_date: '2010-03-01',
        number_of_episodes: 60,
        seasons: [
          { season_number: 1, air_date: '2010-03-01' },
          { season_number: 2, air_date: ago(30) },
        ],
      }),
      ...tvDetail(3104, {
        first_air_date: '2010-03-01',
        number_of_episodes: 60,
        seasons: [
          { season_number: 1, air_date: '2010-03-01' },
          { season_number: 2, air_date: ago(400) },
        ],
      }),
      ...tvDetail(3105, { first_air_date: ago(60), genres: [{ id: 10767, name: 'Talk' }] }),
    });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('tv')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.raw).toBe(5);
    expect(body.results.map((r) => r.id)).toEqual([3102, 3103]);
  });

  it('page absente de TMDB (fin des tendances, de la découverte et des populaires) : raw 0, aucun résultat', async () => {
    const upstream = tmdbTop([], [], {});
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie', 'region=FR&page=4')).json()) as { page: number; raw: number; results: unknown[] };
    expect(body).toEqual({ page: 4, raw: 0, results: [] });
  });

  it('type inconnu : 404', async () => {
    running = await startApp({ fetch: tmdbTop([], [], {}).fetch, lookupHost: fakeLookup() });
    const res = await fetch(`${running?.baseUrl ?? ''}/${tokenFor({ tmdbToken: KEYS.tmdbToken })}/lt/top10/person`);
    expect(res.status).toBe(404);
  });
});

/**
 * TMDB simulé pour la rangée du jour : `trending/all/day` (films et séries mêlés), puis `trending/all/week` (repli),
 * détails par titre (`movie/…`, `tv/…`).
 */
function tmdbDay(pages: unknown[][], details: Record<string, unknown>, weekPages: unknown[][] = []): MockUpstream {
  const handlers: Record<string, Handler> = {
    [`${TMDB}/trending/all/day`]: listing(pages),
    [`${TMDB}/trending/all/week`]: listing(weekPages),
  };
  for (const [path, body] of Object.entries(details)) handlers[`${TMDB}/${path}`] = () => json(body);
  return mockUpstream(handlers);
}

/** Entrées de la tendance du jour : `media_type` donne le type, comme dans TMDB. */
const dayMovie = (id: number) => ({ id, media_type: 'movie', title: `Film ${id}`, release_date: '2020-01-01', poster_path: '/p.jpg', vote_count: 900 });
const dayTv = (id: number) => ({ id, media_type: 'tv', name: `Série ${id}`, first_air_date: '2020-01-01', poster_path: '/p.jpg', vote_count: 500 });

/** Détail d'une série diffusée récemment, ou pas encore diffusée. */
const tvAired = (id: number) => tvDetail(id);
const tvFuture = (id: number) => tvDetail(id, { first_air_date: FUTURE });

describe('Top 10 : rangée du jour, route /lt/top10/all?window=day', () => {
  it('films et séries mêlés dans l’ordre de popularité ; personnes écartées ; disponibilité vérifiée par type', async () => {
    const upstream = tmdbDay(
      [[dayMovie(8001), dayTv(8002), { id: 8003, media_type: 'person', name: 'Acteur' }, dayTv(8004), dayMovie(8005)]],
      { ...available(8001), ...tvAired(8002), ...tvFuture(8004), ...unavailable(8005) },
    );
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const res = await getTop('all', 'region=FR&page=1&window=day');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; raw: number; results: Array<{ id: number; media_type: string }> };
    expect(body.results.map((r) => `${r.media_type}:${r.id}`)).toEqual(['movie:8001', 'tv:8002']);
    expect(body).toMatchObject({ page: 1, raw: 5 });
    // Moins de dix titres : la page 2 (vide) est lue aussi, puis la source est épuisée et les tendances de la semaine prennent le relais.
    expect(upstream.callsTo(`${TMDB}/trending/all/day`)).toHaveLength(2);
    expect(upstream.callsTo(`${TMDB}/trending/all/week`)).toHaveLength(1);
    expect(upstream.callsTo(`${TMDB}/movie/8003`)).toHaveLength(0);
    expect(upstream.callsTo(`${TMDB}/tv/8003`)).toHaveLength(0);
  });

  it('repli : les tendances de la semaine complètent la rangée du jour', async () => {
    const upstream = tmdbDay([[dayMovie(8301)]], { ...available(8301), ...available(8302) }, [[dayMovie(8302)]]);
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('all', 'window=day')).json()) as { results: Array<{ id: number }> };
    expect(body.results.map((r) => r.id)).toEqual([8301, 8302]);
    expect(upstream.callsTo(`${TMDB}/trending/all/week`)).toHaveLength(2);
  });

  it('un film et une série de même numéro : deux titres distincts, chacun vérifié', async () => {
    const upstream = tmdbDay([[dayMovie(9001), dayTv(9001)]], { ...available(9001), ...tvAired(9001) });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('all', 'window=day')).json()) as { results: Array<{ id: number; media_type: string }> };
    expect(body.results.map((r) => r.media_type)).toEqual(['movie', 'tv']);
    expect(upstream.callsTo(`${TMDB}/movie/9001`)).toHaveLength(1);
    expect(upstream.callsTo(`${TMDB}/tv/9001`)).toHaveLength(1);
  });

  it('dix titres exactement : indisponibles écartés, la page suivante complète la rangée, le reste n’est pas lu', async () => {
    const page1 = Array.from({ length: 12 }, (_, i) => dayMovie(7100 + i));
    const page2 = Array.from({ length: 6 }, (_, i) => dayTv(7200 + i));
    const details: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) Object.assign(details, available(7100 + i));
    for (let i = 6; i < 12; i++) Object.assign(details, unavailable(7100 + i));
    for (let i = 0; i < 6; i++) Object.assign(details, tvAired(7200 + i));
    const upstream = tmdbDay([page1, page2], details);
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('all', 'window=day')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.results.map((r) => r.id)).toEqual([7100, 7101, 7102, 7103, 7104, 7105, 7200, 7201, 7202, 7203]);
    expect(body.raw).toBe(18);
    expect(upstream.callsTo(`${TMDB}/trending/all/day`)).toHaveLength(2);
    expect(upstream.callsTo(`${TMDB}/trending/all/week`)).toHaveLength(0);
    expect(upstream.callsTo(`${TMDB}/tv/7205`)).toHaveLength(0);
  });

  it('fenêtre : all sans `window` ou avec `window=day` répond ; une autre fenêtre (all ou films) : 400', async () => {
    running = await startApp({ fetch: tmdbDay([], {}).fetch, lookupHost: fakeLookup() });
    expect((await getTop('all', 'region=FR')).status).toBe(200);
    expect((await getTop('all', 'window=day')).status).toBe(200);
    expect((await getTop('all', 'window=week')).status).toBe(400);
    expect((await getTop('movie', 'window=day')).status).toBe(400);
  });

  it('cache : la même page du jour n’est lue qu’une fois chez TMDB pendant l’heure', async () => {
    const upstream = tmdbDay([[dayMovie(8101)]], available(8101));
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    await getTop('all', 'window=day');
    const firstPass = upstream.callsTo(`${TMDB}/trending/all/day`).length;
    expect(firstPass).toBeGreaterThan(0);
    await getTop('all', 'window=day');
    expect(upstream.callsTo(`${TMDB}/trending/all/day`)).toHaveLength(firstPass);
  });
});
