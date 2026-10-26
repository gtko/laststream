import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ps from '../src/player/playerState';

afterEach(() => ps.set({ open: false, mini: false }));

describe('état du lecteur (LAST-173)', () => {
  it('prédicats : plein écran = ouvert et non réduit', () => {
    expect(ps.get()).toEqual({ open: false, mini: false });
    expect(ps.isFull()).toBe(false);
    expect(ps.trailersAllowed()).toBe(true);
    expect(ps.fullTrailerAllowed()).toBe(true);
    ps.set({ open: true });
    expect(ps.isFull()).toBe(true);
    expect(ps.trailersAllowed()).toBe(false);
    expect(ps.fullTrailerAllowed()).toBe(false);
  });

  it('miniature : les aperçus reprennent, la bande-annonce de la fiche reste en pause', () => {
    ps.set({ open: true, mini: true });
    expect(ps.isFull()).toBe(false);
    expect(ps.trailersAllowed()).toBe(true);
    expect(ps.fullTrailerAllowed()).toBe(false);
    ps.set({ mini: false });
    expect(ps.isFull()).toBe(true);
    ps.set({ open: false, mini: false });
    expect(ps.fullTrailerAllowed()).toBe(true);
  });

  it('une seule notification par vrai changement, aucune pour un patch identique', () => {
    const fn = vi.fn();
    const evt = vi.fn();
    window.addEventListener('lsplayer:state', evt);
    const off = ps.onChange(fn);
    ps.set({ open: true, mini: false });
    ps.set({ open: true, mini: false });
    ps.set({});
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith({ open: true, mini: false });
    expect(evt).toHaveBeenCalledTimes(1);
    ps.set({ mini: true });
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    ps.set({ open: false, mini: false });
    expect(fn).toHaveBeenCalledTimes(2);
    window.removeEventListener('lsplayer:state', evt);
  });

  it('get() renvoie une copie', () => {
    const s = ps.get();
    s.open = true;
    expect(ps.get().open).toBe(false);
  });
});
