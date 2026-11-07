// Onglet « Vus » de la bibliothèque, rendu dans le DOM : un film vu hors de « Ma liste », une série partiellement vue,
// tri récent, et disparition après « marquer non vu ». TMDB et lastAddon sont simulés par fetch.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const BASE = 'http://localhost:7000';
const CFG = 'CFG_views';
const PROFILE = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Détails TMDB simulés : un film (603) et une série de 40 épisodes (1396). */
const TMDB: Record<string, unknown> = {
  'movie/603': { id: 603, title: 'Matrix', release_date: '1999-03-31', poster_path: '/m.jpg', backdrop_path: '/mb.jpg', overview: '' },
  'tv/1396': { id: 1396, name: 'Breaking', first_air_date: '2008-01-20', poster_path: '/b.jpg', backdrop_path: '/bb.jpg', overview: '', number_of_episodes: 40 },
};

/** Historique du faux serveur ; modifiable par les tests. */
const history = [
  { type: 'series', tmdbId: 1396, imdbId: null, watched: 12, lastWatchedAt: '2026-01-03T10:00:00.000Z' },
  { type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: '2026-01-01T10:00:00.000Z' },
];

function mockFetch(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const lt = '/' + CFG + '/lt/';
  if (u.pathname.startsWith(lt)) {
    const p = u.pathname.slice(lt.length).replace(/^tmdb\//, '');
    return TMDB[p] ? json(TMDB[p]) : json({ error: 'not_found' }, 404);
  }
  const user = '/user/profiles/' + PROFILE.id;
  if (!u.pathname.startsWith(user)) return json({ error: 'not_found' }, 404);
  const p = u.pathname.slice(user.length);
  if (method === 'GET' && (p === '/library' || p === '/continue')) return json(p === '/library' ? { items: [] } : { items: [] });
  if (method === 'GET' && p === '/watched') return json({ items: history });
  if (method === 'GET' && (p === '/follows' || p === '/ratings')) return json({ error: 'not_found' }, 404);
  if (method === 'PUT' && p === '/watched') return new Response(null, { status: 204 });
  if (method === 'GET' && p === '/watched/movie/603') return json({ movie: false });
  if (method === 'GET' && p === '/watched/series/1396') return json({ episodes: [] });
  return json({ error: 'not_found' }, 404);
}

let userStoreMod: typeof import('../src/data/userStore');
let libraryMod: typeof import('../src/ui/library.js');
let stateMod: typeof import('../src/ui/state.js');

const grid = (): HTMLElement => document.getElementById('lib-grid') as HTMLElement;
const tiles = (): string[] => [...grid().querySelectorAll<HTMLElement>('[data-tile]')].map((el) => el.dataset.tile ?? '');

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  // Importé après le faux fetch et le DOM : library.js lit #detail au chargement.
  libraryMod = await import('../src/ui/library.js');
  stateMod = await import('../src/ui/state.js');
  userStoreMod = await import('../src/data/userStore');
  const { ServerUserStore } = await import('../src/data/serverUserStore');
  const store = new ServerUserStore([PROFILE], PROFILE);
  await store.hydrate();
  userStoreMod.setUserStore(store);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('bibliothèque : onglet « Vus »', () => {
  it('affiche les films et séries vus hors « Ma liste », triés par visionnage récent, avec la progression des séries', async () => {
    libraryMod.setLibMode('watched');
    await vi.waitFor(() => expect(tiles()).toHaveLength(2));
    // Le plus récemment vu d'abord : la série (3 janvier) avant le film (1er janvier).
    expect(tiles()).toEqual(['tv:1396', 'movie:603']);
    const series = grid().querySelector<HTMLElement>('[data-tile="tv:1396"]')!;
    expect(series.querySelector('.t-meta')?.textContent).toContain('12/40 épisodes vus');
    expect(series.querySelector('.progress span')?.getAttribute('style')).toContain('width:30%');
    expect(grid().querySelector('[data-tile="movie:603"] .t-watched')).not.toBeNull();
    expect(userStoreMod.userStore.inLibrary('movie:603')).toBe(false);
    expect(document.querySelector('.svc-eyebrow')?.textContent).toBe('2 titres vus');
    expect(document.querySelector('[data-libm="watched"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(stateMod.state.libView.sort).toBe('recent');
  });

  it('marquer non vu : le titre disparaît de l’onglet', async () => {
    await userStoreMod.userStore.setWatched('movie:603', null, false);
    await vi.waitFor(() => expect(tiles()).toEqual(['tv:1396']));
    expect(document.querySelector('.svc-eyebrow')?.textContent).toBe('1 titre vu');
  });
});
