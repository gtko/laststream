// Animation d'ouverture et de fermeture du lecteur plein écran (LAST-173) : lp-covered attend la fin du fondu, hide() est asynchrone,
// une réouverture pendant la fermeture reprend la main, et mpv ne rend la page transparente qu'une fois le lecteur opaque.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBackdrop } from '../src/player/backdrop';
import { MpvEngine } from '../src/player/engines.js';
import { MiniState } from '../src/player/mini';
import * as ps from '../src/player/playerState';
import { createPlayerUI } from '../src/player/ui.js';

type UI = ReturnType<typeof createPlayerUI>;
let ui: UI;
let stopBackdrop: () => void;
const body = () => document.body.classList;

function mount() {
  const storage = new Map<string, string>();
  const miniState = new MiniState({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
  return createPlayerUI({ miniState, action: () => undefined, miniLayout: () => undefined, panelOpened: () => undefined, panelClosed: () => undefined, thumb: () => undefined, thumbCancel: () => undefined });
}

/** Ouverture comme session.js : show() puis état plein écran. */
function open() {
  ui.show();
  ps.set({ open: true, mini: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app"></div>';
  ui = mount();
  stopBackdrop = initBackdrop();
});
afterEach(() => {
  stopBackdrop();
  ps.set({ open: false, mini: false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ouverture', () => {
  it('is-entering pendant le fondu, lp-covered seulement à la fin', () => {
    open();
    expect(ui.root.hidden).toBe(false);
    expect(ui.root.classList.contains('is-entering')).toBe(true);
    expect(body().contains('lp-full')).toBe(true);
    expect(body().contains('lp-covered')).toBe(false);
    vi.advanceTimersByTime(319);
    expect(body().contains('lp-covered')).toBe(false);
    vi.advanceTimersByTime(2);
    expect(ui.root.classList.contains('is-entering')).toBe(false);
    expect(body().contains('lp-covered')).toBe(true);
  });

  it('animationend termine le fondu sans attendre le repli', () => {
    open();
    ui.root.dispatchEvent(new Event('animationend'));
    expect(ui.root.classList.contains('is-entering')).toBe(false);
    expect(body().contains('lp-covered')).toBe(true);
  });

  it('un lecteur déjà visible (changement de média) ne rejoue pas l’animation', () => {
    open();
    vi.advanceTimersByTime(400);
    ui.show();
    expect(ui.root.classList.contains('is-entering')).toBe(false);
    expect(body().contains('lp-covered')).toBe(true);
  });

  it('lp-covered retiré en miniature, replacé au retour en plein écran', () => {
    open();
    vi.advanceTimersByTime(400);
    ps.set({ mini: true });
    expect(body().contains('lp-covered')).toBe(false);
    ps.set({ mini: false });
    expect(body().contains('lp-covered')).toBe(true);
  });
});

describe('fermeture', () => {
  beforeEach(() => { open(); vi.advanceTimersByTime(400); });

  it('is-closing puis hidden au repli ; fond #000 opaque (is-mpv / is-video retirés) et page démasquée', async () => {
    ui.root.classList.add('is-mpv', 'is-video');
    const done = ui.hide();
    expect(ui.root.classList.contains('is-closing')).toBe(true);
    expect(ui.root.hidden).toBe(false);
    expect(ui.root.classList.contains('is-mpv')).toBe(false);
    expect(ui.root.classList.contains('is-video')).toBe(false);
    expect(body().contains('lp-covered')).toBe(false);
    vi.advanceTimersByTime(261);
    await expect(done).resolves.toBe(true);
    expect(ui.root.hidden).toBe(true);
    expect(ui.root.classList.contains('is-closing')).toBe(false);
  });

  it('animationend ferme sans attendre le repli', async () => {
    const done = ui.hide();
    ui.root.dispatchEvent(new Event('animationend'));
    await expect(done).resolves.toBe(true);
    expect(ui.root.hidden).toBe(true);
  });

  it('réouverture pendant la fermeture : hide() résout false et le lecteur reste affiché', async () => {
    const done = ui.hide();
    ui.show();
    await expect(done).resolves.toBe(false);
    expect(ui.root.hidden).toBe(false);
    expect(ui.root.classList.contains('is-closing')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(ui.root.hidden).toBe(false);
    expect(body().contains('lp-covered')).toBe(true);
  });

  it('depuis la miniature (instant) : masqué tout de suite', async () => {
    await expect(ui.hide(true)).resolves.toBe(true);
    expect(ui.root.hidden).toBe(true);
    expect(ui.root.classList.contains('is-closing')).toBe(false);
  });

  it('prefers-reduced-motion : masqué tout de suite', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() { /* sans effet */ }, removeEventListener() { /* sans effet */ } }));
    await expect(ui.hide()).resolves.toBe(true);
    expect(ui.root.hidden).toBe(true);
  });

  it('déjà masqué : résout tout de suite', async () => {
    await ui.hide(true);
    await expect(ui.hide()).resolves.toBe(true);
  });
});

describe('mpv : première image', () => {
  function engine() {
    document.body.insertAdjacentHTML('beforeend', '<div id="host"></div>');
    const ipc = { send: () => undefined, on: () => ipc };
    const e = new MpvEngine(ipc, document.getElementById('host'));
    e.live = true;
    return e;
  }

  it('plein écran : la page reste opaque tant que lp-covered est absent, puis devient transparente', () => {
    const e = engine();
    open();
    e.showVideo();
    expect(e.transparent).toBe(false);
    expect(document.body.style.background).toBe('');
    vi.advanceTimersByTime(400); // fin du fondu : lp-covered
    expect(e.transparent).toBe(true);
    expect(document.body.style.background).toBe('transparent');
    e.destroy();
  });

  it('première image avant la fin du fondu puis miniature : plus d’attente', () => {
    const e = engine();
    open();
    e.showVideo();
    expect(e.transparent).toBe(false);
    ps.set({ mini: true });
    expect(e.transparent).toBe(true);
    e.destroy();
  });

  it('lecteur détruit pendant l’attente : aucune transparence tardive', () => {
    const e = engine();
    open();
    e.showVideo();
    e.destroy();
    vi.advanceTimersByTime(400);
    expect(e.transparent).toBe(false);
  });

  it('hors plein écran : immédiat', () => {
    const e = engine();
    e.showVideo();
    expect(e.transparent).toBe(true);
    e.destroy();
  });
});
