// Test de fumée de l'interface portée : rend l'accueil, une fiche, la bibliothèque et les réglages dans jsdom,
// avec un lastAddon simulé (fetch). Aucun navigateur réel.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i, media_type: i % 2 ? 'tv' : 'movie', title: 'Film ' + i, name: 'Série ' + i,
  poster_path: '/p' + i + '.jpg', backdrop_path: '/b' + i + '.jpg', release_date: '2025-01-01', first_air_date: '2025-01-01',
  vote_average: 7.4, vote_count: 500, genre_ids: [28], overview: 'Un synopsis.',
}));

const calls: string[] = [];

function mockFetch(url: string, init?: RequestInit): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: { services: { properties: { tmdbToken: { title: 'Jeton TMDB', description: 'd' } } } } });
  if (u.pathname === '/config/decode') return json({ services: { tmdbToken: { set: true, last4: '…abcd' }, openrouterModel: 'openai/gpt-4o-mini' }, languages: { preferred: ['fr'] }, sources: [], maxResults: 30 });
  if (u.pathname.includes('/lt/tmdb/')) {
    return json({
      results: ITEMS, id: 100, title: 'Film 0', name: 'Série 0', overview: 'Un synopsis assez long pour la fiche.', tagline: 'Slogan',
      poster_path: '/p.jpg', backdrop_path: '/b.jpg', release_date: '2025-01-01', runtime: 120, vote_average: 7.4, genres: [{ id: 28, name: 'Action' }],
      images: { logos: [] }, videos: { results: [] }, credits: { cast: [], crew: [] }, external_ids: { imdb_id: 'tt0100' },
      release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ certification: '12', release_date: '2025-01-01', type: 3 }] }] },
      recommendations: { results: ITEMS.slice(0, 3) }, similar: { results: [] }, seasons: [], 'watch/providers': { results: {} },
    });
  }
  if (u.pathname.includes('/lt/mdblist/')) return json({ ratings: { imdb: 7.9 } });
  if (u.pathname.endsWith('/lt/recommend')) return json({ items: [] });
  if (u.pathname.endsWith('/lt/why')) return json({ text: 'Parce que.' });
  if (u.pathname.endsWith('/lt/tv/facets')) return json({ countries: [{ id: 'FR', name: 'France', count: 3 }, { id: 'CH', count: 1 }], languages: { fr: 3, de: 1 }, categories: [{ id: 'news', label: 'Info', count: 2 }, { id: 'sport', label: 'Sport', count: 1 }] });
  if (u.pathname.endsWith('/lt/tv/channels')) {
    return json([
      { id: 'a', name: 'Chaîne A', logo: '', group: '', cat: '', source: 'free-tv', fast: false, url: 'https://x/a.m3u8', sig: 's1', epgId: '', flaky: false, country: 'FR', languages: [{ code: 'fr', name: 'Français' }], categories: [{ id: 'news', label: 'Info' }], reliability: 'high', alternatives: [{ url: 'https://x/a2.m3u8', sig: 's2' }] },
      { id: 'b', name: 'Chaîne B', logo: '', group: '', cat: '', source: 'iptv-org', fast: false, url: 'https://x/b.m3u8', sig: 's3', epgId: '', flaky: false, country: 'FR', languages: [{ code: 'fr', name: 'Français' }], categories: [{ id: 'sport', label: 'Sport' }], reliability: 'low' },
      { id: 'c', name: 'Kanal C', logo: '', group: '', cat: '', source: 'iptv-org', fast: false, url: 'https://x/c.m3u8', sig: 's4', epgId: '', flaky: false, country: 'DE', languages: [{ code: 'de', name: 'Allemand' }], categories: [] },
    ]);
  }
  if (u.pathname.endsWith('/lt/tv/epg')) return json([]);
  void init;
  return json({ error: 'not_found' }, 404);
}

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, ms / 20));
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_abc-123' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => mockFetch(String(url), init)));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/main.js');
  await settle(300);
});

