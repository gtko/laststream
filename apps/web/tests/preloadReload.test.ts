// Rechargement sur échec de chargement à la demande : une fois par fenêtre de 5 minutes, jamais hors ligne.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPreloadReload, RELOAD_GUARD_MS } from '../src/ui/preloadReload.js';

const reload = vi.fn();
let win: Window;
let store: Record<string, string>;

function fire() {
  const e = new Event('vite:preloadError', { cancelable: true });
  win.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  reload.mockClear();
  store = {};
  win = Object.assign(new EventTarget(), {
    navigator: { onLine: true },
    location: { reload },
    sessionStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
  }) as unknown as Window;
  installPreloadReload(win as Window & typeof globalThis);
});
afterEach(() => { vi.useRealTimers(); });

describe('installPreloadReload', () => {
  it('premier échec : un rechargement, erreur neutralisée', () => {
    const e = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('second échec dans les 5 minutes : rien', () => {
    fire();
    vi.advanceTimersByTime(RELOAD_GUARD_MS - 1000);
    const e = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('après 5 minutes : nouveau rechargement', () => {
    fire();
    vi.advanceTimersByTime(RELOAD_GUARD_MS + 1);
    fire();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('hors ligne : rien (l’état d’erreur s’affiche)', () => {
    (win as unknown as { navigator: { onLine: boolean } }).navigator.onLine = false;
    const e = fire();
    expect(reload).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(store['ls-preload-reload']).toBeUndefined();
  });

  it('sessionStorage qui lève : rien, sans exception', () => {
    (win as unknown as { sessionStorage: unknown }).sessionStorage = { getItem: () => { throw new Error('bloqué'); }, setItem: () => { throw new Error('bloqué'); } };
    expect(() => fire()).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });
});
