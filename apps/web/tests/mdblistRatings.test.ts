// Notes MDBList : une requête par titre, seulement au survol stable d'une fiche ou d'une mise en avant (500 ms), jamais
// pour une rangée de tuiles ; réponse « unavailable » (quota épuisé) gérée sans erreur. lastAddon est simulé par fetch.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'http://localhost:7000';
const CFG = 'CFG_mdblist-test';

/** Comportement du faux serveur pour /lt/mdblist : notes, quota épuisé (200 unavailable) ou erreur amont. */
let mdbMode: 'ok' | 'unavailable' | 'error' = 'ok';
const RETRY_AFTER = 60;
const mdbCalls: string[] = [];
const tmdbCalls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Détail TMDB minimal d'un film : l'identifiant IMDb dérive de l'id TMDB (tt<id>). */
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
    if (mdbMode === 'error') return json({ error: 'upstream' }, 502);
    if (mdbMode === 'unavailable') return json({ unavailable: true, retryAfter: RETRY_AFTER });
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
let cont: typeof import('../src/ui/continue.js');

/** Attend que les requêtes en vol se terminent (ou que la condition soit vraie). */
async function settle(cond?: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !(cond ? cond() : false); i += 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
}

/** Survol souris d'un élément, comme le navigateur le signale (pointerover, pointerType « mouse »). */
function hoverEl(el: Element): void {
  const ev = new Event('pointerover', { bubbles: true });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  el.dispatchEvent(ev);
}

/** Nombre d'appels MDBList pour un film (son identifiant IMDb se termine par tt<id>). */
const mdbFor = (id: number) => mdbCalls.filter((p) => p.endsWith('/tt' + id)).length;
const tmdbFor = (id: number) => tmdbCalls.filter((p) => p === 'tmdb/movie/' + id).length;

/** Film au format TMDB, enregistré comme le fait l'accueil. */
function item(id: number) {
  return catalog.register(catalog.toItem({ id, title: 'Film ' + id, poster_path: '/p.jpg', backdrop_path: '/b' + id + '.jpg', release_date: '2020-01-01', vote_average: 7.5, genre_ids: [28], overview: 'Un synopsis.' }, 'movie'));
}

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  await import('../src/ui/ctxmenu.js');
  catalog = await import('../src/ui/catalog.js');
  hero = await import('../src/ui/hero.js');
  hover = await import('../src/ui/hover.js');
  cont = await import('../src/ui/continue.js');
});

beforeEach(() => {
  mdbCalls.length = 0;
  tmdbCalls.length = 0;
  mdbMode = 'ok';
  document.getElementById('app')!.innerHTML = '';
});

afterEach(() => {
  hero.stopHero();
  hover.closeHover();
  vi.useRealTimers();
});

