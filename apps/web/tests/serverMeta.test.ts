// Fiche serveur (GET …/lt/meta/:type/:tmdbId) dans le détail : notes, TVDB et épisodes viennent de la fiche sans appels
// séparés ; erreur ou forme inattendue : repli sur les appels séparés ; 304 réutilise le corps gardé. jsdom, fetch simulé.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hls.js', () => ({ default: class { static isSupported = () => false; } }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = 'http://localhost:7000';
const CONFIG = 'CFG_meta-test';
const LT = `/${CONFIG}/lt/`;
const TVDB_ROUTE_NEXT = '2099-02-02';
const FICHE_TVDB_NEXT = '2099-01-15';

type Reply = (u: URL, init?: RequestInit) => Response | Promise<Response>;

let urls: string[] = [];
let metaReply: Reply = () => json({ error: 'not_found' }, 404);

let ficheModel: any;
let ficheSections: any;
let lt: any;
let transport: any;
let series: any;
let stateMod: any;
let util: any;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Fiche serveur d'une série : notes, TVDB et épisodes à plat (saisons 1 et 2, trois épisodes). */
function serverSeries(id: number): any {
  return {
    v: 1, type: 'series', tmdbId: id, imdbId: 'tt0100', tvdbId: 81189, title: 'Série ' + id, originalTitle: null,
    year: 2020, releaseDate: '2020-01-01', status: 'Returning Series', nextAirDate: FICHE_TVDB_NEXT, overview: 'Un synopsis.',
    genres: ['Drame'], runtime: 45, poster: null, backdrop: null, cast: [],
    ratings: { ratings: { imdb: 7.9, rottentomatoes: null, rottentomatoes_audience: null, metacritic: null, letterboxd: null, tmdb: null, trakt: null }, score: 79 },
    ratingsDueAt: Date.now() + 86_400_000,
    tvdb: { status: 'Continuing', seasonCount: 2, nextAired: FICHE_TVDB_NEXT, lastAired: '2020-02-01' },
    episodes: {
      source: 'tvdb',
      seasons: [
        { number: 1, name: 'Saison 1', episodeCount: 2, airDate: '2020-01-01', poster: null },
        { number: 2, name: 'Saison 2', episodeCount: 1, airDate: '2021-01-01', poster: null },
      ],
      episodes: [
        { season: 1, episode: 1, absolute: 1, name: 'Pilote', overview: '', airDate: '2020-01-01', runtime: 42, still: null, tmdbSeason: 1, tmdbEpisode: 1 },
        { season: 1, episode: 2, absolute: 2, name: 'Deux', overview: '', airDate: '2020-01-08', runtime: 42, still: null, tmdbSeason: 1, tmdbEpisode: 2 },
        { season: 2, episode: 1, absolute: 3, name: 'Retour', overview: '', airDate: '2021-01-01', runtime: 42, still: null, tmdbSeason: 2, tmdbEpisode: 1 },
      ],
    },
    partial: false,
  };
}

/** Détail TMDB d'une série (append_to_response inclus), avec un identifiant TVDB. */
function tvDetail(id: number): any {
  return {
    id, name: 'Série ' + id, original_name: 'Serie', overview: 'Un synopsis.', tagline: 'Slogan', status: 'Returning Series',
    poster_path: '/p.jpg', backdrop_path: '/b.jpg', first_air_date: '2020-01-01', genres: [{ id: 18, name: 'Drame' }],
    episode_run_time: [45], number_of_seasons: 2, number_of_episodes: 3,
    seasons: [
      { season_number: 1, episode_count: 2, air_date: '2020-01-01', name: 'Saison 1' },
      { season_number: 2, episode_count: 1, air_date: '2021-01-01', name: 'Saison 2' },
    ],
    next_episode_to_air: null, last_episode_to_air: null, imdb_id: 'tt0100',
    external_ids: { imdb_id: 'tt0100', tvdb_id: 81189 },
    images: { logos: [] }, videos: { results: [] }, credits: { cast: [], crew: [] }, content_ratings: { results: [] },
    recommendations: { results: [] }, similar: { results: [] }, vote_average: 7.4, created_by: [],
    production_countries: [], spoken_languages: [], networks: [], production_companies: [],
  };
}

