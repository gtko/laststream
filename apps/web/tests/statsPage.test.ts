// Page « Statistiques » (#/stats) rendue dans le DOM : données serveur et TMDB simulées par fetch, état vide, historique local,
// cache des fiches, et branchement des entrées de menu (profil, onglet mobile) et de la route.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'http://localhost:7000';
const CFG = 'CFG_stats';
const PROFILE = { id: 'p1', name: 'Greg', avatarColor: '#3b82f6', avatar: null, isKid: false, kidMaxAge: null, hasPin: false, allowedCatalogs: [] };
const KID = { id: 'k1', name: 'Léo', avatarColor: '#19c3a6', avatar: null, isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [] };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fiches TMDB simulées (détail + crédits). Un film de 136 min, une série de 62 épisodes de 47 min. */
const TMDB: Record<string, unknown> = {
  'movie/603': {
    id: 603, title: 'Matrix', release_date: '1999-03-31', poster_path: '/m.jpg', backdrop_path: '/mb.jpg', overview: '', runtime: 136,
    genres: [{ id: 878, name: 'Science-fiction' }, { id: 28, name: 'Action' }],
    credits: { cast: [{ id: 6384, name: 'Keanu Reeves' }], crew: [{ id: 9340, name: 'Lana Wachowski', job: 'Director' }] },
  },
  'tv/1396': {
    id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/b.jpg', backdrop_path: '/bb.jpg', overview: '',
    number_of_episodes: 62, episode_run_time: [47], genres: [{ id: 18, name: 'Drame' }],
    created_by: [{ id: 66633, name: 'Vince Gilligan' }], credits: { cast: [{ id: 17419, name: 'Bryan Cranston' }], crew: [] },
  },
};

/** Lectures du profil : 12 épisodes de la série (dernière lecture un samedi soir, heure locale) et le film de la veille. */
const SAT = new Date(2026, 9, 17, 20, 0).toISOString();
const FRI = new Date(2026, 9, 16, 10, 0).toISOString();
let history: Array<{ type: 'movie' | 'series'; tmdbId: number; imdbId: null; watched: number; lastWatchedAt: string }> = [
  { type: 'series', tmdbId: 1396, imdbId: null, watched: 12, lastWatchedAt: SAT },
  { type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: FRI },
];

let tmdbCalls = 0;

function mockFetch(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const lt = '/' + CFG + '/lt/';
  if (u.pathname.startsWith(lt)) {
    const p = u.pathname.slice(lt.length).replace(/^tmdb\//, '');
    if (p.startsWith('movie/') || p.startsWith('tv/')) tmdbCalls++;
    return TMDB[p] ? json(TMDB[p]) : json({ error: 'not_found' }, 404);
  }
  const user = '/user/profiles/' + PROFILE.id;
  if (!u.pathname.startsWith(user)) return json({ error: 'not_found' }, 404);
  const p = u.pathname.slice(user.length);
  if (method === 'GET' && (p === '/library' || p === '/continue')) return json({ items: [] });
  if (method === 'GET' && p === '/watched') return json({ items: history });
  if (method === 'GET' && (p === '/follows' || p === '/ratings')) return json({ error: 'not_found' }, 404);
  if (method === 'PUT' && p === '/watched') return new Response(null, { status: 204 });
  return json({ error: 'not_found' }, 404);
}

let statsMod: typeof import('../src/ui/stats.js');
let userStoreMod: typeof import('../src/data/userStore');
let serverMod: typeof import('../src/data/serverUserStore');
let transportMod: typeof import('../src/data/transport');

const page = (): HTMLElement => document.getElementById('stats-body') as HTMLElement;
const cards = (): Record<string, string> => Object.fromEntries(
  [...document.querySelectorAll<HTMLElement>('.stat-card')].map((c) => [c.querySelector('.stat-k')?.textContent ?? '', c.querySelector('.stat-v')?.textContent ?? '']),
);
const panelOf = (title: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('.stats-panel')].find((p) => p.querySelector('h2')?.textContent === title);

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  // Date figée (dimanche 19 octobre 2026, midi) : la série de jours et les mois sont déterministes.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 19, 12, 0) });
  statsMod = await import('../src/ui/stats.js');
  userStoreMod = await import('../src/data/userStore');
  serverMod = await import('../src/data/serverUserStore');
  transportMod = await import('../src/data/transport');
  const store = new serverMod.ServerUserStore([PROFILE], PROFILE);
  await store.hydrate();
  userStoreMod.setUserStore(store);
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.removeItem('laststream.stats.meta');
});

