// Test de fumée de l'interface portée : rend l'accueil, une fiche, la bibliothèque et les réglages dans jsdom,
// avec un lastAddon simulé (fetch). Aucun navigateur réel.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// jsdom n'annonce aucun codec : on se fait passer pour Chromium (H.264 lu), sans quoi toute source AVC est jugée illisible (ODY-189).
vi.stubGlobal('chrome', {});

const ITEMS = Array.from({ length: 40 }, (_, i) => ({
  id: 100 + i, media_type: i % 2 ? 'tv' : 'movie', title: 'Film ' + i, name: 'Série ' + i,
  poster_path: '/p' + i + '.jpg', backdrop_path: '/b' + i + '.jpg', release_date: '2025-01-01', first_air_date: '2025-01-01',
  vote_average: 7.4, vote_count: 500, genre_ids: [28], overview: 'Un synopsis.',
}));

const calls: string[] = [];
const recCalls: string[] = [];

function mockFetch(url: string, init?: RequestInit): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  if (u.pathname === '/config/schema') return json({ properties: { services: { properties: { tmdbToken: { title: 'Jeton TMDB', description: 'd' } } } } });
  if (u.pathname === '/config/decode') return json({ services: { tmdbToken: { set: true, last4: '…abcd' }, openrouterModel: 'openai/gpt-4o-mini' }, languages: { preferred: ['fr'] }, sources: [], maxResults: 30 });
  const cin = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  if (u.pathname.endsWith('/lt/tmdb/movie/now_playing')) {
    return json({ results: Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, title: 'Salle ' + i, poster_path: '/c' + i + '.jpg', backdrop_path: '/cb.jpg', release_date: cin, vote_average: 7, genre_ids: [28] })) });
  }
  const salle = /\/lt\/tmdb\/movie\/(5\d\d)$/.exec(u.pathname);
  if (salle) {
    return json({ id: Number(salle[1]), title: 'Salle ' + salle[1], overview: 'Au cinéma.', poster_path: '/c.jpg', backdrop_path: '/cb.jpg', release_date: cin, genres: [{ id: 28, name: 'Action' }],
      images: { logos: [] }, videos: { results: [] }, credits: { cast: [], crew: [] }, external_ids: {}, 'watch/providers': { results: { FR: {} } },
      release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 3, release_date: cin }] }] } });
  }
  const bare = /\/lt\/tmdb\/movie\/(80\d)(\/images)?$/.exec(u.pathname);
  if (bare) {
    if (bare[2]) return json({ posters: bare[1] === '801' ? [{ file_path: '/found.jpg' }] : [], backdrops: [] });
    return json({ id: Number(bare[1]), title: 'Obscur ' + bare[1], poster_path: null, backdrop_path: null, seasons: [] });
  }
  const canon = /\/lt\/series\/(\d+)\/episodes$/.exec(u.pathname);
  if (canon) {
    if (canon[1] !== '102') return json({ error: 'not_found' }, 404); // les autres séries : repli sur les saisons TMDB
    const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    return json({ source: 'tvdb-aired', seasons: [
      { number: 1, name: 'Saison 1', episodes: [
        { number: 1, absolute: 1, name: 'Début', airDate: '2021-01-01', runtime: 24, still: 'https://img.example/s1e1.jpg' },
        { number: 2, absolute: 2, name: 'Épisode 2', airDate: '2021-01-08', still: '/s1e2.jpg' },
        { number: 3, absolute: 3, name: 'La suite', airDate: '2021-01-15' },
      ] },
      { number: 2, name: 'Saison 2', episodes: [
        { number: 1, absolute: 4, name: 'Retour', airDate: '2022-01-01' },
        { number: 2, absolute: 5, name: 'Épisode 2', airDate: future(9) },
      ] },
    ] });
  }
  const trend = /\/lt\/tmdb\/trending\/(movie|tv)\/week$/.exec(u.pathname);
  if (trend) return json({ results: ITEMS.map((i) => ({ ...i, media_type: trend[1] })) });
  const season = /\/lt\/tmdb\/tv\/\d+\/season\/(\d+)$/.exec(u.pathname);
  if (season) {
    const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    return json({ poster_path: '/sp.jpg', episodes: [
      { episode_number: 1, name: 'Pilote', air_date: '2020-01-01', still_path: '/s1.jpg', runtime: 42, overview: 'Début.' },
      { episode_number: 4, name: 'Épisode 4', air_date: future(6), still_path: null, overview: '' },
      { episode_number: 5, name: 'Le grand retour', air_date: future(20), still_path: '/s5.jpg', overview: '' },
    ] });
  }
  if (u.pathname.includes('/lt/top10/')) {
    // Top 10 servi par lastAddon (jour : films et séries mêlés ; semaine : films ou séries), une page de dix titres.
    const page = Number(u.searchParams.get('page') ?? '1');
    const results = page === 1 ? ITEMS.slice(0, 10) : [];
    return json({ page, raw: results.length, results });
  }
  if (u.pathname.includes('/lt/tmdb/')) {
    return json({ imdb_id: 'tt0100', next_episode_to_air: /\/tv\/\d+$/.test(u.pathname) ? { air_date: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10), season_number: 1, episode_number: 5 } : null, seasons: /\/tv\/\d+$/.test(u.pathname) ? [{ season_number: 1, episode_count: 5, air_date: '2020-01-01' }] : [], number_of_seasons: 1,
      results: ITEMS, id: 100, title: 'Film 0', name: 'Série 0', overview: 'Un synopsis assez long pour la fiche.', tagline: 'Slogan',
      poster_path: '/p.jpg', backdrop_path: '/b.jpg', release_date: '2025-01-01', first_air_date: '2025-01-01', runtime: 120, vote_average: 7.4, genres: [{ id: 28, name: 'Action' }],
      images: { logos: [] }, videos: { results: [] }, credits: { cast: [], crew: [] }, external_ids: { imdb_id: 'tt0100' },
      release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ certification: '12', release_date: '2025-01-01', type: 3 }, { release_date: '2025-03-01', type: 4 }] }] },
      recommendations: { results: ITEMS.slice(0, 3) }, similar: { results: [] }, 'watch/providers': { results: {} },
    });
  }
  if (u.pathname.includes('/lt/mdblist/')) return json({ ratings: { imdb: 7.9 } });
  if (u.pathname.endsWith('/lt/recommend')) {
    recCalls.push(String(init?.body));
    return json({ items: Array.from({ length: 55 }, (_, i) => ({ id: 900 + i, media_type: i % 3 ? 'movie' : 'tv', title: 'Reco ' + i, name: 'Reco ' + i, poster_path: '/r' + i + '.jpg', reason_fr: 'Raison ' + i, release_date: '2024-05-05', first_air_date: '2024-05-05' })) });
  }
  if (u.pathname.endsWith('/lt/tv/facets')) return json({ countries: [{ id: 'FR', name: 'France', count: 3 }, { id: 'CH', count: 1 }], languages: { fr: 3, de: 1 }, categories: [{ id: 'news', label: 'Info', count: 2 }, { id: 'sport', label: 'Sport', count: 1 }] });
  if (u.pathname.endsWith('/lt/tv/channels')) {
    return json([
      { id: 'a', name: 'Chaîne A', logo: '', group: '', cat: '', source: 'free-tv', fast: false, url: 'https://x/a.m3u8', sig: 's1', epgId: '', flaky: false, country: 'FR', languages: [{ code: 'fr', name: 'Français' }], categories: [{ id: 'news', label: 'Info' }], reliability: 'high', alternatives: [{ url: 'https://x/a2.m3u8', sig: 's2' }] },
      { id: 'b', name: 'Chaîne B', logo: '', group: '', cat: '', source: 'iptv-org', fast: false, url: 'https://x/b.m3u8', sig: 's3', epgId: '', flaky: false, country: 'FR', languages: [{ code: 'fr', name: 'Français' }], categories: [{ id: 'sport', label: 'Sport' }], reliability: 'low' },
      { id: 'c', name: 'Kanal C', logo: '', group: '', cat: '', source: 'iptv-org', fast: false, url: 'https://x/c.m3u8', sig: 's4', epgId: '', flaky: false, country: 'DE', languages: [{ code: 'de', name: 'Allemand' }], categories: [] },
    ]);
  }
  if (u.pathname.endsWith('/lt/tv/epg')) return json([]);
  if (u.pathname.endsWith('/stream/movie/tt0100.json')) {
    return json({ streams: [{ url: 'https://cdn.example/film.mp4', laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 90, estBitrateKbps: 4000 } }] });
  }
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
    expect(calls.some((c) => c.startsWith('http://localhost:7000/CFG_abc-123/lt/top10/all') && c.includes('window=day'))).toBe(true);
    expect(calls.every((c) => !c.includes('/api/'))).toBe(true);
    // Aucun signal (ni bibliothèque ni progression) : « Pour bien commencer », sans appel IA.
    expect(app.querySelector('#commencer')).not.toBeNull();
    expect(app.querySelector('#ai')).toBeNull();
    expect(recCalls).toHaveLength(0);
  });

  it('mise en avant : carrousel des tendances, pastilles, flèches et clavier', async () => {
    const hero = document.querySelector('#app .hero-carousel') as HTMLElement;
    expect(hero).not.toBeNull();
    const slides = hero.querySelectorAll('.hero-slide');
    expect(slides.length).toBeGreaterThanOrEqual(6);
    expect(slides.length).toBeLessThanOrEqual(8);
    // Films et séries en alternance, rang propre à chaque classement.
    expect(slides[0].querySelector('.eyebrow')!.textContent).toBe('Tendance n°1 · Film');
    expect(slides[1].querySelector('.eyebrow')!.textContent).toBe('Tendance n°1 · Série');
    expect(slides[2].querySelector('.eyebrow')!.textContent).toBe('Tendance n°2 · Film');
    expect(slides[1].querySelector('.hero-note')!.textContent).toMatch(/^Nouvel épisode le /);
    expect(slides[0].querySelector('[data-heroplay]')).not.toBeNull();
    expect(slides[0].querySelectorAll('.hero-actions .btn-ghost').length).toBeGreaterThanOrEqual(2); // Bande-annonce et Plus d’infos
    expect(hero.querySelectorAll('.hero-slide.is-current')).toHaveLength(1);
    expect(slides[1].hasAttribute('inert')).toBe(true);
    (hero.querySelector('[data-hero-go="2"]') as HTMLElement).click();
    expect(slides[2].classList.contains('is-current')).toBe(true);
    expect(slides[2].hasAttribute('inert')).toBe(false);
    (hero.querySelector('[data-hero-step="1"]') as HTMLElement).click();
    expect(slides[3].classList.contains('is-current')).toBe(true);
    hero.focus();
    hero.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(slides[2].classList.contains('is-current')).toBe(true);
    expect(hero.querySelector('.hero-dot.is-current')!.textContent).toBe('3');
  });

  it('menu contextuel : clic droit sur une tuile, clavier, et menu natif ailleurs', async () => {
    location.hash = '#/';
    await settle(200);
    const tile = document.querySelector('#app #films [data-tile]') as HTMLElement;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 });
    tile.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const menu = document.querySelector('.ctxmenu') as HTMLElement;
    expect(menu).not.toBeNull();
    const labels = Array.from(menu.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Lecture', 'Plus d’infos', 'Bande-annonce', 'Ajouter à ma bibliothèque']));
    expect(labels.some((l) => /vu|vue/.test(l!))).toBe(true);
    expect(document.activeElement).toBe(menu.querySelector('button'));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menu.querySelectorAll('button')[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(menu.querySelector('button'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.ctxmenu')).toBeNull();
    const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    (document.querySelector('#app .foot p') as HTMLElement).dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false); // menu natif conservé hors des éléments
    // Ajout à la bibliothèque depuis le menu.
    tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    (document.querySelector('.ctxmenu [data-ctx="lib"]') as HTMLElement).click();
    expect(document.querySelector('.ctxmenu')).toBeNull();
    expect(JSON.parse(localStorage.getItem('laststream.library') || '[]')).toHaveLength(1);
  });

  it('IA : une seule liste de 50+ titres par jour, réutilisée ensuite', async () => {
    const { loadAI } = await import('../src/ui/home.js');
    const { state } = await import('../src/ui/state.js');
    state.ai = { status: 'idle', items: [] };
    await loadAI();
    expect(recCalls).toHaveLength(1);
    const body = JSON.parse(recCalls[0]);
    expect(body.count).toBe(50);
    expect(body.exclude).toEqual(expect.arrayContaining([expect.objectContaining({ tmdbId: expect.any(Number) })]));
    expect(state.ai.items.length).toBeGreaterThanOrEqual(50);
    expect(document.querySelectorAll('#ai [data-tile]').length).toBe(20); // la rangée en montre ~20
    expect(document.querySelector('#ai [data-browse="ai"]')).not.toBeNull();
    // Même jour : aucun nouvel appel, même après un changement de bibliothèque.
    localStorage.setItem('laststream.library', '[]');
    state.ai = { status: 'idle', items: [] };
    await loadAI();
    expect(recCalls).toHaveLength(1);
    expect(state.ai.items.length).toBeGreaterThanOrEqual(50);
    // Le lendemain : nouvel appel.
    const key = Object.keys(localStorage).find((k) => k.startsWith('laststream.aiRecs.'))!;
    const rec = JSON.parse(localStorage.getItem(key)!);
    rec.date = '2000-01-01';
    localStorage.setItem(key, JSON.stringify(rec));
    localStorage.setItem('laststream.library', JSON.stringify([{ id: 5, type: 'movie', title: 'X', poster: '/x', addedAt: 1 }]));
    state.ai = { status: 'idle', items: [] };
    await loadAI();
    expect(recCalls).toHaveLength(2);
    // Page « Tout voir ».
    location.hash = '#/browse/ai';
    await settle(200);
    expect(document.querySelectorAll('#detail #ai-grid [data-tile]').length).toBeGreaterThanOrEqual(50);
    expect(document.querySelector('#detail #ai-grid .card-reason')).toBeNull(); // la raison n'est montrée qu'au survol
    (document.querySelector('#detail [data-aif="tv"]') as HTMLElement).click();
    expect(document.querySelectorAll('#detail #ai-grid [data-tile]').length).toBeLessThan(55);
    location.hash = '#/';
    await settle(100);
  });

  it('affiche une affiche retrouvée pour un titre de la bibliothèque sans image, et la garde', async () => {
    localStorage.setItem('laststream.library', JSON.stringify([{ id: 77, type: 'movie', title: 'Memento', poster: '', addedAt: 5 }]));
    const { renderLibrary } = await import('../src/ui/library.js');
    renderLibrary();
    const tile = () => document.querySelector('#lib-slot [data-tile="movie:77"] .card-media') as HTMLElement;
    expect(tile().querySelector('img')).toBeNull();
    await settle(300);
    expect(tile().querySelector('img')!.getAttribute('src')).toContain('/p.jpg');
    expect(tile().classList.contains('no-img')).toBe(false);
    expect(JSON.parse(localStorage.getItem('laststream.library')!)[0].poster).toBe('/p.jpg');
  });

  it('fiche : Suivre, Marquer comme vu, puis noter par demi-étoile (après visionnage seulement)', async () => {
    localStorage.removeItem('laststream.follows');
    localStorage.removeItem('laststream.ratings');
    localStorage.removeItem('ls_seen');
    location.hash = '#/movie/100';
    await settle(300);
    const detail = document.getElementById('detail')!;
    // Plus de bloc IA « Pourquoi tu vas aimer » : ni encart, ni appel de génération à l'ouverture de la fiche.
    expect(detail.querySelector('#f-why')).toBeNull();
    expect(calls.some((url) => url.includes('/lt/why'))).toBe(false);
    const follow = detail.querySelector('[data-follow="movie:100"]') as HTMLElement;
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    follow.click();
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('laststream.follows')!)[0]).toMatchObject({ id: 100, type: 'movie' });
    // Pas encore vu : la note est désactivée.
    expect(detail.querySelector('#f-rate button[disabled]')).not.toBeNull();
    (detail.querySelector('[data-watch-movie]') as HTMLElement).click();
    await settle(50);
    expect(detail.querySelector('[data-watch-movie]')!.getAttribute('aria-pressed')).toBe('true');
    expect(detail.querySelector('#f-rate .stars')).not.toBeNull();
    expect(document.querySelector('.rate-pop')).not.toBeNull(); // « Tu as aimé ? »
    (detail.querySelector('#f-rate [data-rate="4.5"]') as HTMLElement).click();
    expect(JSON.parse(localStorage.getItem('laststream.ratings')!)[0]).toMatchObject({ id: 100, rating: 4.5 });
    expect(detail.querySelectorAll('#f-rate .star.is-full').length).toBe(4);
    expect(detail.querySelectorAll('#f-rate .star.is-half').length).toBe(1);
  });

  it('calendrier : état vide puis grille du mois avec filtres', async () => {
    document.querySelector('.rate-pop')?.remove();
    localStorage.removeItem('laststream.follows');
    location.hash = '#/calendar';
    await settle(200);
    expect(document.querySelector('#detail .cal-wrap .row-msg')!.textContent).toMatch(/ne suis encore rien/);
    localStorage.setItem('laststream.follows', JSON.stringify([{ type: 'movie', id: 100, title: 'Film 0', poster: '/p.jpg', addedAt: 1 }]));
    location.hash = '#/';
    await settle(50);
    location.hash = '#/calendar';
    await settle(300);
    expect(document.querySelectorAll('#detail .cal-day').length).toBeGreaterThanOrEqual(28);
    expect(document.querySelector('#detail #cal-title')!.textContent!.length).toBeGreaterThan(5);
    expect(document.querySelectorAll('#detail [data-calkind]')).toHaveLength(4);
    (document.querySelector('#detail [data-calmode="agenda"]') as HTMLElement).click();
    await settle(50);
    expect(document.querySelector('#detail .cal-agenda, #detail .cal-wrap .row-msg')).not.toBeNull();
    (document.querySelector('#detail [data-caltoday]') as HTMLElement).click();
    location.hash = '#/';
    await settle(50);
  });

  it('fiche série : carte « Bientôt » pour les épisodes à venir', async () => {
    location.hash = '#/tv/101';
    await settle(500);
    // Diffusé dans 6 jours : lisible (bouton actif, « déjà en ligne ? »), sans carte à compte à rebours.
    const near = document.querySelector('#detail .ep[data-ep="1:4"]') as HTMLElement;
    expect(near.classList.contains('is-soon')).toBe(false);
    expect(near.querySelector('[data-play]')).not.toBeNull();
    expect(near.querySelector('.ep-meta')!.textContent).toMatch(/ · déjà en ligne \?$/);
    expect(near.getAttribute('data-air')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(near.querySelector('.ep-seen')).toBeNull();
    // Diffusé dans 20 jours : au-delà de la fenêtre, carte « Bientôt » inchangée.
    const soon = Array.from(document.querySelectorAll('#detail .ep.is-soon')) as HTMLElement[];
    expect(soon).toHaveLength(1);
    const [a] = soon;
    expect(a.querySelector('.soon-date b')!.textContent).toMatch(/^\d+$/);
    expect(a.querySelector('.soon-date i')!.textContent).toMatch(/^[A-ZÉÛ]+$/);
    expect(a.querySelector('.soon-count')!.textContent).toBe('Dans 20 jours');
    expect(a.querySelector('.soon-code')!.textContent).toBe('S1 · É5');
    expect(a.querySelector('.soon-title')!.textContent).toBe('Le grand retour');
    expect(a.querySelector('.ep-meta')!.textContent).toMatch(/^Le .+ · Bientôt$/);
    expect(a.querySelector('.soon-bg img')!.getAttribute('src')).toContain('/w500/s5.jpg'); // visuel de l'épisode
    expect(a.querySelector('.soon.is-blur')).toBeNull(); // le flou n'est que le dernier repli
    expect(a.querySelector('.soon-poster')!.getAttribute('src')).toContain('/w342/'); // affiche de la série en vignette
    expect(a.querySelector('.soon-series')!.textContent!.length).toBeGreaterThan(0); // nom de la série au-dessus de S1 · É5
    expect(a.classList.contains('is-seen')).toBe(false);
    expect(a.querySelector('.soon-bell')).not.toBeNull();
    expect(a.querySelector('.ep-seen')).toBeNull();
    // « Me prévenir » suit la série.
    (a.querySelector('.soon-bell') as HTMLElement).click();
    expect(JSON.parse(localStorage.getItem('laststream.follows')!).some((f: { id: number }) => f.id === 101)).toBe(true);
    expect(a.querySelector('.soon-bell')!.textContent).toBe('Suivi');
    // L'épisode déjà sorti reste une carte normale.
    expect(document.querySelector('#detail .ep[data-ep="1:1"] .ep-seen')).not.toBeNull();
    location.hash = '#/';
    await settle(50);
  });

  it('fiche série : numérotation canonique de lastAddon (saisons, épisodes, prochain, compteur)', async () => {
    localStorage.removeItem('ls_seen');
    location.hash = '#/tv/102';
    await settle(500);
    const d = document.getElementById('detail')!;
    const pills = Array.from(d.querySelectorAll('[data-season]')).map((b) => b.textContent);
    expect(pills).toEqual(['Saison 1', 'Saison 2']); // et non les saisons TMDB
    const eps = Array.from(d.querySelectorAll('#f-eplist .ep')) as HTMLElement[];
    expect(eps.map((e) => e.dataset.ep)).toEqual(['1:1', '1:2', '1:3']); // épisodes canoniques de la saison 1
    expect(eps[0].querySelector('.ep-still img')!.getAttribute('src')).toBe('https://img.example/s1e1.jpg'); // visuel rattaché par le serveur
    expect(eps[0].querySelector('.ep-title')!.textContent).toBe('É1 · Début');
    expect(eps[1].querySelector('.ep-title')!.textContent).toBe('É2'); // titre générique non répété
    // Prochain épisode : le premier épisode à paraître de la numérotation canonique.
    expect(d.querySelector('#f-next')!.textContent).toMatch(/S2 · É2/);
    // Compteur : 4 épisodes diffusés, aucun vu -> 0 ; marquer S1 É1 comme vu -> 3 nouveaux.
    (d.querySelector('[data-season="2"]') as HTMLElement).click();
    await settle(300);
    // Diffusé dans 9 jours : lisible, « déjà en ligne ? » (pas de carte « Bientôt »).
    const soon = d.querySelector('#f-eplist .ep[data-ep="2:2"]') as HTMLElement;
    expect(soon.classList.contains('is-soon')).toBe(false);
    expect(soon.querySelector('.ep-meta')!.textContent).toMatch(/déjà en ligne \?$/);
    (d.querySelector('[data-season="1"]') as HTMLElement).click();
    await settle(300);
    (d.querySelector('#f-eplist .ep[data-ep="1:1"] .ep-seen') as HTMLElement).click();
    await settle(50);
    expect(d.querySelector('#f-newcount')!.textContent).toBe('3 nouveaux épisodes');
    // « Lecture » vise le prochain épisode non vu, en numérotation canonique (identifiant de flux tt:saison:épisode).
    expect(d.querySelector('.f-actions [data-play] .f-play-label')!.textContent).toBe('Reprendre · S1 É2');
    location.hash = '#/';
    await settle(50);
  });

  it('Suivre : bouton rond sans libellé, comme les autres boutons de la fiche', async () => {
    location.hash = '#/movie/100';
    await settle(300);
    const f = document.querySelector('#detail .f-actions [data-follow="movie:100"]') as HTMLElement;
    expect(f.classList.contains('btn-round')).toBe(true);
    expect(f.querySelector('.f-follow-label')).toBeNull();
    expect(f.getAttribute('data-tip')).toMatch(/Suivre|Suivi/);
    location.hash = '#/';
    await settle(50);
  });

  it('Reprendre la lecture : cartes paysage avec épisode, temps restant, suite et reprise directe', async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_abc-123' }));
    const { userStore } = await import('../src/data/userStore');
    userStore.setProgress({ key: 'tv:101', type: 'tv', id: 101, title: 'Série 101', poster: '/p.jpg', backdrop: '/b101.jpg', season: 1, episode: 4, position: 600, duration: 2400 });
    userStore.setProgress({ key: 'movie:100', type: 'movie', id: 100, title: 'Film 100', poster: '/p.jpg', backdrop: '/b100.jpg', position: 1000, duration: 6000 });
    userStore.setProgress({ key: 'tv:103', type: 'tv', id: 103, title: 'Série 103', poster: '/p.jpg', backdrop: '/b103.jpg', season: 1, episode: 1, position: 2390, duration: 2400 });
    const { renderContinue } = await import('../src/ui/home.js');
    renderContinue();
    await settle(300);
    const cards = Array.from(document.querySelectorAll('#cont-slot .cont-card')) as HTMLElement[];
    expect(cards).toHaveLength(3);
    const by = (k: string) => cards.find((c) => c.dataset.resume === k)!;
    expect(by('tv:101').querySelector('.cont-code')!.textContent).toBe('S1 · É4');
    expect(by('tv:101').querySelector('.cont-left')!.textContent).toBe('10:00 · 25 % · reste 30 min'); // timecode et pourcentage, puis temps restant
    expect(by('tv:101').querySelector('.progress span')!.getAttribute('style')).toContain('25%');
    expect(by('movie:100').querySelector('.cont-left')!.textContent).toBe('16:40 · 17 % · reste 1 h 23');
    expect(by('movie:100').querySelector('.cont-img')!.getAttribute('src')).toContain('/w780/b100.jpg');
    // Épisode terminé : le suivant est proposé.
    expect(by('tv:103').querySelector('.cont-code')!.textContent).toMatch(/^À suivre : S\d+ · É\d+/);
    expect(by('tv:103').querySelector('.progress span')!.getAttribute('style')).toContain('0%');
    expect(by('movie:100').querySelector('.t-remove')).not.toBeNull();
    // Un clic reprend la lecture directement (source choisie automatiquement), à la position enregistrée.
    by('movie:100').click();
    await settle(400);
    const player = document.getElementById('lsplayer') as HTMLElement;
    expect(player.hidden).toBe(false);
    expect((player.querySelector('video') as HTMLVideoElement).getAttribute('src')).toBe('https://cdn.example/film.mp4');
    (player.querySelector('[data-act="close"]') as HTMLElement).click();
    await settle(50);
    expect(player.hidden).toBe(true);
    localStorage.clear();
    localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_abc-123' }));
    renderContinue();
  });

  it('films uniquement en salle : rangée « Au cinéma », badge, pas de Lecture sur la fiche', async () => {
    location.hash = '#/';
    await settle(300);
    const tiles = Array.from(document.querySelectorAll('#app #cinema [data-tile]')) as HTMLElement[];
    expect(tiles.length).toBeGreaterThanOrEqual(6);
    expect(tiles.every((t) => t.querySelector('.t-cinema'))).toBe(true);
    // Les films « Au cinéma » ne sont pas dans les rangées normales.
    expect(document.querySelectorAll('#app #films [data-tile^="movie:5"]')).toHaveLength(0);
    const streamCallsBefore = calls.filter((c) => c.includes('/stream/')).length;
    location.hash = '#/movie/505';
    await settle(400);
    const d = document.getElementById('detail')!;
    expect(d.querySelector('.f-actions [data-play]')).toBeNull();
    // Bouton rond « Sources » : présent, mais rien n'est vérifié tant qu'on ne clique pas.
    const srcBtn = d.querySelector('.f-actions [data-sources-open]') as HTMLElement;
    expect(srcBtn.classList.contains('btn-round')).toBe(true);
    expect(srcBtn.getAttribute('data-tip')).toBe('Voir les sources');
    expect(calls.filter((c) => c.includes('/stream/')).length).toBe(streamCallsBefore);
    // Le « Suivre » est la pastille principale : pas de cloche en double.
    expect(d.querySelectorAll('.f-actions [data-follow="movie:505"]')).toHaveLength(1);
    expect(d.querySelector('.f-actions .btn-pill.is-cinema')).not.toBeNull();
    expect(d.querySelector('.f-release')!.textContent).toMatch(/Au cinéma depuis le/);
    const be = d.querySelector('.f-actions [data-follow="movie:505"]') as HTMLElement;
    expect(be.textContent).toBe('Me prévenir de la sortie en VOD');
    be.click();
    expect(JSON.parse(localStorage.getItem('laststream.follows')!).some((f: { id: number }) => f.id === 505)).toBe(true);
    location.hash = '#/';
    await settle(50);
  });

  it('titres sans affiche : image retrouvée dans TMDB, sinon affiche typographique', async () => {
    localStorage.setItem('laststream.library', JSON.stringify([
      { id: 801, type: 'movie', title: 'Sabaya', poster: '', addedAt: 3 },
      { id: 802, type: 'movie', title: 'Don’t Forget Me Tomorrow', poster: '', addedAt: 2 },
    ]));
    const { renderLibrary } = await import('../src/ui/library.js');
    renderLibrary();
    const media = (id: number) => document.querySelector('#lib-slot [data-tile="movie:' + id + '"] .card-media') as HTMLElement;
    // Avant la réponse : jamais une boîte vide, l'affiche générée est déjà là.
    expect(media(801).classList.contains('no-img')).toBe(true);
    expect(media(801).querySelector('.tp-title')!.textContent).toBe('Sabaya');
    await settle(400);
    expect(media(801).querySelector('img')!.getAttribute('src')).toContain('/found.jpg'); // trouvée via /images
    expect(media(801).classList.contains('no-img')).toBe(false);
    expect(media(802).querySelector('img')).toBeNull();
    expect(media(802).classList.contains('no-img')).toBe(true); // rien nulle part : affiche typographique
    expect(media(802).querySelector('.tp-title')!.textContent).toBe('Don’t Forget Me Tomorrow');
    expect(media(802).querySelector('.tp-mono')!.textContent).toBe('DF');
    expect(media(802).querySelector('.tp-icon svg')).not.toBeNull();
    localStorage.setItem('laststream.library', '[]');
    renderLibrary();
  });

  it('utilise la région France par défaut', () => {
    expect(calls.some((c) => c.includes('/lt/tmdb/discover/movie') && c.includes('primary_release_date.lte='))).toBe(true); // seuls les titres déjà sortis
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

  it('Lecture ouvre le lecteur et lance la meilleure source ; lecture automatique désactivée : sélecteur dans le lecteur', async () => {
    (document.querySelector('#detail [data-play]') as HTMLElement).click();
    await settle(400);
    const player = document.getElementById('lsplayer') as HTMLElement;
    expect(player.hidden).toBe(false);
    expect((player.querySelector('video') as HTMLVideoElement).getAttribute('src')).toBe('https://cdn.example/film.mp4');
    (player.querySelector('[data-act="close"]') as HTMLElement).click();
    await settle(50);
    expect(player.hidden).toBe(true);
    localStorage.setItem('laststream.autoplay', '0');
    (document.querySelector('#detail [data-play]') as HTMLElement).click();
    await settle(300);
    // Le lecteur est ouvert et le sélecteur détaillé est un panneau du lecteur, pas un tiroir de la fiche.
    expect(player.hidden).toBe(false);
    expect(document.getElementById('modal')!.hidden).toBe(true);
    const item = player.querySelector('.lp-panel .src2') as HTMLElement;
    expect(item.querySelector('.q')!.textContent).toBe('1080p');
    expect(item.textContent).toContain('WEB-DL');
    expect(player.querySelector('.lp-panel .s-chip[data-chip="res:1080p"]')).not.toBeNull();
    (player.querySelector('[data-act="panel-close"]') as HTMLElement).click(); // fermer sans choisir : retour à la fiche
    await settle(100);
    expect(player.hidden).toBe(true);
    localStorage.removeItem('laststream.autoplay');
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
    perrEl!.hidden = true;
    failover(c, 7);
    await settle(100);
    expect(tv.attempt).toBe(1);
    expect(perrEl!.hidden).toBe(false); // les deux flux ont échoué (jsdom ne lit pas de HLS)
    const solo = { id: 'y', url: 'https://x/y.m3u8', sig: 's', alternatives: [] };
    tv.attempt = 0;
    perrEl!.hidden = true;
    failover(solo, 7);
    expect(tv.attempt).toBe(0);
    expect(perrEl!.hidden).toBe(false);
  });

  it('affiche la bibliothèque vide', async () => {
    location.hash = '#/library';
    await settle(200);
    expect(document.querySelector('#detail #lib-grid')).not.toBeNull();
  });
});
