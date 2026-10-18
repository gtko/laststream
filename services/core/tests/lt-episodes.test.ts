import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { createLtContext } from '../src/lt/context.js';
import { canonicalToSearch } from '../src/lt/episodes.js';
import {
  fakeLookup,
  type Handler,
  json,
  KEYS,
  mockUpstream,
  type MockUpstream,
  type RunningApp,
  SECRET,
  startApp,
  tokenFor,
} from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const TVDB4 = 'https://api4.thetvdb.com/v4';
const TVDB3 = 'https://api.thetvdb.com';
const IMG = 'https://image.tmdb.org/t/p/w500';

/** Clés factices : v4 personnelle (jeton « v4-session ») et legacy (v4 refusée, v3 acceptée). */
const V4_KEY = 'v4-episodes-key-0001';
const LEGACY = '0123456789abcdef0123456789abcdef';

type Handlers = Record<string, Handler>;

/** Réponse TMDB d'une saison : épisodes au format TMDB. */
const tmdbSeason = (tv: string, number: number, episodes: unknown[]): Handlers => ({
  [`${TMDB}/tv/${tv}/season/${number}`]: () => json({ season_number: number, episodes }),
});

/** Épisodes de la série « plate » TMDB (saisons 1 et 2, spéciaux 0). */
const PLAIN_S1 = [
  { season_number: 1, episode_number: 1, name: 'Ep 1', overview: 'Résumé 1', air_date: '2020-01-01', runtime: 24, still_path: '/e11.jpg' },
  { season_number: 1, episode_number: 2, name: 'Ep 2', overview: '', air_date: '2020-01-08', runtime: null, still_path: null },
];
const PLAIN_S2 = [
  { season_number: 2, episode_number: 1, name: 'Ep 3', overview: 'R3', air_date: '2021-01-01', runtime: 23, still_path: '/e21.jpg' },
  { season_number: 2, episode_number: 2, name: 'Ep 4', overview: null, air_date: '2021-01-08', runtime: 22, still_path: null },
];
const PLAIN_S0 = [{ season_number: 0, episode_number: 1, name: 'Noël', overview: 'Spécial', air_date: '2020-12-25', runtime: 10, still_path: null }];

/** Fiche TMDB minimale : saisons, identifiant TVDB et groupes. */
const details = (id: number, body: Record<string, unknown>): Handlers => ({
  [`${TMDB}/tv/${id}`]: () => json({ id, ...body }),
});

let upstream: MockUpstream;
let app: RunningApp;

const v4Login = (): Handler => (call) => {
  const { apikey } = JSON.parse(call.body) as { apikey?: string };
  return apikey === V4_KEY ? json({ status: 'success', data: { token: 'v4-session' } }) : json({ status: 'failure' }, 401);
};

/** Épisodes TVDB v4 d'une langue (`fra` ou `eng`), une seule page. */
const v4Episodes = (id: string, lang: 'fra' | 'eng', episodes: unknown[]): Handlers => ({
  [`${TVDB4}/series/${id}/episodes/default/${lang}`]: (call) =>
    call.headers.authorization === 'Bearer v4-session'
      ? json({ status: 'success', data: { series: { id: Number(id) }, episodes }, links: { prev: null, self: 0, next: null } })
      : json({ status: 'failure' }, 401),
});

const FR_EPISODES = [
  { id: 1, seasonNumber: 1, number: 1, name: 'Pilote FR', overview: null, aired: '2020-01-01', runtime: 25 },
  { id: 2, seasonNumber: 1, number: 2, name: null, overview: 'Résumé FR 2', aired: '2020-01-08', runtime: null },
  { id: 3, seasonNumber: 2, number: 1, name: 'Suite', overview: null, aired: '2020-06-01', runtime: 0 },
  { id: 4, seasonNumber: 0, number: 1, name: 'Noël FR', overview: 'Spécial FR', aired: '2020-12-25', runtime: 12 },
];
const EN_EPISODES = [
  { id: 1, seasonNumber: 1, number: 1, name: 'Pilot EN', overview: 'Summary EN 1', aired: '2020-01-01', runtime: null },
  { id: 2, seasonNumber: 1, number: 2, name: 'Second EN', overview: 'Summary EN 2', aired: '2020-01-08', runtime: null },
  { id: 3, seasonNumber: 2, number: 1, name: 'Next EN', overview: 'Summary EN 3', aired: '2020-06-01', runtime: null },
  { id: 4, seasonNumber: 0, number: 1, name: 'Christmas EN', overview: 'Special EN', aired: '2020-12-25', runtime: null },
];