describe('page Statistiques : chiffres et graphiques', () => {
  it('affiche les cartes de chiffres à partir de l’historique et des fiches TMDB', async () => {
    await statsMod.showStats();
    expect(document.querySelector('#stats-title')?.textContent).toBe('Statistiques');
    expect(document.title).toBe('Statistiques · Laststream');
    const c = cards();
    expect(c['Films vus']).toBe('1');
    expect(c['Épisodes vus']).toBe('12');
    expect(c['Séries en cours']).toBe('1');
    expect(c['Séries terminées']).toBe('0');
    expect(c['Titres notés']).toBe('0');
    // 136 min (film) + 12 × 47 min (série) = 700 min = 11 h 40 ; tout est détaillé, rien d’estimé.
    expect(c['Temps regardé']).toBe('11 h 40');
    expect(document.querySelector('.stat-card .stat-s')?.textContent).toBe('d’après les durées TMDB');
  });

  it('dessine les graphiques SVG : 12 mois, jours de la semaine, genres, décennies', async () => {
    await statsMod.showStats();
    const svgs = [...page().querySelectorAll<SVGElement>('svg.stats-svg')];
    expect(svgs).toHaveLength(4);
    const months = page().querySelector('svg[aria-label^="Heures regardées par mois"]')!;
    expect(months.querySelectorAll('text:not(.val)')).toHaveLength(12);
    expect(months.querySelectorAll('rect.bar')).toHaveLength(1); // une seule lecture datée en octobre
    const rhythm = panelOf('Jour et moment préférés')!;
    expect(rhythm.textContent).toContain('Jour préféré : Samedi');
    expect(rhythm.textContent).toContain('Moment préféré : soirée');
    const genres = panelOf('Genres préférés')!;
    expect(genres.textContent).toContain('Drame');
    expect(genres.textContent).toContain('Science-fiction');
    const decades = panelOf('Décennies de sortie')!;
    expect(decades.querySelectorAll('rect.bar')).toHaveLength(2); // 1990 et 2000
  });

  it('liste les acteurs et réalisateurs, les repères et la note de calcul', async () => {
    await statsMod.showStats();
    const people = panelOf('Acteurs et réalisateurs les plus vus')!;
    for (const name of ['Bryan Cranston', 'Keanu Reeves', 'Lana Wachowski', 'Vince Gilligan']) expect(people.textContent).toContain(name);
    expect(people.textContent).toContain('Réalisateur');
    const repères = panelOf('Repères')!;
    expect(repères.querySelector('dd')?.textContent).toContain('aucune en cours');
    expect(repères.textContent).toContain('record : 2 jours');
    expect(repères.textContent).toContain('Breaking Bad');
    expect(repères.textContent).toContain('12/62 épisodes vus');
    expect(page().querySelector('.stats-foot')?.textContent).toContain('Calcul sur 2 titres sur 2');
  });

  it('une seconde ouverture ne refait pas les appels TMDB : les fiches sont gardées dans le navigateur', async () => {
    transportMod.clearCache();
    const start = tmdbCalls;
    await statsMod.showStats();
    expect(tmdbCalls - start).toBe(2); // film + série, une fois chacun
    expect(Object.keys(JSON.parse(localStorage.getItem('laststream.stats.meta') ?? '{}')).sort()).toEqual(['movie:603', 'tv:1396']);
    transportMod.clearCache(); // vide le cache mémoire et de session : seul le cache des fiches reste
    const mid = tmdbCalls;
    await statsMod.showStats();
    expect(tmdbCalls).toBe(mid);
    expect(cards()['Films vus']).toBe('1');
  });
});

