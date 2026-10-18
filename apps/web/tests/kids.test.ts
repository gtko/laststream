// Accueil enfant dans jsdom : session serveur simulée avec un profil enfant (10 ans), TMDB simulé.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const KID = { id: 'kid1', name: 'Léo', avatarColor: '#19c3a6', isKid: true, kidMaxAge: 10, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };

// 100 : famille, classification 10, bande-annonce. 101 : animation mais classée 16. 102 : action classée 10 (genre refusé).
const DETAILS: Record<string, { cert: string; genres: number[]; trailer?: boolean }> = {
  '100': { cert: '10', genres: [10751], trailer: true },
  '101': { cert: '16', genres: [16] },
  '102': { cert: '10', genres: [28] },
};
const results = ['100', '101', '102'].map((id) => ({
  id: Number(id), title: 'Titre ' + id, name: 'Titre ' + id, poster_path: '/p' + id + '.jpg', backdrop_path: '/b' + id + '.jpg',
  genre_ids: DETAILS[id].genres, vote_average: 7, release_date: '2025-01-01', first_air_date: '2025-01-01', overview: 'Un synopsis.',
}));

function mockFetch(url: string, init?: RequestInit): Response {
  calls.push(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const u = new URL(url);
  if (u.pathname === '/user/me') return json({ account: { id: 'a', username: 'greg' } });
  if (u.pathname === '/user/profiles') return json({ profiles: [KID] });
  if (u.pathname.endsWith('/library')) return json({ items: [] });
  if (u.pathname.endsWith('/continue')) return json({ items: [] });
  if (u.pathname.endsWith('/settings')) return json({ settings: init?.method === 'PUT' ? {} : { region: 'FR' } });
  const m = /\/lt\/tmdb\/(movie|tv)\/(\d+)$/.exec(u.pathname);
  if (m) {
    const d = DETAILS[m[2]] ?? DETAILS['102'];
    return json({
      id: Number(m[2]), title: 'Titre ' + m[2], name: 'Titre ' + m[2], overview: 'Un synopsis.', genres: d.genres.map((id) => ({ id })),
      poster_path: '/p.jpg', backdrop_path: '/b.jpg', images: { logos: [] }, external_ids: {},
      videos: { results: d.trailer ? [{ site: 'YouTube', key: 'abc', type: 'Trailer', iso_639_1: 'fr' }] : [] },
      release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ certification: d.cert }] }] },
      content_ratings: { results: [{ iso_3166_1: 'FR', rating: d.cert }] }, 'watch/providers': { results: {} }, runtime: 90,
    });
  }
  if (u.pathname.includes('/lt/tmdb/discover/')) return json({ results });
  if (u.pathname.includes('/lt/tmdb/watch/providers/')) return json({ results: [{ provider_id: 337, provider_name: 'Disney Plus', logo_path: '/d.png', display_priority: 1 }] });
  if (u.pathname.includes('/lt/mdblist/')) return json({ ratings: {} });
  if (u.pathname.includes('/lt/tmdb/')) return json({ results });
  return json({ error: 'not_found' }, 404);
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
  localStorage.setItem('laststream.session', JSON.stringify({ token: 'T'.repeat(30), expiresAt: new Date(Date.now() + 1e10).toISOString(), username: 'greg', profileId: 'kid1', profileTokens: {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/main.js');
  await new Promise((r) => setTimeout(r, 600));
});

describe('accueil du profil enfant', () => {
  it('construit l’accueil jeunesse avec ses rangées', () => {
    expect(document.body.classList.contains('kid-mode')).toBe(true);
    const app = document.getElementById('app')!;
    expect(app.querySelector('.kid-hello')!.textContent).toBe('Salut Léo !');
    ['dessins', 'famille', 'series', 'disney', 'anime', 'nouveautes'].forEach((id) => expect(app.querySelector('#' + id)).not.toBeNull());
    expect(app.querySelector('#top10')).toBeNull();
    expect(app.querySelector('#ai')).toBeNull();
    expect(app.querySelector('.nav [data-tvlive]')).toBeNull(); // TV jeunesse désactivée par défaut
  });

  it('demande à TMDB la certification du pays et les genres jeunesse', () => {
    const disc = calls.filter((c) => c.includes('/lt/tmdb/discover/movie') && c.includes('with_companies'));
    expect(disc.length).toBeGreaterThan(0);
    const q = new URL(disc[0]).searchParams;
    expect(q.get('certification_country')).toBe('FR');
    expect(q.get('certification.lte')).toBe('10');
    expect(q.get('with_genres')).toBe('16|10751');
    expect(q.get('region')).toBe('FR');
    const tvq = new URL(calls.find((c) => c.includes('/lt/tmdb/discover/tv') && c.includes('with_original_language=ja'))!).searchParams;
    expect(tvq.get('with_genres')).toBe('16');
  });

  it('ne garde que les titres autorisés (classification et genre) et un héros avec bande-annonce', () => {
    const app = document.getElementById('app')!;
    const keys = Array.from(app.querySelectorAll('#famille [data-tile]')).map((e) => (e as HTMLElement).dataset.tile);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k!.endsWith(':100'))).toBe(true); // 101 (classé 16) et 102 (action) retirés
    expect(app.querySelector('#famille [data-tile][data-kid="ok"]')).not.toBeNull();
    const hero = app.querySelector('.hero')!;
    expect(hero.querySelector('[data-trailer]')).not.toBeNull();
    expect(hero.querySelector('.eyebrow')!.textContent).toBe('Pour toi, Léo');
  });

  it('refuse Réglages et la recherche filtre les genres', async () => {
    const { parseRoute } = await import('../src/ui/router.js');
    location.hash = '#/settings';
    expect(parseRoute()).toBeNull();
    location.hash = '#/browse/dessins';
    expect(parseRoute()).toEqual({ kind: 'browse', id: 'dessins' });
    const { filterResults } = await import('../src/ui/search.js');
    const out = filterResults([
      { media_type: 'movie', poster_path: '/a', genre_ids: [16] },
      { media_type: 'movie', poster_path: '/b', genre_ids: [28] },
      { media_type: 'person', poster_path: '/c' },
    ], true);
    expect(out).toHaveLength(1);
  });
});
