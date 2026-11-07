import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fakeLookup,
  json,
  KEYS,
  mockUpstream,
  type MockUpstream,
  type RunningApp,
  startApp,
  tokenFor,
} from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const TVDB4 = 'https://api4.thetvdb.com/v4';
const TVDB3 = 'https://api.thetvdb.com';
const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series';
const IMG = 'https://image.tmdb.org/t/p/w500';
const V4_KEY = 'v4-stills-key-0001';
const LEGACY = 'fedcba9876543210fedcba9876543210';

type Handlers = Record<string, (call: { body: string }) => Response>;

const tv = (id: number, extra: Record<string, unknown>, episodeCount: number): Handlers => ({
  [`${TMDB}/tv/${id}`]: () =>
    json({
      id,
      number_of_seasons: 1,
      seasons: [{ season_number: 1, name: 'Saison 1', episode_count: episodeCount, air_date: '2020-01-01', poster_path: null }],
      episode_groups: { results: [] },
      ...extra,
    }),
});

const season = (id: number, episodes: unknown[]): Handlers => ({
  [`${TMDB}/tv/${id}/season/1`]: () => json({ season_number: 1, episodes }),
});

const ep = (n: number, date: string | null, still: string | null): Record<string, unknown> => ({
  season_number: 1,
  episode_number: n,
  name: `Ep ${n}`,
  overview: 'R',
  air_date: date,
  runtime: 20,
  still_path: still,
});

const cinemeta = (imdb: string, videos: unknown[]): Handlers => ({
  [`${CINEMETA}/${imdb}.json`]: () => json({ meta: { id: imdb, videos } }),
});
const thumb = (season: number, episode: number, released: string | null, url: string | null) => ({
  id: `x:${season}:${episode}`,
  season,
  episode,
  released: released === null ? null : `${released}T00:00:00.000Z`,
  thumbnail: url ?? undefined,
});

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    // 3001 : TMDB seul + Cinemeta. Ep1 a une image TMDB, Ep2 est reliée par numéro (date identique), Ep3 par date (numérotation
    // Cinemeta décalée), Ep4 a une date différente de l'Ep4 Cinemeta et aucune autre date commune : pas d'image.
    ...tv(3001, { external_ids: { imdb_id: 'tt0003001' } }, 4),
    ...season(3001, [ep(1, '2020-01-01', '/own.jpg'), ep(2, '2020-01-08', null), ep(3, '2020-01-15', null), ep(4, '2020-01-22', null)]),
    ...cinemeta('tt0003001', [
      thumb(1, 1, '2020-01-01', 'http://img.example.com/c1.jpg'),
      thumb(1, 2, '2020-01-08', 'https://img.example.com/c2.jpg'),
      thumb(1, 7, '2020-01-15', 'https://img.example.com/c7.jpg'),
      thumb(1, 4, '2020-03-30', 'https://img.example.com/c4-autre-date.jpg'),
      thumb(1, 9, '2020-02-02', null),
    ]),
    // 3002 : TVDB v4. Ep1 et Ep2 ont une image TVDB (prioritaire sur TMDB), Ep3 Cinemeta, Ep4 rien.
    ...tv(3002, { external_ids: { tvdb_id: 7002, imdb_id: 'tt0003002' } }, 4),
    ...season(3002, [ep(1, '2020-01-01', '/t1.jpg'), ep(2, '2020-01-08', null), ep(3, '2020-01-15', null), ep(4, '2020-01-22', null)]),
    [`${TVDB4}/login`]: (call) =>
      (JSON.parse(call.body) as { apikey?: string }).apikey === V4_KEY
        ? json({ status: 'success', data: { token: 'v4-session' } })
        : json({ status: 'failure' }, 401),
    [`${TVDB4}/series/7002/episodes/default/fra`]: () =>
      json({
        status: 'success',
        data: {
          episodes: [
            { seasonNumber: 1, number: 1, name: 'A', overview: 'x', aired: '2020-01-01', image: 'https://artworks.thetvdb.com/banners/v4/a.jpg' },
            { seasonNumber: 1, number: 2, name: 'B', overview: 'x', aired: '2020-01-08', image: 'https://artworks.thetvdb.com/banners/v4/b.jpg' },
            { seasonNumber: 1, number: 3, name: 'C', overview: 'x', aired: '2020-01-15', image: '' },
            { seasonNumber: 1, number: 4, name: 'D', overview: 'x', aired: '2020-01-22' },
          ],
        },
        links: { next: null },
      }),
    ...cinemeta('tt0003002', [thumb(1, 3, '2020-01-15', 'https://img.example.com/s3.jpg')]),
    // 3003 : TVDB v3 (clé legacy), le chemin relatif « filename » devient une URL TVDB complète.
    ...tv(3003, { external_ids: { tvdb_id: 7003 } }, 1),
    ...season(3003, [ep(1, '2020-01-01', null)]),
    [`${TVDB3}/login`]: () => json({ token: 'v3-session' }),
    [`${TVDB3}/series/7003/episodes`]: () =>
      json({
        links: { first: 1, last: 1, next: null, prev: null },
        data: [{ airedSeason: 1, airedEpisodeNumber: 1, episodeName: 'P', overview: 'o', firstAired: '2020-01-01', filename: 'episodes/7003/1.jpg' }],
      }),
    // 3004 : toutes les images viennent de TMDB, Cinemeta n'est jamais appelé.
    ...tv(3004, { external_ids: { imdb_id: 'tt0003004' } }, 1),
    ...season(3004, [ep(1, '2020-01-01', '/full.jpg')]),
    // 3005 : Cinemeta en panne, résultat dégradé (rappelé plus tôt) sans image.
    ...tv(3005, { external_ids: { imdb_id: 'tt0003005' } }, 1),
    ...season(3005, [ep(1, '2020-01-01', null)]),
    [`${CINEMETA}/tt0003005.json`]: () => new Response('boom', { status: 500 }),
    // 3006 : Cinemeta ne connaît pas la série (404) : aucune image, pas d'échec.
    ...tv(3006, { external_ids: { imdb_id: 'tt0003006' } }, 1),
    ...season(3006, [ep(1, '2020-01-01', null)]),
    [`${CINEMETA}/tt0003006.json`]: () => json({}, 404),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