describe('page Statistiques : états particuliers', () => {
  it('aucun titre vu : état vide, sans cartes ni graphiques', async () => {
    const empty = new serverMod.ServerUserStore([PROFILE], PROFILE);
    history = [];
    await empty.hydrate();
    userStoreMod.setUserStore(empty);
    await statsMod.showStats();
    expect(page().querySelector('.stats-empty-t')?.textContent).toBe('Pas encore de statistiques');
    expect(page().querySelector('.stats-empty a')?.getAttribute('href')).toBe('#/');
    expect(document.querySelectorAll('.stat-card')).toHaveLength(0);
    expect(document.querySelectorAll('svg.stats-svg')).toHaveLength(0);
    history = [
      { type: 'series', tmdbId: 1396, imdbId: null, watched: 12, lastWatchedAt: SAT },
      { type: 'movie', tmdbId: 603, imdbId: null, watched: 1, lastWatchedAt: FRI },
    ];
  });

  it('historique de ce téléphone (sans dates) : chiffres là, graphiques datés remplacés par une explication', async () => {
    localStorage.setItem('ls_seen', JSON.stringify(['movie:603', 'tv:1396:1:1', 'tv:1396:1:2']));
    userStoreMod.setUserStore(new userStoreMod.LocalUserStore());
    await statsMod.showStats();
    const c = cards();
    expect(c['Films vus']).toBe('1');
    expect(c['Épisodes vus']).toBe('2');
    expect(panelOf('Heures par mois')!.textContent).toContain('Pas de dates de visionnage sur cet appareil');
    expect(panelOf('Jour et moment préférés')!.textContent).toContain('Disponible quand');
    expect(panelOf('Repères')!.textContent).toContain('non disponible sur cet appareil');
    expect(panelOf('Genres préférés')!.querySelector('svg')).not.toBeNull();
    localStorage.removeItem('ls_seen');
    const store = new serverMod.ServerUserStore([PROFILE], PROFILE);
    await store.hydrate();
    userStoreMod.setUserStore(store);
  });
});

describe('branchement des entrées : menu du profil, onglet mobile, route', () => {
  it('le menu du profil ouvre #/stats ; un profil enfant ne voit pas l’entrée', async () => {
    const { headerA } = await import('../src/ui/home.js');
    const { auth } = await import('../src/data/auth');
    expect(headerA()).toContain('<a href="#/stats" data-go>');
    auth.status = 'ready';
    auth.profile = KID as unknown as typeof auth.profile;
    expect(headerA()).not.toContain('#/stats');
    auth.status = 'local';
    auth.profile = null;
  });

  it('l’onglet « Stats » mène à #/stats pour un adulte, pas pour un enfant', async () => {
    const { tabHref, tabData } = await import('../src/ui/home.js');
    const { auth } = await import('../src/data/auth');
    expect(tabHref('Stats')).toBe('#/stats');
    expect(tabData('Stats')).toBe(' data-go');
    auth.status = 'ready';
    auth.profile = KID as unknown as typeof auth.profile;
    expect(tabHref('Stats')).toBe('#/');
    expect(tabData('Stats')).toBe(' data-noop');
    auth.status = 'local';
    auth.profile = null;
  });

  it('la route #/stats est reconnue ; un profil enfant ne l’ouvre pas', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    const { auth } = await import('../src/data/auth');
    location.hash = '#/stats';
    expect(parseRoute()).toEqual({ kind: 'stats' });
    auth.status = 'ready';
    auth.profile = KID as unknown as typeof auth.profile;
    expect(parseRoute()).toBeNull();
    auth.status = 'local';
    auth.profile = null;
    location.hash = '';
  });
});
