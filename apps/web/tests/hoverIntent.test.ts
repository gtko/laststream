// Intention de survol : TMDB et MDBList ne partent qu'après 500 ms de survol stable (tuile de la carte, mise en avant) et
// sont annulés si le pointeur part. « Lecture » ne précharge les sources qu'au focus maintenu 1 s, jamais au survol.
// lastAddon est simulé par fetch ; seules les minuteries (setTimeout) sont fictives.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sources/load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/load')>()),
  prefetchSources: vi.fn(),
}));

const BASE = 'http://localhost:7000';
const CFG = 'CFG_hover-intent-test';
const mdbCalls: string[] = [];
const tmdbCalls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function movieDetail(id: number) {
  return {
    id, title: 'Film ' + id, overview: 'Un synopsis.', imdb_id: 'tt' + id, poster_path: '/p.jpg', backdrop_path: '/b' + id + '.jpg',
    vote_average: 7.5, vote_count: 100, runtime: 100, genres: [{ id: 28, name: 'Action' }], release_date: '2020-01-01',
    images: { logos: [] }, videos: { results: [] }, release_dates: { results: [] }, 'watch/providers': { results: {} },
    external_ids: { imdb_id: 'tt' + id },
  };
}

function mockFetch(url: string): Response {
  const u = new URL(url);
  const prefix = '/' + CFG + '/lt/';
  if (!u.pathname.startsWith(prefix)) return json({ error: 'not_found' }, 404);
  const p = u.pathname.slice(prefix.length);
  if (p.startsWith('mdblist/')) {
    mdbCalls.push(p);
    return json({ ratings: { imdb: 7.9 } });
  }
  if (p.startsWith('tmdb/')) {
    tmdbCalls.push(p);
    const m = /^tmdb\/movie\/(\d+)$/.exec(p);
    if (m) return json(movieDetail(Number(m[1])));
    return json({ results: [] });
  }
  return json({ error: 'not_found' }, 404);
}

let catalog: typeof import('../src/ui/catalog.js');
let hero: typeof import('../src/ui/hero.js');
let hover: typeof import('../src/ui/hover.js');
let sourcesUi: typeof import('../src/ui/sources-ui.js');
let load: typeof import('../src/sources/load');
let state: typeof import('../src/ui/state.js');

const flushOnce = () => new Promise((r) => setImmediate(r));
/** Laisse tourner les promesses (fetch simulé) jusqu'à la condition, sans avancer les minuteries fictives. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i += 1) await flushOnce();
}

const mdbFor = (id: number) => mdbCalls.filter((p) => p.endsWith('/tt' + id)).length;
const tmdbFor = (id: number) => tmdbCalls.filter((p) => p === 'tmdb/movie/' + id).length;

/** Événement de survol souris, comme le navigateur le dispatche (pointerType « mouse »). */
function pointerOver(target: Element): void {
  const ev = new Event('pointerover', { bubbles: true });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(ev);
}

/** Tuile de carte enregistrée comme le fait l'accueil, dans le DOM. */
function tileFor(id: number): { tile: HTMLElement } {
  const it = catalog.register(catalog.toItem({ id, title: 'Film ' + id, poster_path: '/p.jpg', backdrop_path: '/b' + id + '.jpg', release_date: '2020-01-01', vote_average: 7.5, genre_ids: [28], overview: 'Un synopsis.' }, 'movie'));
  const tile = document.createElement('div');
  tile.setAttribute('data-tile', it.key);
  tile.innerHTML = '<div class="card-media"></div>';
  document.getElementById('app')!.appendChild(tile);
  return { tile };
}

function carousel(ids: number[]) {
  const items = ids.map((id) => catalog.register(catalog.toItem({ id, title: 'Film ' + id, poster_path: '/p.jpg', backdrop_path: '/b' + id + '.jpg', release_date: '2020-01-01', vote_average: 7.5, genre_ids: [28], overview: 'Un synopsis.' }, 'movie')));
  document.getElementById('app')!.innerHTML = hero.heroCarousel(items);
  return items;
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  // Survol souris reconnu comme « fin » (sinon hover.js ignore les événements).
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/ui/ctxmenu.js');
  catalog = await import('../src/ui/catalog.js');
  hero = await import('../src/ui/hero.js');
  hover = await import('../src/ui/hover.js');
  sourcesUi = await import('../src/ui/sources-ui.js');
  load = await import('../src/sources/load');
  state = await import('../src/ui/state.js');
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mdbCalls.length = 0;
  tmdbCalls.length = 0;
  document.getElementById('app')!.innerHTML = '';
  document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
});

