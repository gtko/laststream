import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Top 10 de l'accueil servi par lastAddon (route /lt/top10) : « Top 10 aujourd'hui » (films et séries mêlés, fenêtre
 * `day`), rangs des tuiles (listes de la semaine, puis du jour). Aucun contrôle de disponibilité côté client sur ces listes.
 */

const BASE = 'http://localhost:7000';
const TODAY = new Date().toISOString().slice(0, 10);

/** Titre de la tendance du jour (films et séries mêlés, `media_type` donné par TMDB). */
const dayEntry = (id: number, media_type: 'movie' | 'tv') => ({
  id,
  media_type,
  title: `Titre ${id}`,
  name: `Titre ${id}`,
  release_date: TODAY,
  first_air_date: TODAY,
  poster_path: `/d${id}.jpg`,
  backdrop_path: `/db${id}.jpg`,
  vote_count: 500,
  genre_ids: [18],
});

/** Une série de la semaine (films et séries listés séparément). */
const weekEntry = (id: number, media_type: 'movie' | 'tv') => ({ ...dayEntry(id, media_type), release_date: '2020-01-01', first_air_date: '2020-01-01' });

/** Tendance du jour : 653 (série, aussi dans le Top 10 de la semaine) puis 700 à 710 en alternance. */
const DAY = [dayEntry(653, 'tv'), ...Array.from({ length: 11 }, (_, i) => dayEntry(700 + i, i % 2 ? 'tv' : 'movie'))];
const WEEK_MOVIES = Array.from({ length: 10 }, (_, i) => weekEntry(600 + i, 'movie'));
const WEEK_TV = Array.from({ length: 10 }, (_, i) => weekEntry(650 + i, 'tv'));

const calls: string[] = [];

function mockFetch(url: string): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  const page = Number(u.searchParams.get('page') ?? '1');
  if (u.pathname === '/config/schema') return json({ properties: {} });
  if (u.pathname === '/config/decode') return json({ services: {}, languages: { preferred: ['fr'] }, sources: [], maxResults: 30 });
  if (u.pathname.endsWith('/lt/top10/all')) {
    const results = page === 1 ? DAY.slice(0, 10) : [];
    return json({ page, raw: DAY.length, results });
  }
  if (u.pathname.endsWith('/lt/top10/movie')) return json({ page, raw: WEEK_MOVIES.length, results: page === 1 ? WEEK_MOVIES : [] });
  if (u.pathname.endsWith('/lt/top10/tv')) return json({ page, raw: WEEK_TV.length, results: page === 1 ? WEEK_TV : [] });
  // Tendances de la semaine (« Pour bien commencer », héros) : vides, pour isoler les listes testées.
  if (u.pathname.includes('/lt/tmdb/trending/')) return json({ page, results: [] });
  return json({ error: 'not_found' }, 404);
}

describe('Top 10 de l’accueil : listes servies par lastAddon', () => {
  let home: Awaited<ReturnType<typeof import('../src/ui/home.js')['loadHome']>>;
  let state: typeof import('../src/ui/state.js')['state'];

  beforeAll(async () => {
    // Les modules de l'interface lisent le squelette HTML à l'import : même squelette que le test de fumée.
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: 'CFG_top10' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
    const { loadHome } = await import('../src/ui/home.js');
    state = (await import('../src/ui/state.js')).state;
    home = await loadHome();
  });

  it('« Top 10 aujourd’hui » vient de /lt/top10/all?window=day, dans l’ordre du serveur', () => {
    expect(calls.some((c) => c.startsWith(`${BASE}/CFG_top10/lt/top10/all`) && c.includes('window=day'))).toBe(true);
    expect(calls.some((c) => c.includes('/lt/tmdb/trending/all/day'))).toBe(false);
    expect(home.rows.top!.map((it: { type: string; id: number }) => `${it.type}:${it.id}`)).toEqual(DAY.slice(0, 10).map((d) => `${d.media_type}:${d.id}`));
  });

  it('aucun contrôle de disponibilité côté client : pas de détail de film pour les titres des listes', () => {
    expect(calls.filter((c) => c.includes('/lt/tmdb/movie/') || c.includes('/lt/tmdb/tv/'))).toHaveLength(0);
  });

  it('badges : rang de la liste de la semaine d’abord, puis rang du jour pour les autres titres', () => {
    expect(state.topBadge.get('tv:653')).toBe(4); // 4e des séries de la semaine (et 1er du jour)
    expect(state.topBadge.get('movie:600')).toBe(1);
    expect(state.topBadge.get('movie:604')).toBe(5);
    expect(state.topBadge.get('movie:700')).toBe(2); // 2e du jour, absent de la semaine
    expect(state.topBadge.has('movie:710')).toBe(false); // au-delà du dixième du jour
  });

  it('l’accueil ne retient que le Top 10 du jour (titres déjà affichés), pas ceux de la semaine', () => {
    expect([...state.top10.keys()]).toEqual(DAY.slice(0, 10).map((d) => `${d.media_type}:${d.id}`));
    expect(state.top10.has('movie:600')).toBe(false);
  });

  it('les rangées de la semaine sont servies par la même route (films et séries)', () => {
    expect(calls.some((c) => c.includes('/lt/top10/movie'))).toBe(true);
    expect(calls.some((c) => c.includes('/lt/top10/tv'))).toBe(true);
  });
});