beforeAll(async () => {
  upstream = mockUpstream({
    // TMDB : série plate (1001), groupe d'épisodes (1002), TVDB v4 (1003), TVDB v3 (1004), panne TVDB (1005).
    ...details(1001, {
      number_of_seasons: 2,
      seasons: [
        { season_number: 0, name: 'Épisodes spéciaux', episode_count: 1, air_date: '2020-12-25', poster_path: null },
        { season_number: 1, name: 'Saison 1', episode_count: 2, air_date: '2020-01-01', poster_path: '/s1.jpg' },
        { season_number: 2, name: 'Saison 2', episode_count: 2, air_date: '2021-01-01', poster_path: '/s2.jpg' },
      ],
      external_ids: { tvdb_id: null },
      episode_groups: { results: [] },
    }),
    ...tmdbSeason('1001', 1, PLAIN_S1),
    ...tmdbSeason('1001', 2, PLAIN_S2),
    ...tmdbSeason('1001', 0, PLAIN_S0),
    ...details(1002, {
      number_of_seasons: 1,
      seasons: [{ season_number: 1, name: 'Saison 1', episode_count: 4, air_date: '2020-01-01', poster_path: '/g.jpg' }],
      external_ids: { tvdb_id: null },
      episode_groups: {
        results: [
          { id: 'a1b2c3d4e5f6a1b2c3d4e5f6', name: 'Original air date', type: 1, episode_count: 4, group_count: 2 },
          { id: 'ffffffffffffffffffffffff', name: 'DVD', type: 3, episode_count: 4, group_count: 9 },
        ],
      },
    }),
    [`${TMDB}/tv/episode_group/a1b2c3d4e5f6a1b2c3d4e5f6`]: () =>
      json({
        groups: [
          {
            name: 'Partie 2',
            order: 2,
            episodes: [
              { season_number: 1, episode_number: 3, name: 'C', overview: null, air_date: '2020-06-01', runtime: 21, still_path: null },
              { season_number: 1, episode_number: 4, name: 'D', overview: null, air_date: '2020-06-08', runtime: 21, still_path: null },
            ],
          },
          {
            name: 'Partie 1',
            order: 1,
            episodes: [
              { season_number: 1, episode_number: 1, name: 'A', overview: null, air_date: '2020-01-01', runtime: 24, still_path: null },
              { season_number: 1, episode_number: 2, name: 'B', overview: null, air_date: '2020-01-08', runtime: 24, still_path: null },
            ],
          },
        ],
      }),
    ...details(1003, {
      number_of_seasons: 1,
      seasons: [
        { season_number: 0, name: 'Épisodes spéciaux', episode_count: 1, air_date: '2020-12-25', poster_path: null },
        { season_number: 1, name: 'Saison 1', episode_count: 3, air_date: '2020-01-01', poster_path: '/tv1.jpg' },
      ],
      external_ids: { tvdb_id: 81189 },
      episode_groups: { results: [] },
    }),
    ...tmdbSeason('1003', 1, [
      { season_number: 1, episode_number: 1, name: 'TMDB 1', overview: 'Résumé TMDB 1', air_date: '2020-01-01', runtime: 23, still_path: '/t1.jpg' },
      { season_number: 1, episode_number: 2, name: null, overview: null, air_date: '2020-01-08', runtime: 22, still_path: '/t2.jpg' },
      { season_number: 1, episode_number: 3, name: 'TMDB 3', overview: 'Résumé TMDB 3', air_date: '2020-06-01', runtime: 21, still_path: '/t3.jpg' },
    ]),
    ...tmdbSeason('1003', 0, [
      { season_number: 0, episode_number: 1, name: 'Noël TMDB', overview: 'Spécial TMDB', air_date: '2020-12-25', runtime: 10, still_path: '/n.jpg' },
    ]),
    ...details(1004, {
      number_of_seasons: 1,
      seasons: [{ season_number: 1, name: 'Saison 1', episode_count: 1, air_date: '2020-01-01', poster_path: null }],
      external_ids: { tvdb_id: 121361 },
      episode_groups: { results: [] },
    }),
    ...tmdbSeason('1004', 1, [
      { season_number: 1, episode_number: 1, name: 'TMDB v3', overview: 'TMDB', air_date: '2020-01-01', runtime: 20, still_path: '/v3.jpg' },
    ]),
    ...details(1005, {
      number_of_seasons: 1,
      seasons: [{ season_number: 1, name: 'Saison 1', episode_count: 1, air_date: '2020-01-01', poster_path: null }],
      external_ids: { tvdb_id: 81192 },
      episode_groups: { results: [] },
    }),
    ...tmdbSeason('1005', 1, [
      { season_number: 1, episode_number: 1, name: 'Plain', overview: 'Repli', air_date: '2020-01-01', runtime: 19, still_path: null },
    ]),
    // TVDB v4 : connexion de V4_KEY ; épisodes en français puis en anglais (texte manquant seulement).
    [`${TVDB4}/login`]: v4Login(),
    ...v4Episodes('81189', 'fra', FR_EPISODES),
    ...v4Episodes('81189', 'eng', EN_EPISODES),
    // TVDB v4 : la lecture des épisodes échoue (panne) pour 81192.
    [`${TVDB4}/series/81192/episodes/default/fra`]: () => json({ status: 'failure' }, 500),
    // TVDB legacy : v4 refuse la clé (v4Login ne reconnaît que V4_KEY), v3 l'accepte (jeton « v3-session »).
    [`${TVDB3}/login`]: (call) => {
      const { apikey } = JSON.parse(call.body) as { apikey?: string };
      return apikey === LEGACY ? json({ token: 'v3-session' }) : json({ Error: 'Invalid API key' }, 401);
    },
    [`${TVDB3}/series/121361/episodes`]: (call) =>
      call.headers.authorization === 'Bearer v3-session'
        ? json({
            links: { first: 1, last: 1, next: null, prev: null },
            data: [{ airedSeason: 1, airedEpisodeNumber: 1, episodeName: 'Pilote v3', overview: 'Résumé v3', firstAired: '2020-01-01' }],
          })
        : json({ Error: 'Not Authorized' }, 401),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const get = (services: Record<string, string>, id: string, query = ''): Promise<Response> =>
  fetch(`${app.baseUrl}/${tokenFor(services)}/lt/series/${id}/episodes${query}`);

const TMDB_ONLY = { tmdbToken: KEYS.tmdbToken };

describe('lt/series/episodes : structure TMDB', () => {
  it('série plate : saisons TMDB, absolu hors spéciaux, spéciaux en fin, résultat mis en cache 12 h', async () => {
    const res = await get(TMDB_ONLY, '1001');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const body = await res.json();
    expect(body).toEqual({
      source: 'tmdb',
      seasons: [
        { number: 1, name: 'Saison 1', episodeCount: 2, airDate: '2020-01-01', poster: `${IMG}/s1.jpg` },
        { number: 2, name: 'Saison 2', episodeCount: 2, airDate: '2021-01-01', poster: `${IMG}/s2.jpg` },
        { number: 0, name: 'Épisodes spéciaux', episodeCount: 1, airDate: '2020-12-25', poster: null },
      ],
      episodes: [
        { season: 1, episode: 1, absolute: 1, name: 'Ep 1', overview: 'Résumé 1', airDate: '2020-01-01', runtime: 24, still: `${IMG}/e11.jpg`, tmdbSeason: 1, tmdbEpisode: 1 },
        { season: 1, episode: 2, absolute: 2, name: 'Ep 2', overview: null, airDate: '2020-01-08', runtime: null, still: null, tmdbSeason: 1, tmdbEpisode: 2 },
        { season: 2, episode: 1, absolute: 3, name: 'Ep 3', overview: 'R3', airDate: '2021-01-01', runtime: 23, still: `${IMG}/e21.jpg`, tmdbSeason: 2, tmdbEpisode: 1 },
        { season: 2, episode: 2, absolute: 4, name: 'Ep 4', overview: null, airDate: '2021-01-08', runtime: 22, still: null, tmdbSeason: 2, tmdbEpisode: 2 },
        { season: 0, episode: 1, absolute: null, name: 'Noël', overview: 'Spécial', airDate: '2020-12-25', runtime: 10, still: null, tmdbSeason: 0, tmdbEpisode: 1 },
      ],
    });
    // Deuxième requête : servie par le cache, aucun nouvel appel TMDB pour la fiche.
    await (await get(TMDB_ONLY, '1001')).json();
    expect(upstream.callsTo(`${TMDB}/tv/1001`)).toHaveLength(1);
  });

  it('groupe d’épisodes TMDB (type 1, plus de groupes que de saisons) : une saison par groupe, triée par ordre', async () => {
    const res = await get(TMDB_ONLY, '1002');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: 'tmdb-group',
      seasons: [
        { number: 1, name: 'Partie 1', episodeCount: 2, airDate: '2020-01-01', poster: null },
        { number: 2, name: 'Partie 2', episodeCount: 2, airDate: '2020-06-01', poster: null },
      ],
      episodes: [
        { season: 1, episode: 1, absolute: 1, name: 'A', overview: null, airDate: '2020-01-01', runtime: 24, still: null, tmdbSeason: 1, tmdbEpisode: 1 },
        { season: 1, episode: 2, absolute: 2, name: 'B', overview: null, airDate: '2020-01-08', runtime: 24, still: null, tmdbSeason: 1, tmdbEpisode: 2 },
        { season: 2, episode: 1, absolute: 3, name: 'C', overview: null, airDate: '2020-06-01', runtime: 21, still: null, tmdbSeason: 1, tmdbEpisode: 3 },
        { season: 2, episode: 2, absolute: 4, name: 'D', overview: null, airDate: '2020-06-08', runtime: 21, still: null, tmdbSeason: 1, tmdbEpisode: 4 },
      ],
    });
  });

  it('clé TVDB présente mais sans identifiant TVDB côté TMDB : aucun appel TVDB', async () => {
    const before = upstream.calls.filter((c) => c.url.origin === TVDB4 || c.url.origin === TVDB3).length;
    const res = await get({ tmdbToken: KEYS.tmdbToken, tvdbApiKey: V4_KEY }, '1002');
    expect(((await res.json()) as { source: string }).source).toBe('tmdb-group');
    expect(upstream.calls.filter((c) => c.url.origin === TVDB4 || c.url.origin === TVDB3).length).toBe(before);
  });
});

describe('lt/series/episodes : ordre TVDB', () => {
  it('clé v4 : ordre de diffusion TVDB, texte français puis TMDB puis anglais, images et durées TMDB par date', async () => {
    const res = await get({ tmdbToken: KEYS.tmdbToken, tvdbApiKey: V4_KEY }, '1003');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: 'tvdb',
      seasons: [
        { number: 1, name: 'Saison 1', episodeCount: 2, airDate: '2020-01-01', poster: null },
        { number: 2, name: 'Saison 2', episodeCount: 1, airDate: '2020-06-01', poster: null },
        { number: 0, name: 'Épisodes spéciaux', episodeCount: 1, airDate: '2020-12-25', poster: null },
      ],
      episodes: [
        { season: 1, episode: 1, absolute: 1, name: 'Pilote FR', overview: 'Résumé TMDB 1', airDate: '2020-01-01', runtime: 25, still: `${IMG}/t1.jpg`, tmdbSeason: 1, tmdbEpisode: 1 },
        { season: 1, episode: 2, absolute: 2, name: 'Second EN', overview: 'Résumé FR 2', airDate: '2020-01-08', runtime: 22, still: `${IMG}/t2.jpg`, tmdbSeason: 1, tmdbEpisode: 2 },
        { season: 2, episode: 1, absolute: 3, name: 'Suite', overview: 'Résumé TMDB 3', airDate: '2020-06-01', runtime: 21, still: `${IMG}/t3.jpg`, tmdbSeason: 1, tmdbEpisode: 3 },
        { season: 0, episode: 1, absolute: null, name: 'Noël FR', overview: 'Spécial FR', airDate: '2020-12-25', runtime: 12, still: `${IMG}/n.jpg`, tmdbSeason: 0, tmdbEpisode: 1 },
      ],
    });
    // Le texte anglais n'est demandé qu'à cause des noms ou résumés manquants en français.
    expect(upstream.callsTo(`${TVDB4}/series/81189/episodes/default/eng`)).toHaveLength(1);
    expect(upstream.callsTo(`${TVDB4}/series/81189/episodes/default/fra`)).toHaveLength(1);
  });

  it('clé legacy : repli sur l’API v3, en-tête Accept-Language fr', async () => {
    const res = await get({ tmdbToken: KEYS.tmdbToken, tvdbApiKey: LEGACY }, '1004');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; episodes: unknown[] };
    expect(body.source).toBe('tvdb');
    expect(body.episodes).toEqual([
      { season: 1, episode: 1, absolute: 1, name: 'Pilote v3', overview: 'Résumé v3', airDate: '2020-01-01', runtime: 20, still: `${IMG}/v3.jpg`, tmdbSeason: 1, tmdbEpisode: 1 },
    ]);
    const [v3Call] = upstream.callsTo(`${TVDB3}/series/121361/episodes`);
    expect(v3Call?.headers['accept-language']).toBe('fr');
  });

  it('panne TVDB : repli sur la structure TMDB (source tmdb), sans la clé dans la réponse', async () => {
    const res = await get({ tmdbToken: KEYS.tmdbToken, tvdbApiKey: V4_KEY }, '1005');
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({
      source: 'tmdb',
      episodes: [{ season: 1, episode: 1, absolute: 1, name: 'Plain', overview: 'Repli', tmdbSeason: 1, tmdbEpisode: 1 }],
    });
    expect(raw).not.toContain(V4_KEY);
  });
});