afterEach(() => {
  hero.stopHero();
  hover.closeHover();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('survol d’une tuile', () => {
  it('aucun appel TMDB ni MDBList avant 500 ms ; puis un seul de chaque', async () => {
    const { tile } = tileFor(9801);
    pointerOver(tile);

    vi.advanceTimersByTime(499);
    await until(() => false);
    expect(tmdbFor(9801)).toBe(0);
    expect(mdbFor(9801)).toBe(0);

    vi.advanceTimersByTime(1);
    await until(() => mdbFor(9801) === 1);
    expect(tmdbFor(9801)).toBe(1);
    expect(mdbFor(9801)).toBe(1);
  });

  it('pointeur parti avant 500 ms : rien n’est demandé, même des secondes plus tard', async () => {
    const { tile } = tileFor(9811);
    pointerOver(tile);
    vi.advanceTimersByTime(300);
    pointerOver(document.body); // hors tuile : l’intention est annulée
    vi.advanceTimersByTime(5000);
    await until(() => false);

    expect(tmdbCalls.filter((p) => p === 'tmdb/movie/9811')).toEqual([]);
    expect(mdbCalls).toEqual([]);
  });

  it('passage d’une tuile à l’autre : seule la tuile où le pointeur s’arrête est chargée', async () => {
    const a = tileFor(9821);
    const b = tileFor(9822);
    pointerOver(a.tile);
    vi.advanceTimersByTime(400);
    pointerOver(b.tile);
    vi.advanceTimersByTime(499);
    await until(() => false);
    expect(mdbFor(9821)).toBe(0);
    expect(mdbFor(9822)).toBe(0);

    vi.advanceTimersByTime(1);
    await until(() => mdbFor(9822) === 1);
    expect(mdbFor(9821)).toBe(0);
    expect(mdbFor(9822)).toBe(1);
  });

  it('la carte de survol (ouverte à 900 ms) réutilise les données déjà demandées', async () => {
    const { tile } = tileFor(9831);
    pointerOver(tile);
    vi.advanceTimersByTime(900);
    await until(() => !!document.querySelector('#hovercard') && mdbFor(9831) === 1);

    expect(document.querySelector('#hovercard')).not.toBeNull();
    expect(tmdbFor(9831)).toBe(1);
    expect(mdbFor(9831)).toBe(1);
  });
});

describe('mise en avant (carrousel)', () => {
  it('sans survol, aucune requête MDBList : seul le détail TMDB de la diapositive affichée arrive', async () => {
    const items = carousel([9901, 9902, 9903]);
    hero.initHero(items);
    vi.advanceTimersByTime(5000);
    await until(() => tmdbFor(9901) === 1);

    expect(tmdbFor(9901)).toBe(1);
    expect(mdbCalls).toEqual([]);
  });

  it('survol stable de 500 ms : notes MDBList de la diapositive affichée ; un changement de diapositive pendant le survol les recharge', async () => {
    const items = carousel([9911, 9912]);
    hero.initHero(items);
    pointerOver(document.querySelector('#app .hero-slide.is-current .hero-desc')!);

    vi.advanceTimersByTime(499);
    await until(() => false);
    expect(mdbCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    await until(() => mdbFor(9911) === 1);
    expect(mdbFor(9911)).toBe(1);
    expect(document.querySelector('#app .hero-slide.is-current .rates-hero')?.innerHTML).toContain('IMDb');

    hero.go(1, true);
    vi.advanceTimersByTime(500);
    await until(() => mdbFor(9912) === 1);
    expect(mdbFor(9912)).toBe(1);
    expect(mdbFor(9911)).toBe(1);
  });

  it('pointeur sorti de la mise en avant avant 500 ms : aucune note demandée pour la diapositive suivante', async () => {
    const items = carousel([9921, 9922]);
    hero.initHero(items);
    pointerOver(document.querySelector('#app .hero-slide.is-current .hero-desc')!);
    vi.advanceTimersByTime(200);
    pointerOver(document.body);
    hero.go(1, true);
    vi.advanceTimersByTime(5000);
    await until(() => false);

    expect(mdbCalls).toEqual([]);
  });
});

describe('mise en avant simple (profil enfant)', () => {
  it('ses notes MDBList ne partent qu’après 500 ms de survol', async () => {
    const it = catalog.register(catalog.toItem({ id: 9941, title: 'Film 9941', poster_path: '/p.jpg', backdrop_path: '/b9941.jpg', release_date: '2020-01-01', vote_average: 7.5, genre_ids: [28], overview: 'Un synopsis.' }, 'movie'));
    document.getElementById('app')!.innerHTML = hero.heroA(it, 'Pour toi');
    hero.prepareSingle(it);
    vi.advanceTimersByTime(5000);
    await until(() => tmdbFor(9941) === 1);
    expect(mdbCalls).toEqual([]);

    pointerOver(document.querySelector('#app .hero')!);
    vi.advanceTimersByTime(500);
    await until(() => mdbFor(9941) === 1);
    expect(mdbFor(9941)).toBe(1);
    expect(document.querySelector('#app .rates-hero')?.innerHTML).toContain('IMDb');
  });
});

describe('préchargement des sources sur « Lecture »', () => {
  const playButton = (): HTMLElement => {
    const b = document.createElement('button');
    b.setAttribute('data-play', '');
    document.getElementById('app')!.appendChild(b);
    return b;
  };
  const focusin = (el: Element) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  const focusout = (el: Element) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

  beforeEach(() => {
    Object.assign(state.state, { model: { type: 'movie', id: 550, name: 'Fight Club' } });
  });

  it('survol souris : aucun préchargement, même après plusieurs secondes', () => {
    const b = playButton();
    pointerOver(b);
    vi.advanceTimersByTime(5000);
    expect(load.prefetchSources).not.toHaveBeenCalled();
  });

  it('focus maintenu 1 s : préchargement une seule fois', () => {
    const b = playButton();
    focusin(b);
    vi.advanceTimersByTime(999);
    expect(load.prefetchSources).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load.prefetchSources).toHaveBeenCalledTimes(1);
    expect(load.prefetchSources).toHaveBeenCalledWith(expect.objectContaining({ type: 'movie', id: '550' }));
  });

  it('focus relâché avant 1 s : aucun préchargement', () => {
    const b = playButton();
    focusin(b);
    vi.advanceTimersByTime(600);
    focusout(b);
    vi.advanceTimersByTime(2000);
    expect(load.prefetchSources).not.toHaveBeenCalled();
  });
});