describe('interface portée', () => {
  it('rend l’accueil à partir de lastAddon avec la config de l’ancienne clé', () => {
    const app = document.getElementById('app')!;
    expect(app.querySelector('.hero')).not.toBeNull();
    expect(app.querySelector('#top10 .top-item')).not.toBeNull();
    expect(app.querySelectorAll('.row-section').length).toBeGreaterThan(3);
    expect(calls.some((c) => c.startsWith('http://localhost:7000/CFG_abc-123/lt/tmdb/trending/all/day'))).toBe(true);
    expect(calls.every((c) => !c.includes('/api/'))).toBe(true);
  });

  it('utilise la région France par défaut', () => {
    expect(calls.some((c) => c.includes('region=FR'))).toBe(true);
  });

  it('ouvre une fiche', async () => {
    location.hash = '#/movie/100';
    await settle(300);
    const detail = document.getElementById('detail')!;
    expect(detail.hidden).toBe(false);
    expect(detail.querySelector('.fiche .f-title')).not.toBeNull();
    expect(detail.querySelector('[data-play]')).not.toBeNull();
  });

  it('ouvre le tiroir Sources avec un message si le titre n’a pas de sources', async () => {
    (document.querySelector('#detail [data-play]') as HTMLElement).click();
    await settle(200);
    expect(document.getElementById('modal')!.hidden).toBe(false);
    expect(document.querySelector('#modal .drawer-title')!.textContent).toBe('Sources');
  });

  it('affiche les réglages lastAddon', async () => {
    document.getElementById('modal-close')!.click();
    location.hash = '#/settings';
    await settle(300);
    const page = document.querySelector('#detail .set-page')!;
    expect(page).not.toBeNull();
    expect(page.querySelector('input[name="base"]')).not.toBeNull();
    const key = page.querySelector('input[name="svc.tmdbToken"]') as HTMLInputElement;
    expect(key.placeholder).toContain('abcd');
    expect(key.value).toBe('');
    expect(page.querySelector('[data-set-theme="teal"]')).not.toBeNull();
    expect((page.querySelector('select[data-set-pref="region"]') as HTMLSelectElement).value).toBe('FR');
  });

  it('n’affiche aucune donnée de démonstration', () => {
    const app = document.getElementById('app')!;
    expect(app.querySelector('#reprendre')).toBeNull();
    expect(app.textContent).not.toMatch(/d[ée]mo/i);
    expect(app.querySelector('#commencer')).not.toBeNull(); // « Pour bien commencer » : aucun signal, donc pas d'IA
    expect(app.querySelector('#ai')).toBeNull();
    expect(calls.some((c) => c.includes('/lt/recommend'))).toBe(false);
  });

  it('TV en direct : filtres pays/langue, facettes, fiabilité', async () => {
    location.hash = '#/tv-live';
    await settle(400);
    const page = document.querySelector('#detail .tv-page')!;
    expect(page).not.toBeNull();
    const form = page.querySelector('#tv-filters') as HTMLFormElement;
    expect((form.elements.namedItem('country') as HTMLSelectElement).value.toUpperCase()).toBe('FR');
    expect((form.elements.namedItem('language') as HTMLSelectElement).value).toBe('fr');
    expect((form.elements.namedItem('reliable') as HTMLInputElement).checked).toBe(true);
    expect(calls.some((c) => c.includes('/lt/tv/channels?') && c.includes('country=FR') && c.includes('language=fr'))).toBe(true);
    const names = Array.from(page.querySelectorAll('.epg-name')).map((n) => n.textContent);
    expect(names).toEqual(['Chaîne A']); // B peu fiable et C allemande sont masquées
    expect(page.querySelector('[data-tvcat="news"]')).not.toBeNull();
  });

  it('lecteur TV : essaie les alternatives avant d’afficher l’erreur', async () => {
    const { tv, perrEl } = await import('../src/ui/tv.js');
    const { failover } = await import('../src/ui/player.js');
    const c = { id: 'z', url: 'https://x/z.m3u8', sig: 's', alternatives: [{ url: 'https://x/z2.m3u8', sig: 's2' }] };
    tv.playToken = 7;
    tv.attempt = 0;
    perrEl.hidden = true;
    failover(c, 7);
    await settle(100);
    expect(tv.attempt).toBe(1);
    expect(perrEl.hidden).toBe(false); // les deux flux ont échoué (jsdom ne lit pas de HLS)
    const solo = { id: 'y', url: 'https://x/y.m3u8', sig: 's', alternatives: [] };
    tv.attempt = 0;
    perrEl.hidden = true;
    failover(solo, 7);
    expect(tv.attempt).toBe(0);
    expect(perrEl.hidden).toBe(false);
  });

  it('affiche la bibliothèque vide', async () => {
    location.hash = '#/library';
    await settle(200);
    expect(document.querySelector('#detail #lib-grid')).not.toBeNull();
  });
});