describe('lt/series/episodes : entrées invalides', () => {
  it('identifiant TMDB non numérique ou langue invalide : 404 not_found', async () => {
    const bad = await get(TMDB_ONLY, 'abc');
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'not_found' });
    const lang = await get(TMDB_ONLY, '1001', '?language=../etc');
    expect(lang.status).toBe(404);
  });

  it('sans jeton TMDB : 404 service_not_configured', async () => {
    const res = await get({}, '1001');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'service_not_configured', service: 'tmdb' });
  });
});

describe('canonicalToSearch : coordonnées de recherche (saison, épisode, absolu)', () => {
  it('renvoie le numéro absolu hors spéciaux, null pour un épisode inconnu', async () => {
    const deps = { secret: SECRET, fetch: upstream.fetch, lookupHost: fakeLookup(), allowPlain: false } as unknown as AppDeps;
    const ctx = createLtContext(deps);
    const services = { tmdbToken: KEYS.tmdbToken, tvdbApiKey: undefined, tvdbPin: undefined };
    expect(await canonicalToSearch(ctx, services, '1001', 2, 1)).toEqual({ season: 2, episode: 1, absolute: 3 });
    expect(await canonicalToSearch(ctx, services, '1001', 0, 1)).toEqual({ season: 0, episode: 1, absolute: null });
    expect(await canonicalToSearch(ctx, services, '1001', 9, 9)).toBeNull();
  });
});
