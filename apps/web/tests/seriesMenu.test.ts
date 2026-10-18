// Menu contextuel d'une tuile de série et bouton « Marquer toute la série » de la fiche.
// lastAddon (TMDB, canonique, watched) est simulé par fetch ; le userStore est le vrai ServerUserStore branché sur ce faux serveur.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LastAddonError } from '../src/data/errors';

const BASE = 'http://localhost:7000';
const CFG = 'CFG_abc-123';
const PROFILE = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };
const PAST = '2011-01-0';

/** Détail TMDB d'une série avec les saisons données. */
function tvDetail(id: number, seasons: Array<Record<string, unknown>>) {
  return {
    id, name: 'Série ' + id, original_name: 'Série ' + id, overview: 'Un synopsis.', tagline: '', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
    first_air_date: '2010-07-25', last_air_date: '2017-01-15', number_of_seasons: seasons.length, number_of_episodes: 6, status: 'Ended',
    seasons, last_episode_to_air: { season_number: 2, episode_number: 3 }, next_episode_to_air: null, genres: [{ id: 80, name: 'Crime' }],
    external_ids: { imdb_id: 'tt1475582', tvdb_id: 176941 }, images: { logos: [] }, videos: { results: [] },
    credits: { cast: [], crew: [] }, content_ratings: { results: [] }, recommendations: { results: [] }, similar: { results: [] },
    'watch/providers': { results: {} }, networks: [], created_by: [], production_countries: [], spoken_languages: [], origin_country: ['GB'],
  };
}
const BASE_SEASONS = [
  { season_number: 0, episode_count: 1, air_date: '2010-01-01', name: 'Spéciaux' },
  { season_number: 1, episode_count: 3, air_date: '2010-07-25', name: 'Saison 1' },
  { season_number: 2, episode_count: 3, air_date: '2012-01-01', name: 'Saison 2' },
];
const FUTURE_SEASONS = [...BASE_SEASONS, { season_number: 3, episode_count: 4, air_date: '2099-01-01', name: 'Saison 3' }];
/** 12 saisons de 100 épisodes : 1 200 épisodes, de quoi dépasser un lot de 500. */
const LONG_SEASONS = Array.from({ length: 12 }, (_, i) => ({ season_number: i + 1, episode_count: 100, air_date: '2010-01-01', name: 'S' + (i + 1) }));
const SPECIALS_ONLY = [{ season_number: 0, episode_count: 1, air_date: '2010-01-01', name: 'Spéciaux' }];
const LONG_IDS = [3000, 3001];

const episodesOf = (season: number, count: number) => ({
  poster_path: null,
  episodes: Array.from({ length: count }, (_, i) => ({ episode_number: i + 1, season_number: season, name: 'E' + (i + 1), air_date: PAST + (i + 1), still_path: null, runtime: 50, overview: '' })),
});

/** Réponse canonique (TVDB) pour la série 1300 : numérotation de lastAddon. */
const CANON_1300 = {
  source: 'tvdb-aired',
  seasons: [
    { number: 0, name: 'Spéciaux', episodes: [{ number: 1, absolute: 1, name: 'Spécial', airDate: '2010-01-01' }] },
    { number: 1, name: 'Saison 1', episodes: [{ number: 1, absolute: 2, name: 'A', airDate: '2010-07-25' }, { number: 2, absolute: 3, name: 'B', airDate: '2010-08-01' }, { number: 3, absolute: 4, name: 'C', airDate: '2010-08-08' }] },
    { number: 2, name: 'Saison 2', episodes: [{ number: 1, absolute: 5, name: 'D', airDate: '2012-01-01' }, { number: 2, absolute: 6, name: 'E', airDate: '2012-01-08' }, { number: 3, absolute: 7, name: 'F', airDate: '2012-01-15' }] },
  ],
};

const sent: Array<{ method: string; url: string; body: any; status: number }> = [];
/** Écritures « vu » reçues : la n-ième (1 à 3) échoue avec 500 si `failCall` est fixé. */
let watchCalls = 0;
let failCall = 0;

