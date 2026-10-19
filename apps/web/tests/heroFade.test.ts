import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { playBest } from '../src/player/session.js';
import { loadSources, prefetchSources } from '../src/sources/load';

// Le héros de l'accueil ne lance jamais la lecture ni la recherche de sources : seul le fondu des textes s'y applique.
vi.mock('../src/player/session.js', () => ({ playBest: vi.fn(() => Promise.resolve()), isPlayerOpen: vi.fn(() => false) }));
vi.mock('../src/sources/load', () => ({ loadSources: vi.fn(), prefetchSources: vi.fn() }));
vi.mock('../src/ui/catalog.js', () => ({ getDetail: vi.fn(async () => ({ trailer: 'abc', trailerVO: false })) }));

let startPreview: typeof import('../src/ui/preview.js').startPreview;
let stopPreview: typeof import('../src/ui/preview.js').stopPreview;
let state: { byKey: Map<string, unknown>; inDetail: boolean };
beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="toast"></div>'
    + '<div id="modal" hidden><div class="modal"><div id="modal-body"></div><button id="modal-close"></button></div></div>';
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() { /* sans effet */ } disconnect() { /* sans effet */ } };
  }
  ({ startPreview, stopPreview } = await import('../src/ui/preview.js'));
  ({ state } = await import('../src/ui/state.js') as unknown as { state: typeof state });
});

beforeEach(() => {
  vi.clearAllMocks();
  state.inDetail = false;
  state.byKey.set('movie:1', { key: 'movie:1', name: 'Film' });
  document.getElementById('app')!.innerHTML = '<section class="hero hero-carousel"><div class="hero-slide is-current">'
    + '<div class="hero-bg" data-media="movie:1"></div><div class="hero-content"><h1 class="hero-title">Film</h1>'
    + '<p class="hero-desc">Résumé</p><div class="hero-actions"><button class="btn btn-primary">Lecture</button>'
    + '<button class="btn btn-ghost">Infos</button></div></div></div></section>';
});
afterEach(() => {
  vi.useRealTimers();
  stopPreview();
});

describe('mise en avant de l’accueil', () => {
  it('les textes de la diapositive s’estompent pendant la lecture, sans lancer la lecture ni chercher les sources', async () => {
    const media = document.querySelector('[data-media]') as HTMLElement;
    const slide = media.closest('.hero-slide') as HTMLElement;
    await startPreview(media);
    const iframe = media.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    vi.useFakeTimers();
    iframe.dispatchEvent(new Event('load'));
    const info = { playerState: 1, currentTime: 2, duration: 90 };
    const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'infoDelivery', info }) });
    Object.defineProperty(ev, 'source', { value: iframe.contentWindow });
    window.dispatchEvent(ev);
    vi.advanceTimersByTime(3999);
    expect(slide.classList.contains('is-quiet')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(slide.classList.contains('is-quiet')).toBe(true);
    expect(playBest).not.toHaveBeenCalled();
    expect(loadSources).not.toHaveBeenCalled();
    expect(prefetchSources).not.toHaveBeenCalled();
  });

  it('arrêter l’aperçu rétablit les textes', async () => {
    const media = document.querySelector('[data-media]') as HTMLElement;
    const slide = media.closest('.hero-slide') as HTMLElement;
    await startPreview(media);
    const iframe = media.querySelector('iframe') as HTMLIFrameElement;
    vi.useFakeTimers();
    iframe.dispatchEvent(new Event('load'));
    const ev = new MessageEvent('message', { data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }) });
    Object.defineProperty(ev, 'source', { value: iframe.contentWindow });
    window.dispatchEvent(ev);
    vi.advanceTimersByTime(4000);
    expect(slide.classList.contains('is-quiet')).toBe(true);
    stopPreview();
    expect(slide.classList.contains('is-quiet')).toBe(false);
    expect(playBest).not.toHaveBeenCalled();
  });
});