/** Routes simulées : TMDB, MDBList, TVDB, épisodes (404 par défaut) et fiche serveur (`metaReply`). */
function route(u: URL, init?: RequestInit): Response | Promise<Response> {
  const p = u.pathname;
  if (p.includes('/lt/meta/')) return metaReply(u, init);
  const tv = /\/lt\/tmdb\/tv\/(\d+)$/.exec(p);
  if (tv) return json(tvDetail(Number(tv[1])));
  if (p.includes('/lt/tmdb/')) return json({ results: [] });
  if (p.includes('/lt/mdblist/')) return json({ ratings: { imdb: 7.9 } });
  if (p.includes('/lt/tvdb/series/')) return json({ status: 'Continuing', seasonCount: 2, nextAired: TVDB_ROUTE_NEXT, lastAired: '2020-02-01' });
  return json({ error: 'not_found' }, 404);
}

const paths = (): string[] => urls.map((u) => new URL(u).pathname);
const pathOf = (suffix: string): string => LT + suffix;

/** IndexedDB minimale (même modèle que le test des fiches ETag) : open / transaction / get / put / clear. */
function fakeIndexedDb() {
  const data = new Map<string, unknown>();
  const request = (run: () => unknown) => {
    const r: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      r.result = run();
      r.onsuccess?.();
    });
    return r;
  };
  const store = {
    get: (k: string) => request(() => data.get(k)),
    put: (v: unknown, k: string) => request(() => { data.set(k, v); return k; }),
    clear: () => request(() => data.clear()),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction: () => ({ objectStore: () => store }),
  };
  const factory = {
    open: () => {
      const r: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        r.result = db;
        r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { factory, data };
}

/** Laisse passer les écritures asynchrones du cache (IndexedDB simulée, repli mémoire). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  const config: any = await import('../src/data/config');
  config.saveSettings({ base: BASE, config: CONFIG });
  ficheModel = await import('../src/ui/ficheModel.js');
  ficheSections = await import('../src/ui/ficheSections.js');
  lt = await import('../src/data/lt');
  transport = await import('../src/data/transport');
  series = await import('../src/data/series');
  stateMod = await import('../src/ui/state.js');
  util = await import('../src/ui/util.js');
});

beforeEach(() => {
  urls = [];
  metaReply = () => json({ error: 'not_found' }, 404);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    return route(new URL(String(url)), init);
  }));
  ficheModel.fullCache.clear();
  transport.clearCache();
  series.clearCanonCache();
  document.getElementById('detail')!.innerHTML = '<ul id="f-rates"></ul><p id="f-next"></p>';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const detail = (): HTMLElement => document.getElementById('detail')!;

describe('fiche serveur dans le détail', () => {
  it('fiche complète : notes, TVDB et épisodes servis par la fiche, sans appels séparés', async () => {
    const id = 1401;
    metaReply = () => json(serverSeries(id));
    const m = await ficheModel.fetchFull('tv', String(id), { server: true });
    await ficheSections.fillRatings(m, stateMod.state.token);
    await ficheSections.fillNext(m, stateMod.state.token);

    const p = paths();
    expect(p.filter((x) => x === pathOf(`meta/series/${id}`))).toHaveLength(1);
    expect(p.some((x) => x.startsWith(pathOf('mdblist/')))).toBe(false);
    expect(p.some((x) => x.startsWith(pathOf('tvdb/')))).toBe(false);
    expect(p.some((x) => x === pathOf(`series/${id}/episodes`))).toBe(false);
    // Les épisodes de saison (tmdb/tv/<id>/season/<n>) ne sont plus demandés ; les vidéos de saison (…/videos) restent.
    expect(p.some((x) => new RegExp(`^${pathOf(`tmdb/tv/${id}/season/\\d+`)}$`).test(x))).toBe(false);
    // Le détail TMDB reste nécessaire (bande-annonce, logo, recommandations) : un seul appel.
    expect(p.filter((x) => x === pathOf(`tmdb/tv/${id}`))).toHaveLength(1);

    expect(m.serverMeta).not.toBeNull();
    expect(m.canon.seasons.map((s: any) => s.number)).toEqual([1, 2]);
    expect(m.nEpisodes).toBe(3);
    expect(detail().querySelector('#f-rates')!.innerHTML).toContain('IMDb');
  });

  it('fiche sans épisodes : TVDB pris dans la fiche, épisodes repris par l’ancien appel', async () => {
    const id = 1402;
    metaReply = () => json({ ...serverSeries(id), episodes: null });
    const m = await ficheModel.fetchFull('tv', String(id), { server: true });
    await ficheSections.fillRatings(m, stateMod.state.token);
    await ficheSections.fillNext(m, stateMod.state.token);

    const p = paths();
    expect(p.some((x) => x.startsWith(pathOf('mdblist/')))).toBe(false);
    expect(p.some((x) => x.startsWith(pathOf('tvdb/')))).toBe(false);
    expect(p.filter((x) => x === pathOf(`series/${id}/episodes`))).toHaveLength(1);
    expect(detail().querySelector('#f-next')!.textContent).toContain(util.fmtDate(FICHE_TVDB_NEXT));
  });

  it('fiche en 404 : repli sur les appels séparés (notes, TVDB, épisodes)', async () => {
    const id = 1403;
    metaReply = () => json({ error: 'not_found' }, 404);
    const m = await ficheModel.fetchFull('tv', String(id), { server: true });
    expect(m.serverMeta).toBeNull();
    await ficheSections.fillRatings(m, stateMod.state.token);
    await ficheSections.fillNext(m, stateMod.state.token);

    const p = paths();
    expect(p.filter((x) => x === pathOf(`meta/series/${id}`))).toHaveLength(1);
    expect(p.some((x) => x.startsWith(pathOf('mdblist/tv/')))).toBe(true);
    expect(p.includes(pathOf(`tvdb/series/81189`))).toBe(true);
    expect(p.includes(pathOf(`series/${id}/episodes`))).toBe(true);
    expect(detail().querySelector('#f-rates')!.innerHTML).toContain('IMDb');
    expect(detail().querySelector('#f-next')!.textContent).toContain(util.fmtDate(TVDB_ROUTE_NEXT));
  });

  it.each([
    ['sans titre', (id: number) => ({ v: 1, type: 'series', tmdbId: id, cast: [] })],
    ['version inconnue', (id: number) => ({ ...serverSeries(id), v: 2 })],
  ])('forme inattendue (%s) : repli sur les appels séparés', async (_label, build) => {
    const id = 1405;
    metaReply = () => json(build(id));
    const m = await ficheModel.fetchFull('tv', String(id), { server: true });
    expect(m.serverMeta).toBeNull();
    await ficheSections.fillRatings(m, stateMod.state.token);
    expect(paths().some((x) => x.startsWith(pathOf('mdblist/tv/')))).toBe(true);
  });

  it('304 : le corps gardé est réutilisé, sans nouveau téléchargement', async () => {
    const id = 1404;
    const etag = 'W/"meta-v1"';
    let body: any = serverSeries(id);
    const ifNoneMatches: Array<string | null> = [];
    metaReply = (_u, init) => {
      const inm = new Headers(init?.headers).get('if-none-match');
      ifNoneMatches.push(inm);
      if (inm === etag) return new Response(null, { status: 304 });
      return json(body, 200, { etag });
    };
    // Module neuf : mémoire vide, IndexedDB simulée (ouverte une seule fois par module), sessionStorage vidé.
    vi.resetModules();
    sessionStorage.clear();
    const idb = fakeIndexedDb();
    vi.stubGlobal('indexedDB', idb.factory);
    const first = await (await import('../src/data/lt')).fetchServerMeta('series', id);
    await settle();
    expect(idb.data.size).toBe(1);

    // Le serveur répondrait 304 : le contenu changé côté test ne doit pas remplacer le corps gardé.
    body = { ...body, title: 'Titre modifié' };
    vi.resetModules();
    sessionStorage.clear();
    const again = await (await import('../src/data/lt')).fetchServerMeta('series', id);

    expect(ifNoneMatches).toEqual([null, etag]);
    expect(again).toEqual(first);
    expect(again.title).toBe('Série ' + id);
  });

  it('sans option serveur (fiche de liste) : aucun appel à la fiche serveur', async () => {
    const id = 1407;
    const m = await ficheModel.fetchFull('tv', String(id));
    expect(m.serverMeta).toBeNull();
    const p = paths();
    expect(p.some((x) => x.includes('/lt/meta/'))).toBe(false);
    expect(p.includes(pathOf(`series/${id}/episodes`))).toBe(true);
  });
});

describe('fetchServerMeta', () => {
  it('rejette un identifiant invalide sans appel réseau', async () => {
    await expect(lt.fetchServerMeta('movie', 'abc')).rejects.toThrow();
    expect(urls).toHaveLength(0);
  });

  it('rejette une erreur 404 du serveur', async () => {
    metaReply = () => json({ error: 'service_not_configured' }, 404);
    await expect(lt.fetchServerMeta('movie', 1408)).rejects.toThrow();
    expect(paths()).toEqual([pathOf('meta/movie/1408')]);
  });
});