function mockFetch(url: string, init?: RequestInit): Response {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (u.pathname.startsWith('/user/')) {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'PUT' && /\/watched$/.test(u.pathname)) {
      watchCalls += 1;
      const refused = watchCalls === failCall;
      sent.push({ method, url: u.pathname, body, status: refused ? 500 : 204 });
      return refused ? json({ error: 'boom' }, 500) : new Response(null, { status: 204 });
    }
    sent.push({ method, url: u.pathname, body, status: 200 });
    if (method === 'GET' && /\/watched\/series\/\d+$/.test(u.pathname)) return json({ episodes: [] });
    if (method === 'GET' && /\/continue$/.test(u.pathname)) return json({ items: [] });
    if (method === 'GET' && /\/library$/.test(u.pathname)) return json({ items: [] });
    return json({ error: 'not_found' }, 404);
  }
  const lt = '/' + CFG + '/lt/';
  if (!u.pathname.startsWith(lt)) return json({ error: 'not_found' }, 404);
  const p = u.pathname.slice(lt.length);
  if (p.startsWith('tmdb/trending/')) {
    return json({ results: [
      { id: 1234, media_type: 'tv', name: 'Sherlock', first_air_date: '2010-07-25', poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 8.2, genre_ids: [80], overview: 'Un détective.' },
      { id: 2001, media_type: 'tv', name: 'Autre série', first_air_date: '2019-01-01', poster_path: '/a.jpg', backdrop_path: '/ab.jpg', vote_average: 7.1, genre_ids: [18], overview: 'x' },
      { id: 2002, media_type: 'movie', title: 'Un film', release_date: '2019-01-01', poster_path: '/m.jpg', backdrop_path: '/mb.jpg', vote_average: 6.9, genre_ids: [28], overview: 'y' },
    ] });
  }
  const detail = /^tmdb\/tv\/(\d+)$/.exec(p);
  if (detail) {
    const id = Number(detail[1]);
    if (id === 1500) return json({ error: 'upstream' }, 503);
    const seasons = id === 1300 ? FUTURE_SEASONS : LONG_IDS.includes(id) ? LONG_SEASONS : id === 4000 ? SPECIALS_ONLY : BASE_SEASONS;
    return json(tvDetail(id, seasons));
  }
  const season = /^tmdb\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
  if (season) {
    if (season[1] === '1400' && season[2] === '2') return json({ error: 'not_found' }, 404);
    return json(episodesOf(Number(season[2]), LONG_IDS.includes(Number(season[1])) ? 100 : 3));
  }
  const canon = /^series\/(\d+)\/episodes$/.exec(p);
  if (canon) return canon[1] === '1300' ? json(CANON_1300) : json({ error: 'not_found' }, 404);
  if (p.startsWith('tmdb/')) return json({ results: [] });
  return json({ error: 'not_found' }, 404);
}

let ctx: typeof import('../src/ui/ctxmenu.js');
let catalog: typeof import('../src/ui/catalog.js');
let tiles: typeof import('../src/ui/tiles.js');
let homeFilters: typeof import('../src/data/homeFilters');
let userStoreMod: typeof import('../src/data/userStore');
let serverStoreMod: typeof import('../src/data/serverUserStore');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  ctx = await import('../src/ui/ctxmenu.js');
  catalog = await import('../src/ui/catalog.js');
  tiles = await import('../src/ui/tiles.js');
  homeFilters = await import('../src/data/homeFilters');
  userStoreMod = await import('../src/data/userStore');
  serverStoreMod = await import('../src/data/serverUserStore');
  await import('../src/main.js');
  await new Promise((r) => setTimeout(r, 300));
  userStoreMod.setUserStore(new serverStoreMod.ServerUserStore([PROFILE], PROFILE));
});

afterEach(() => {
  sent.length = 0;
  watchCalls = 0;
  failCall = 0;
  vi.restoreAllMocks();
});

const toastText = () => document.getElementById('toast')?.textContent ?? '';
const puts = () => sent.filter((s) => s.method === 'PUT');

/** Une tuile de grille : balisage réel (tileCard) et enrichissement réel (infoStore), comme sur l'accueil. */
async function gridTile(id: number, name = 'Série'): Promise<HTMLElement> {
  const it = catalog.register(catalog.toItem({ id, name, first_air_date: '2010-07-25', poster_path: '/p.jpg', vote_average: 8 }, 'tv'));
  await tiles.enrich(it, false);
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = tiles.tileCard(it, {});
  document.getElementById('app')!.appendChild(row);
  return row.querySelector('[data-tile]') as HTMLElement;
}

/** Lance l'entrée « vu » du menu contextuel, comme le clic : renvoie le libellé et l'exception éventuelle. */
async function clickSeen(el: HTMLElement): Promise<{ label: string; err: unknown }> {
  const t = ctx.ctxTarget(el)!;
  const item = ctx.ctxItems(t).find((i) => i.id === 'seen')!;
  let err: unknown = null;
  try { await item.run(); } catch (e) { err = e; }
  return { label: item.label, err };
}