interface Body {
  episodes: { episode: number; still: string | null }[];
}

const get = async (services: Record<string, string>, id: number, query = ''): Promise<Body> => {
  const res = await fetch(`${app.baseUrl}/${tokenFor(services)}/lt/series/${id}/episodes${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};
const stills = (body: Body): (string | null)[] => body.episodes.map((e) => e.still);
const TMDB_ONLY = { tmdbToken: KEYS.tmdbToken };

describe('vignettes d\'épisodes : TMDB, TVDB, Cinemeta', () => {
  it('TMDB seul : image TMDB, Cinemeta par numéro (dates concordantes, http remonté en https), par date, sinon rien', async () => {
    expect(stills(await get(TMDB_ONLY, 3001))).toEqual([
      `${IMG}/own.jpg`,
      'https://img.example.com/c2.jpg',
      'https://img.example.com/c7.jpg',
      null,
    ]);
  });

  it('Cinemeta : un seul appel par série, mémorisé (autre langue comprise)', async () => {
    await get(TMDB_ONLY, 3001, '?language=en-US');
    expect(upstream.callsTo(`${CINEMETA}/tt0003001.json`).length).toBe(1);
  });

  it('TVDB v4 : image TVDB, puis TMDB, puis Cinemeta, puis rien', async () => {
    const services = { tmdbToken: KEYS.tmdbToken, tvdbApiKey: V4_KEY };
    expect(stills(await get(services, 3002))).toEqual([
      'https://artworks.thetvdb.com/banners/v4/a.jpg',
      'https://artworks.thetvdb.com/banners/v4/b.jpg',
      'https://img.example.com/s3.jpg',
      null,
    ]);
  });

  it('TVDB v3 : le champ filename devient une URL https complète', async () => {
    const services = { tmdbToken: KEYS.tmdbToken, tvdbApiKey: LEGACY };
    expect(stills(await get(services, 3003))).toEqual(['https://artworks.thetvdb.com/banners/episodes/7003/1.jpg']);
  });

  it('toutes les images présentes : Cinemeta n\'est pas appelé', async () => {
    expect(stills(await get(TMDB_ONLY, 3004))).toEqual([`${IMG}/full.jpg`]);
    expect(upstream.callsTo(`${CINEMETA}/tt0003004.json`).length).toBe(0);
  });

  it('Cinemeta en panne : structure rendue sans image, nouvel essai rapide (non gardé 12 h)', async () => {
    expect(stills(await get(TMDB_ONLY, 3005))).toEqual([null]);
    expect(stills(await get(TMDB_ONLY, 3005))).toEqual([null]);
    expect(upstream.callsTo(`${CINEMETA}/tt0003005.json`).length).toBe(1);
    // La structure dégradée est gardée 15 min côté serveur : un second passage ne rappelle ni TMDB ni Cinemeta.
    expect(upstream.callsTo(`${TMDB}/tv/3005`).length).toBe(1);
  });

  it('série inconnue de Cinemeta (404) : aucune image, sans erreur', async () => {
    expect(stills(await get(TMDB_ONLY, 3006))).toEqual([null]);
  });
});