describe('notes MDBList à la demande', () => {
  it('une rangée « Reprendre » de 20 tuiles ne déclenche aucun appel MDBList (détail TMDB seulement)', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 9001 + i);
    const root = document.createElement('div');
    root.innerHTML = ids.map((id) =>
      '<div class="cont-card" data-resume="movie:' + id + '" data-season="" data-episode=""><div class="card-media"></div><span class="cont-name">Film ' + id + '</span></div>').join('');
    document.getElementById('app')!.appendChild(root);
    ids.forEach((id) => item(id));

    cont.hydrateContinue(root);
    await settle(() => ids.every((id) => tmdbFor(id) >= 1));

    for (const id of ids) expect(tmdbFor(id), 'détail ' + id).toBe(1);
    expect(mdbCalls).toEqual([]);
  });

  it('survol : une seule requête MDBList, et le détail TMDB déjà en cache n’est pas redemandé', async () => {
    const it = item(9101);
    expect(await catalog.getDetail(it)).toMatchObject({ ratings: {} });
    expect(tmdbFor(9101)).toBe(1);
    expect(mdbFor(9101)).toBe(0);

    const d = await catalog.getDetail(it, { ratings: true });
    expect(d).toMatchObject({ ratings: { imdb: 7.9 } });
    expect(mdbFor(9101)).toBe(1);
    expect(tmdbFor(9101)).toBe(1);

    await catalog.getDetail(it, { ratings: true });
    expect(mdbFor(9101)).toBe(1);
  });

  it('carte de survol : affiche les notes après une seule requête MDBList', async () => {
    const it = item(9201);
    const tile = document.createElement('div');
    tile.setAttribute('data-tile', it.key);
    tile.innerHTML = '<div class="card-media"></div>';
    document.getElementById('app')!.appendChild(tile);

    hover.openHover(tile);
    await settle(() => !!document.querySelector('#hovercard .hc-rates')?.innerHTML.includes('IMDb'));

    expect(document.querySelector('#hovercard .hc-rates')?.innerHTML).toContain('IMDb');
    expect(mdbFor(9201)).toBe(1);
  });

  it('bannière de 8 diapositives : aucune requête MDBList à l’affichage ; un survol stable n’en demande qu’une, pour la diapositive affichée', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => 9301 + i);
    const items = ids.map((id) => item(id));
    document.getElementById('app')!.innerHTML = hero.heroCarousel(items);
    hero.initHero(items);
    await settle(() => tmdbFor(9301) === 1);
    expect(mdbCalls).toEqual([]);

    hoverEl(document.querySelector('#app .hero-slide.is-current')!);
    await new Promise((r) => setTimeout(r, 550)); // 500 ms de survol stable
    await settle(() => mdbFor(9301) === 1);
    expect(mdbCalls).toEqual(['mdblist/movie/tt9301']);
    expect(document.querySelector('#app .hero-slide.is-current .rates-hero')?.innerHTML).toContain('IMDb');
  });

  it('mise en avant d’un titre unique (profil enfant) : ses notes ne partent qu’après un survol stable', async () => {
    const it = item(9401);
    document.getElementById('app')!.innerHTML = hero.heroA(it, 'Pour toi');
    hero.prepareSingle(it);
    await settle(() => tmdbFor(9401) === 1);
    expect(mdbCalls).toEqual([]);

    hoverEl(document.querySelector('#app .hero')!);
    await new Promise((r) => setTimeout(r, 550));
    await settle(() => mdbFor(9401) === 1);
    expect(mdbFor(9401)).toBe(1);
    expect(document.querySelector('#app .rates-hero')?.innerHTML).toContain('IMDb');
  });
});

describe('réponse « unavailable » (quota MDBList épuisé)', () => {
  it('TMDB seul, sans erreur, et pas de nouvel appel avant retryAfter ; nouvel essai ensuite', async () => {
    const it = item(9501);
    mdbMode = 'unavailable';
    const d1 = await catalog.getDetail(it, { ratings: true });
    expect(d1).not.toBeNull();
    expect(d1!.ratings).toEqual({});
    expect(mdbFor(9501)).toBe(1);

    // Avant retryAfter : aucune nouvelle requête (ni par la notion de retryAfter, ni par le cache client).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (RETRY_AFTER - 10) * 1000);
    mdbMode = 'ok';
    const d2 = await catalog.getDetail(it, { ratings: true });
    expect(d2!.ratings).toEqual({});
    expect(mdbFor(9501)).toBe(1);

    // Après retryAfter (et après l’expiration du cache client de 10 min) : un nouvel essai, qui réussit.
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const d3 = await catalog.getDetail(it, { ratings: true });
    expect(mdbFor(9501)).toBe(2);
    expect(d3!.ratings).toEqual({ imdb: 7.9 });
    expect(tmdbFor(9501)).toBe(1);
  });

  it('erreur amont : détail gardé, pas de puce, pas d’exception', async () => {
    const it = item(9601);
    mdbMode = 'error';
    const d = await catalog.getDetail(it, { ratings: true });
    expect(d).not.toBeNull();
    expect(d!.ratings).toEqual({});
    expect(d!.overview).toBe('Un synopsis.');
    expect(mdbFor(9601)).toBe(1);
  });

  it('fetchDetail sans option ne touche pas MDBList', async () => {
    const d = await catalog.fetchDetail(item(9701));
    expect(d.ratings).toEqual({});
    expect(mdbCalls).toEqual([]);
  });
});
