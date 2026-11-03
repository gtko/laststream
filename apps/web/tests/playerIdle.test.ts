// Masquage unique des surcouches du lecteur après UI_IDLE_MS d'inactivité (LAST-1613) : minuterie, réveil, exceptions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniState } from '../src/player/mini';
import { requestWake, UI_IDLE_MS } from '../src/player/idle';
import { createPlayerUI } from '../src/player/ui.js';

type UI = ReturnType<typeof createPlayerUI>;
let ui: UI;
const root = () => document.querySelector('.lp') as HTMLElement;
const visible = () => root().classList.contains('is-ui');
const play = (paused: boolean) => ui.update({ paused, time: 10, duration: 100, buffered: [], volume: 1, muted: false } as never);
const sec = (n: number) => vi.advanceTimersByTime(n * 1000);

function mount(): UI {
  const storage = new Map<string, string>();
  const miniState = new MiniState({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
  return createPlayerUI({ miniState, action: () => undefined, miniLayout: () => undefined, panelOpened: () => undefined, panelClosed: () => undefined, thumb: () => undefined, thumbCancel: () => undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="app"></div>';
  ui = mount();
  ui.show();
  ui.setPhase('ready');
  play(false);
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('masquage après 10 s', () => {
  it('le délai est de 10 s', () => { expect(UI_IDLE_MS).toBe(10_000); });

  it('masque tout juste après 10 s sans mouvement, pas avant', () => {
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(UI_IDLE_MS - 1);
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible()).toBe(false);
  });

  it('un mouvement réaffiche puis relance les 10 s', () => {
    vi.advanceTimersByTime(UI_IDLE_MS);
    expect(visible()).toBe(false);
    root().dispatchEvent(new Event('mousemove'));
    expect(visible()).toBe(true);
    sec(9);
    root().dispatchEvent(new Event('mousemove'));
    sec(9);
    expect(visible()).toBe(true);
    sec(1);
    expect(visible()).toBe(false);
  });

  it('un toucher et un événement important réaffichent', () => {
    vi.advanceTimersByTime(UI_IDLE_MS);
    root().dispatchEvent(new Event('touchstart'));
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(UI_IDLE_MS);
    expect(visible()).toBe(false);
    requestWake(root().querySelector('.lp-watchchip'));
    expect(visible()).toBe(true);
  });
});

describe('exceptions', () => {
  it('rien n\'est masqué en pause', () => {
    play(true);
    vi.advanceTimersByTime(UI_IDLE_MS * 3);
    expect(visible()).toBe(true);
  });

  it('rien n\'est masqué pendant une saisie dans le chat', () => {
    const input = document.createElement('input');
    input.name = 'text';
    root().appendChild(input);
    input.focus();
    root().dispatchEvent(new Event('mousemove'));
    vi.advanceTimersByTime(UI_IDLE_MS * 2);
    expect(visible()).toBe(true);
    input.blur();
    vi.advanceTimersByTime(UI_IDLE_MS);
    expect(visible()).toBe(false);
  });

  it('rien n\'est masqué tant que la souris survole une surcouche', () => {
    const chip = root().querySelector('.lp-watchchip') as HTMLElement;
    const spy = vi.spyOn(root(), 'querySelector').mockImplementation(((sel: string) => (sel.endsWith(':hover') ? chip : Element.prototype.querySelector.call(root(), sel))) as never);
    vi.advanceTimersByTime(UI_IDLE_MS * 2);
    expect(visible()).toBe(true);
    spy.mockRestore();
    vi.advanceTimersByTime(UI_IDLE_MS);
    expect(visible()).toBe(false);
  });

  it('une nouvelle puce « regarde aussi » réaffiche les surcouches', () => {
    vi.advanceTimersByTime(UI_IDLE_MS);
    expect(visible()).toBe(false);
    ui.setFriendChip({ initial: 'O', color: '#fff', name: 'Olivier', pos: 71 } as never);
    expect(visible()).toBe(true);
  });
});
