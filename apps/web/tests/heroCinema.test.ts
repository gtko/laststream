// Mode cinéma du héros : son de l'aperçu activé → seule la vidéo reste, le carrousel est suspendu, le cadre garde le bas
// de l'image (sous-titres). Les minuteries sont fictives ; les données TMDB sont simulées.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/catalog.js')>()),
  getDetail: vi.fn(async () => ({ trailer: 'abc', trailerVO: false })),
}));
vi.mock('../src/sources/load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/load')>()),
  prefetchSources: vi.fn(),
}));

let catalog: typeof import('../src/ui/catalog.js');
let hero: typeof import('../src/ui/hero.js');
let preview: typeof import('../src/ui/preview.js');
/** Aperçu en cours (sous-ensemble de l'état lu par preview.js). */
interface Preview { iframe: HTMLIFrameElement; media: HTMLElement; wrap: HTMLElement; btn: HTMLElement; muted: boolean; vo: boolean }
let state: { inDetail: boolean; preview: Preview | null; byKey: Map<string, unknown> };

const flush = () => new Promise((r) => setImmediate(r));

function mountCarousel(ids: number[]) {
  const items = ids.map((id) => catalog.register(catalog.toItem({
    id, title: 'Film ' + id, poster_path: '/p.jpg', backdrop_path: '/b' + id + '.jpg', release_date: '2020-01-01',
    vote_average: 7.5, genre_ids: [28], overview: 'Un synopsis.',
  }, 'movie')));
  document.getElementById('app')!.innerHTML = hero.heroCarousel(items);
  hero.initHero(items);
  return items;
}

/** Clé du titre affiché par le carrousel. */
const shownKey = () => (hero.currentHeroItem() as unknown as { key: string }).key;

/** Lance l'aperçu de la diapositive affichée ; renvoie son état (iframe, bouton son). */
async function startPreviewOnCurrent() {
  const media = document.querySelector('.hero-slide.is-current [data-media]') as HTMLElement;
  await preview.startPreview(media);
  await flush();
  if (!state.preview) throw new Error('aperçu non lancé');
  return state.preview;
}

const heroEl = () => document.querySelector('#app .hero') as HTMLElement;

beforeAll(async () => {
  // Squelette réel : les modules de lecture lisent le lecteur à l'import.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() { /* sans effet */ } disconnect() { /* sans effet */ } };
  }
  catalog = await import('../src/ui/catalog.js');
  hero = await import('../src/ui/hero.js');
  preview = await import('../src/ui/preview.js');
  state = (await import('../src/ui/state.js')).state as unknown as typeof state;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  state.inDetail = false;
  document.getElementById('app')!.innerHTML = '';
});

afterEach(() => {
  preview.stopPreview();
  hero.stopHero();
  vi.useRealTimers();
});

describe('héros de l’accueil : mode cinéma avec le son', () => {
  it('son activé : le héros passe en mode cinéma et la barre du haut s’atténue ; son coupé : affichage normal', async () => {
    mountCarousel([1, 2, 3]);
    const p = await startPreviewOnCurrent();
    expect(heroEl().classList.contains('is-cinema')).toBe(false);

    preview.setPreviewSound(p.iframe, true, false);
    expect(heroEl().classList.contains('is-cinema')).toBe(true);
    expect(heroEl().parentElement!.classList.contains('hero-cinema')).toBe(true);

    preview.setPreviewSound(p.iframe, false, false);
    expect(heroEl().classList.contains('is-cinema')).toBe(false);
    expect(heroEl().parentElement!.classList.contains('hero-cinema')).toBe(false);
  });

  it('l’arrêt de l’aperçu retire le mode cinéma, même son activé', async () => {
    mountCarousel([1, 2, 3]);
    const p = await startPreviewOnCurrent();
    preview.setPreviewSound(p.iframe, true, false);
    preview.stopPreview();
    expect(heroEl().classList.contains('is-cinema')).toBe(false);
    expect(heroEl().parentElement!.classList.contains('hero-cinema')).toBe(false);
  });

  it('le carrousel ne défile pas tant que le son est actif, et reprend à l’arrêt de l’aperçu', async () => {
    const items = mountCarousel([1, 2, 3]);
    const p = await startPreviewOnCurrent();
    preview.setPreviewSound(p.iframe, true, false);
    const shown = shownKey();
    vi.advanceTimersByTime(10000 * 3);
    expect(shownKey()).toBe(shown);

    preview.stopPreview();
    vi.advanceTimersByTime(10000 * 2);
    expect(shownKey()).not.toBe(shown);
    expect(items.map((x) => x.key)).toContain(shownKey());
  });

  it('muet, le cadre est centré ; avec le son, il garde le bas de l’image : les sous-titres ne sont pas recadrés', async () => {
    mountCarousel([1, 2, 3]);
    const p = await startPreviewOnCurrent();
    Object.defineProperty(p.media, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(p.media, 'offsetHeight', { value: 450, configurable: true });
    preview.fitPreview(p);
    // Cadre 1,12 × la fenêtre (504 px de haut) : muet, le débordement se partage entre le haut et le bas.
    expect(parseFloat(p.iframe.style.top)).toBeCloseTo(-27, 6);
    preview.setPreviewSound(p.iframe, true, false);
    // Son activé : le bord bas coïncide avec le bas de la fenêtre.
    expect(parseFloat(p.iframe.style.top)).toBeCloseTo(-54, 6);
    expect(parseFloat(p.iframe.style.top) + parseFloat(p.iframe.style.height)).toBeCloseTo(450, 6);
  });
});

describe('héros de l’accueil : fin de la bande-annonce', () => {
  it('la bande-annonce ne boucle pas et sa fin fait passer au titre suivant', async () => {
    mountCarousel([1, 2, 3]);
    const p = await startPreviewOnCurrent();
    expect(p.iframe.src).toContain('loop=0');
    p.iframe.dispatchEvent(new Event('load'));
    const before = shownKey();
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ info: { playerState: 0 } }), origin: 'https://www.youtube-nocookie.com', source: p.iframe.contentWindow }));
    expect(shownKey()).not.toBe(before);
    expect(state.preview).toBeNull();
  });
});

describe('aperçu sans héros (fiche, grille) : pas de mode cinéma', () => {
  it('un aperçu hors du héros ignore le son sans toucher aux classes du héros', () => {
    const outside = document.createElement('div');
    outside.innerHTML = '<iframe></iframe>';
    document.body.appendChild(outside);
    preview.setPreviewSound(outside.querySelector('iframe') as HTMLIFrameElement, true, false);
    expect(document.querySelector('.is-cinema')).toBeNull();
    expect(document.querySelector('.hero-cinema')).toBeNull();
    outside.remove();
  });
});
