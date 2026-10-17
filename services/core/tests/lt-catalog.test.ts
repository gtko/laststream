import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLookup, fullToken, json, KEYS, mockUpstream, type MockUpstream, type RunningApp, startApp, tokenFor } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';

let upstream: MockUpstream;
let app: RunningApp;

beforeAll(async () => {
  upstream = mockUpstream({
    [`${TMDB}/trending/all/week`]: () =>
      json({
        results: [
          { id: 603, media_type: 'movie', title: 'Matrix', poster_path: '/m.jpg', release_date: '1999-03-31', overview: 'Simulation' },
          { id: 1399, media_type: 'tv', name: 'Game of Thrones', first_air_date: '2011-04-17', poster_path: null },
          { id: 5000, media_type: 'person', name: 'Un acteur' },
          { id: 777, media_type: 'movie', title: 'Sans identifiant IMDb' },
        ],
      }),
    [`${TMDB}/movie/popular`]: (call) => {
      const page = call.url.searchParams.get('page');
      return json({ results: [{ id: 603, title: 'Matrix' }, { id: 603, title: 'Doublon' }], page: Number(page) });
    },
    [`${TMDB}/tv/popular`]: () => json({ results: [{ id: 1399, name: 'Game of Thrones' }] }),
    [`${TMDB}/movie/603/external_ids`]: () => json({ imdb_id: 'tt0133093' }),
    [`${TMDB}/tv/1399/external_ids`]: () => json({ imdb_id: 'tt0944947' }),
    [`${TMDB}/movie/777/external_ids`]: () => json({ imdb_id: null }),
  });
  app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
});

afterAll(async () => {
  await app.close();
});

const MATRIX = { id: 'tt0133093', type: 'movie', name: 'Matrix', poster: 'https://image.tmdb.org/t/p/w500/m.jpg', description: 'Simulation', releaseInfo: '1999' };
const GOT = { id: 'tt0944947', type: 'series', name: 'Game of Thrones', releaseInfo: '2011' };

describe('manifest Stremio par configuration', () => {
  it('avec jeton TMDB : ressource catalog et trois catalogues nommés', async () => {
    const res = await fetch(`${app.baseUrl}/${fullToken()}/manifest.json`);
    const manifest = (await res.json()) as { resources: string[]; catalogs: { id: string; name: string; type: string }[] };
    expect(manifest.resources).toEqual(['stream', 'catalog']);
    expect(manifest.catalogs.map((c) => [c.type, c.id, c.name])).toEqual([
      ['movie', 'lastaddon-trending', 'lastAddon · Tendances'],
      ['movie', 'lastaddon-popular-movies', 'Films populaires'],
      ['series', 'lastaddon-popular-series', 'Séries populaires'],
    ]);
  });

  it('sans jeton TMDB : manifest de base, sans catalogue', async () => {
    const res = await fetch(`${app.baseUrl}/${tokenFor({ mdblistApiKey: KEYS.mdblistApiKey })}/manifest.json`);
    expect(await res.json()).toMatchObject({ resources: ['stream'], catalogs: [] });
  });

  it('configuration illisible : manifest de base (200)', async () => {
    const res = await fetch(`${app.baseUrl}/abcdef/manifest.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resources: ['stream'], catalogs: [] });
  });
});

describe('catalog Stremio', () => {
  const catalog = (path: string): Promise<Response> => fetch(`${app.baseUrl}/${fullToken()}/catalog/${path}`);

  it('tendances de la semaine : films et séries avec ids IMDb, personnes et sans-IMDb écartés', async () => {
    const res = await catalog('movie/lastaddon-trending.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await res.json()).toEqual({ metas: [MATRIX, GOT] });
  });

  it('films populaires avec skip=20 : page 2 TMDB, doublons retirés', async () => {
    const res = await catalog('movie/lastaddon-popular-movies/skip=20.json');
    expect(await res.json()).toEqual({ metas: [{ id: 'tt0133093', type: 'movie', name: 'Matrix' }] });
    const call = upstream.callsTo(`${TMDB}/movie/popular`).at(-1);
    expect(call?.url.searchParams.get('page')).toBe('2');
  });

  it('skip absent ou invalide : page 1', async () => {
    await catalog('movie/lastaddon-popular-movies/skip=abc.json');
    expect(upstream.callsTo(`${TMDB}/movie/popular`).at(-1)?.url.searchParams.get('page')).toBe('1');
  });

  it('séries populaires', async () => {
    const res = await catalog('series/lastaddon-popular-series.json');
    expect(await res.json()).toEqual({ metas: [{ id: 'tt0944947', type: 'series', name: 'Game of Thrones' }] });
  });

  it('catalogue inconnu : liste vide', async () => {
    const res = await catalog('movie/inconnu.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metas: [] });
  });

  it('sans jeton TMDB : 404 service_not_configured', async () => {
    const res = await fetch(`${app.baseUrl}/${tokenFor({ openrouterApiKey: KEYS.openrouterApiKey })}/catalog/movie/lastaddon-trending.json`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'service_not_configured', service: 'tmdb' });
  });
});
