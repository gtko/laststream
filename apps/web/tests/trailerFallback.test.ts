import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrailerFailed } from '../src/data/trailerHealth';
import { guardAmbient, guardEmbed, hideTrailerButtons, nextTrailer } from '../src/ui/trailerFallback.js';

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const detail = () => ({ trailer: 'a', trailerVO: false, trailers: [{ key: 'a', vo: false }, { key: 'b', vo: true }, { key: 'c', vo: false }] });

function fakeIframe() {
  const win = { postMessage: vi.fn() };
  const iframe = document.createElement('iframe');
  Object.defineProperty(iframe, 'contentWindow', { value: win });
  return { iframe, win };
}
function emit(data: unknown, source: unknown) {
  const ev = new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}
const err = (info: number) => ({ event: 'onError', info });
const state = (playerState: number) => ({ event: 'infoDelivery', info: { playerState } });

describe('nextTrailer', () => {
  it('passe à la suivante, met à jour le détail et mémorise l’échec', () => {
    const d = detail();
    expect(nextTrailer(d, 'a')).toEqual({ key: 'b', vo: true });
    expect(d).toMatchObject({ trailer: 'b', trailerVO: true });
    expect(isTrailerFailed('a')).toBe(true);
    expect(nextTrailer(d, 'b')).toEqual({ key: 'c', vo: false });
    expect(nextTrailer(d, 'c')).toBeNull();
    expect(d).toMatchObject({ trailer: '', trailerVO: false, trailers: [] });
  });
  it('sans détail : mémorise seulement', () => {
    expect(nextTrailer(null, 'z')).toBeNull();
    expect(isTrailerFailed('z')).toBe(true);
  });
});

describe('guardEmbed', () => {
  it('s’abonne à l’API, signale l’erreur une seule fois', () => {
    const { iframe, win } = fakeIframe();
    const onFail = vi.fn(); const onPlaying = vi.fn();
    guardEmbed(iframe, { onFail, onPlaying });
    expect(win.postMessage).toHaveBeenCalledWith(expect.stringContaining('"listening"'), '*');
    emit(err(101), win);
    emit(err(150), win);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith(101);
    vi.advanceTimersByTime(5000);
    expect(onPlaying).not.toHaveBeenCalled();
  });
  it('ignore les messages d’une autre fenêtre', () => {
    const { iframe } = fakeIframe();
    const onFail = vi.fn();
    guardEmbed(iframe, { onFail });
    emit(err(100), {});
    expect(onFail).not.toHaveBeenCalled();
  });
  it('onPlaying à la première lecture, une seule fois', () => {
    const { iframe, win } = fakeIframe();
    const onPlaying = vi.fn();
    guardEmbed(iframe, { onPlaying });
    emit(state(1), win);
    emit(state(1), win);
    vi.advanceTimersByTime(5000);
    expect(onPlaying).toHaveBeenCalledTimes(1);
  });
  it('onPlaying aussi au tampon (état 3), pas aux autres états', () => {
    const { iframe, win } = fakeIframe();
    const onPlaying = vi.fn();
    guardEmbed(iframe, { onPlaying });
    emit(state(-1), win);
    expect(onPlaying).not.toHaveBeenCalled();
    emit(state(3), win);
    expect(onPlaying).toHaveBeenCalledTimes(1);
  });
  it('onPlaying après revealMs sans erreur', () => {
    const { iframe } = fakeIframe();
    const onPlaying = vi.fn();
    guardEmbed(iframe, { onPlaying, revealMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(onPlaying).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPlaying).toHaveBeenCalledTimes(1);
  });
  it('l’annulation est idempotente et coupe tout', () => {
    const { iframe, win } = fakeIframe();
    const onFail = vi.fn(); const onPlaying = vi.fn();
    const cancel = guardEmbed(iframe, { onFail, onPlaying });
    cancel(); cancel();
    emit(err(101), win);
    emit(state(1), win);
    vi.advanceTimersByTime(5000);
    expect(onFail).not.toHaveBeenCalled();
    expect(onPlaying).not.toHaveBeenCalled();
  });
});

describe('guardAmbient', () => {
  const setup = () => {
    const { iframe, win } = fakeIframe();
    const d = detail();
    const o = { srcFor: (k: string) => 'https://yt/' + k, onReveal: vi.fn(), onSwap: vi.fn(), onReload: vi.fn(), onExhausted: vi.fn() };
    const stop = guardAmbient(iframe, d, 'a', o);
    return { iframe, win, d, o, stop };
  };
  it('erreur : change l’adresse vers la candidate suivante, puis épuise', () => {
    const { iframe, win, d, o } = setup();
    iframe.dispatchEvent(new Event('load'));
    emit(err(101), win);
    expect(iframe.getAttribute('src')).toBe('https://yt/b');
    expect(o.onSwap).toHaveBeenCalledWith({ key: 'b', vo: true });
    iframe.dispatchEvent(new Event('load'));
    expect(o.onReload).toHaveBeenCalledTimes(1);
    emit(err(150), win);
    expect(iframe.getAttribute('src')).toBe('https://yt/c');
    iframe.dispatchEvent(new Event('load'));
    emit(err(100), win);
    expect(o.onExhausted).toHaveBeenCalledTimes(1);
    expect(d.trailer).toBe('');
    expect(o.onReveal).not.toHaveBeenCalled();
  });
  it('lecture saine : onReveal, pas de changement', () => {
    const { iframe, win, o } = setup();
    iframe.dispatchEvent(new Event('load'));
    emit(state(1), win);
    expect(o.onReveal).toHaveBeenCalledTimes(1);
    expect(o.onSwap).not.toHaveBeenCalled();
  });
  it('arrêt : plus aucune réaction', () => {
    const { iframe, win, o, stop } = setup();
    iframe.dispatchEvent(new Event('load'));
    stop();
    emit(err(101), win);
    expect(o.onSwap).not.toHaveBeenCalled();
    expect(o.onExhausted).not.toHaveBeenCalled();
  });
});

describe('hideTrailerButtons', () => {
  const html = '<button data-trailer="k"></button><button data-vid="a"></button><button data-vid="x" class="vid"></button>';
  it('retire tous les boutons de bande-annonce', () => {
    const root = document.createElement('div');
    root.innerHTML = html;
    hideTrailerButtons(root);
    expect(root.children).toHaveLength(0);
  });
  it('avec des clés : seulement les vidéos concernées', () => {
    const root = document.createElement('div');
    root.innerHTML = html;
    hideTrailerButtons(root, ['a']);
    expect(root.querySelectorAll('[data-vid]')).toHaveLength(1);
    expect(root.querySelector('[data-trailer]')).not.toBeNull();
  });
});
