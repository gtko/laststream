import { afterEach, describe, expect, it } from 'vitest';
import { movieAvailable, seriesAired, todayOf } from '../src/lt/top10.js';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

/** Top 10 de l'accueil (lt/top10.ts) : disponibilité des films et séries, pages filtrées servies par la route. */

const TMDB = 'https://api.themoviedb.org/3';
/** Dates fixes, loin du jour courant : le test ne dépend pas de l'horloge. */
const TODAY = '2026-10-19';
const PAST = '2020-02-01T00:00:00.000Z';
const FUTURE = '2099-07-17';

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

  it('fournisseur dans la région (abonnement, location…) : disponible, même sans date numérique', () => {
    const detail = { 'watch/providers': { results: { FR: { rent: [{ provider_name: 'X' }] } } } };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(true);
    expect(movieAvailable({ 'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Y' }] } } } }, 'FR', TODAY)).toBe(false);
  });

  it('repli US quand la région n’a aucune date de sortie', () => {
    const detail = { release_dates: { results: [release('US', [{ type: 5, release_date: PAST }])] } };
    expect(movieAvailable(detail, 'FR', TODAY)).toBe(true);
  });

  it('pas de donnée TMDB : écarté', () => {
    expect(movieAvailable({}, 'FR', TODAY)).toBe(false);
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

/** TMDB simulé : tendances de la semaine (page 1 seulement) et détails par titre. */
function tmdbTop(trendingMovies: unknown[], trendingTv: unknown[], details: Record<string, unknown>): MockUpstream {
  const trending = (results: unknown[]): Handler => (call) => json({ results: call.url.searchParams.get('page') === '1' ? results : [] });
  const handlers: Record<string, Handler> = {
    [`${TMDB}/trending/movie/week`]: trending(trendingMovies),
    [`${TMDB}/trending/tv/week`]: trending(trendingTv),
  };
  for (const [path, body] of Object.entries(details)) handlers[`${TMDB}/${path}`] = () => json(body);
  return mockUpstream(handlers);
}

async function getTop(type: 'movie' | 'tv', query = 'region=FR&page=1'): Promise<Response> {
  const token = tokenFor({ tmdbToken: KEYS.tmdbToken });
  return fetch(`${running?.baseUrl ?? ''}/${token}/lt/top10/${type}?${query}`);
}

describe('Top 10 : route /lt/top10/:type', () => {
  it('films : ne garde que les titres disponibles (numérique, fournisseur, repli US), pas la sortie future ni la salle seule', async () => {
    const upstream = tmdbTop(
      [
        { id: 1001, title: 'L’Odyssée', release_date: FUTURE, poster_path: '/a.jpg', vote_count: 900 },
        { id: 1002, title: 'Numérique FR', release_date: '2020-01-01', poster_path: '/b.jpg', vote_count: 900 },
        { id: 1003, title: 'Salle seule', release_date: '2026-10-01', poster_path: '/c.jpg', vote_count: 900 },
        { id: 1004, title: 'Repli US', release_date: '2020-01-01', poster_path: '/d.jpg', vote_count: 900 },
        { id: 1005, title: 'Fournisseur', release_date: '2026-10-01', poster_path: '/e.jpg', vote_count: 900 },
      ],
      [],
      {
        'movie/1001': { id: 1001, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: FUTURE }] }] } },
        'movie/1002': { id: 1002, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 4, release_date: PAST }] }] } },
        'movie/1003': { id: 1003, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: '2026-10-01' }] }] } },
        'movie/1004': { id: 1004, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 5, release_date: PAST }] }] } },
        'movie/1005': { id: 1005, release_dates: { results: [] }, 'watch/providers': { results: { FR: { flatrate: [{ provider_name: 'Svc' }] } } } },
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

  it('films : aucun titre disponible sur la page : résultats vides, raw reste > 0 (la page suivante est lue)', async () => {
    const upstream = tmdbTop([{ id: 2001, title: 'Pas encore', release_date: FUTURE, poster_path: '/a.jpg', vote_count: 900 }], [], {
      'movie/2001': { id: 2001, release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: FUTURE }] }] } },
    });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('movie')).json()) as { raw: number; results: unknown[] };
    expect(body).toMatchObject({ raw: 1, results: [] });
  });

  it('séries : garde celles qui ont un épisode diffusé, écarte les séries sans épisode passé', async () => {
    const upstream = tmdbTop([], [
      { id: 3001, name: 'Diffusée', first_air_date: '2020-01-01', poster_path: '/a.jpg', vote_count: 500 },
      { id: 3002, name: 'À venir', first_air_date: FUTURE, poster_path: '/b.jpg', vote_count: 500 },
      { id: 3003, name: 'Dernier épisode', first_air_date: null, poster_path: '/c.jpg', vote_count: 500 },
    ], {
      'tv/3001': { id: 3001, first_air_date: '2020-01-01' },
      'tv/3002': { id: 3002, first_air_date: FUTURE },
      'tv/3003': { id: 3003, first_air_date: null, last_episode_to_air: { air_date: '2021-05-05' } },
    });
    running = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const body = (await (await getTop('tv')).json()) as { raw: number; results: Array<{ id: number }> };
    expect(body.raw).toBe(3);
    expect(body.results.map((r) => r.id)).toEqual([3001, 3003]);
  });

  it('page absente de TMDB (fin des tendances) : raw 0, aucun résultat', async () => {
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
