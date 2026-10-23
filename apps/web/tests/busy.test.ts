// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elKey, isLocked, MAX_LOCK_MS, PLAY_COOLDOWN_MS, resetBusy, runOnce, setBusy, TOGGLE_COOLDOWN_MS } from '../src/ui/busy.js';

beforeEach(() => { vi.useFakeTimers(); resetBusy(); });
afterEach(() => { vi.useRealTimers(); });

describe('runOnce (ODY-237)', () => {
  it('un double ou triple clic synchrone ne lance l’action qu’une fois (délai de redéclenchement)', () => {
    const fn = vi.fn(() => 1);
    for (let i = 0; i < 3; i++) runOnce('lib', fn, { cooldown: TOGGLE_COOLDOWN_MS });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('relance possible une fois le délai écoulé', () => {
    const fn = vi.fn();
    runOnce('lib', fn, { cooldown: 300 });
    vi.advanceTimersByTime(299);
    runOnce('lib', fn, { cooldown: 300 });
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    runOnce('lib', fn, { cooldown: 300 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('une action asynchrone en cours n’est pas relancée, et le bouton passe en « en cours » tout de suite', async () => {
    const btn = document.createElement('button');
    let finish!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const p = runOnce('play', fn, { el: btn });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.classList.contains('is-busy')).toBe(true);
    expect(btn.disabled).toBe(false); // reste focusable (télécommande)
    expect(runOnce('play', fn, { el: btn })).toBeUndefined();
    expect(runOnce('play', fn, { el: btn })).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    finish();
    await p;
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    expect(btn.hasAttribute('aria-disabled')).toBe(false);
    expect(isLocked('play')).toBe(false);
    runOnce('play', fn, { el: btn });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('une erreur synchrone ou asynchrone libère le verrou et remonte', async () => {
    const btn = document.createElement('button');
    expect(() => runOnce('k', () => { throw new Error('boom'); }, { el: btn })).toThrow('boom');
    expect(isLocked('k')).toBe(false);
    await expect(runOnce('k', () => Promise.reject(new Error('net')), { el: btn })).rejects.toThrow('net');
    expect(isLocked('k')).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('le verrou tombe seul après la durée maximale si l’action ne rend jamais la main', () => {
    const btn = document.createElement('button');
    runOnce('stuck', () => new Promise(() => {}), { el: btn });
    expect(isLocked('stuck')).toBe(true);
    vi.advanceTimersByTime(MAX_LOCK_MS + 1);
    expect(isLocked('stuck')).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('des actions de clés différentes ne se bloquent pas entre elles', () => {
    const a = vi.fn();
    const b = vi.fn();
    runOnce('a', a, { cooldown: 500 });
    runOnce('b', b, { cooldown: 500 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('rend son aria-disabled d’origine à la fin (bouton « indisponible »)', () => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-disabled', 'true');
    runOnce('na', () => 1, { el: btn });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  it('lecture : le double clic est ignoré, mais réappuyer après le délai relance (le lecteur a pu être fermé entre-temps)', () => {
    const btn = document.createElement('button');
    const launch = vi.fn(() => { void new Promise(() => {}); }); // la recherche de sources n'est pas attendue
    runOnce('play', launch, { el: btn, cooldown: PLAY_COOLDOWN_MS });
    runOnce('play', launch, { el: btn, cooldown: PLAY_COOLDOWN_MS });
    expect(launch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PLAY_COOLDOWN_MS + 1);
    runOnce('play', launch, { el: btn, cooldown: PLAY_COOLDOWN_MS });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('elKey donne une clé stable par élément et distincte entre éléments', () => {
    const x = document.createElement('button');
    const y = document.createElement('button');
    expect(elKey('lib', x)).toBe(elKey('lib', x));
    expect(elKey('lib', x)).not.toBe(elKey('lib', y));
    setBusy(x, true);
    expect(x.getAttribute('aria-busy')).toBe('true');
    setBusy(x, false);
    expect(x.getAttribute('aria-busy')).toBeNull();
  });
});