describe('série : menu contextuel de la tuile', () => {
  it('accueil rendu : Sherlock en vedette et tuile de grille reconnue', async () => {
    const el = await gridTile(1234, 'Sherlock');
    expect(ctx.ctxTarget(el)).toMatchObject({ kind: 'title', key: 'tv:1234' });
    expect(document.querySelector('.hero-slide[data-slide-key="tv:1234"]')).not.toBeNull();
  });

  it('« Marquer la série comme vue » : pas d’exception, épisodes envoyés, série marquée vue', async () => {
    const el = await gridTile(1234, 'Sherlock');
    const r = await clickSeen(el);
    expect(r.label).toBe('Marquer la série comme vue');
    expect(r.err).toBeNull();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.episodes).toHaveLength(6);
    expect(homeFilters.currentFilters().completed).toContain('tv:1234');
  });

  it('« Marquer la série comme non vue » depuis la tuile : pas d’exception, série retirée des vues', async () => {
    const el = await gridTile(1234, 'Sherlock');
    const r = await clickSeen(el);
    expect(r.label).toBe('Marquer la série comme non vue');
    expect(r.err).toBeNull();
    expect(puts()[0].body.watched).toBe(false);
    expect(homeFilters.currentFilters().completed).not.toContain('tv:1234');
  });

  it('série canonique (lastAddon) : la saison future n’est pas marquée', async () => {
    const el = await gridTile(1300, 'Canonique');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(puts()[0].body.episodes).toHaveLength(6);
  });

  it('saison introuvable (404) : les autres saisons sont marquées, sans exception', async () => {
    const el = await gridTile(1400, 'Trou');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(puts()[0].body.episodes).toHaveLength(3);
  });

  it('série longue (1 200 épisodes) : écritures en lots de 500, puis série marquée', async () => {
    const el = await gridTile(3000, 'Longue');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(puts().map((p) => p.body.episodes.length)).toEqual([500, 500, 200]);
    expect(homeFilters.currentFilters().completed).toContain('tv:3000');
  });

  it('série longue : un lot refusé annule les lots déjà acceptés et restaure l’affichage', async () => {
    failCall = 2;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const el = await gridTile(3001, 'Longue refusée');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(toastText()).toBe('Enregistrement impossible : modification annulée');
    // 1er lot accepté (vu), 2e refusé, puis annulation du 1er lot (non vu).
    expect(puts().map((p) => [p.body.episodes.length, p.body.watched, p.status])).toEqual([[500, true, 204], [500, true, 500], [500, false, 204]]);
    expect(homeFilters.currentFilters().completed).not.toContain('tv:3001');
  });

  it('série sans épisode diffusé connu : message explicite, rien n’est écrit', async () => {
    const el = await gridTile(4000, 'Sans épisodes');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(puts()).toHaveLength(0);
    expect(toastText()).toBe('Impossible de marquer la série : aucun épisode diffusé connu pour cette série');
    expect(homeFilters.currentFilters().completed).not.toContain('tv:4000');
  });

  it('TMDB indisponible (503) : toast avec la raison, journal console, aucune écriture', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const el = await gridTile(1500, 'Indispo');
    const r = await clickSeen(el);
    expect(r.err).toBeNull();
    expect(toastText()).toBe('Impossible de marquer la série : lastAddon a répondu HTTP 503 (upstream)');
    expect(puts()).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('tv:1500'), expect.any(LastAddonError));
  });

  it('fiche : « Marquer toute la série comme vue » du menu d’épisodes', async () => {
    location.hash = '#/tv/1234';
    await new Promise((r) => setTimeout(r, 500));
    const btn = document.querySelector('#detail [data-series-watch="1"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    await new Promise((r) => setTimeout(r, 300));
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.episodes).toHaveLength(6);
    expect(puts()[0].body.watched).toBe(true);
  });

  it('fiche : « Marquer toute la série comme non vue » du menu d’épisodes', async () => {
    const btn = document.querySelector('#detail [data-series-watch="0"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    await new Promise((r) => setTimeout(r, 300));
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body.watched).toBe(false);
  });
});

describe('libellés d’échec', () => {
  it('raison lisible selon l’erreur (HTTP, réseau, limite, inconnue)', () => {
    expect(ctx.reasonOf(new LastAddonError('http', 'x', { status: 503, code: 'upstream' }))).toBe('lastAddon a répondu HTTP 503 (upstream)');
    expect(ctx.reasonOf(new LastAddonError('http', 'x', { status: 429 }))).toBe('trop de requêtes, réessaie dans un instant');
    expect(ctx.reasonOf(new LastAddonError('network', 'x'))).toBe('lastAddon est injoignable (réseau)');
    expect(ctx.reasonOf(new Error('boom'))).toBe('boom');
    expect(ctx.reasonOf(undefined)).toBe('erreur inconnue');
  });
});
