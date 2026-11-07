import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADDON_LIBRARY_KEY, ADDON_PROGRESS_KEY, addonTitleKey, getAddonProgress, isInAddonLibrary, readAddonLibrary, saveAddonProgress, toggleAddonLibrary,
} from '../src/data/addonUserStore';
import { LIBRARY_KEY, PROGRESS_KEY } from '../src/data/userStore';

const entry = (id: string, type = 'anime') => ({ key: addonTitleKey(type, id), addonKey: 'https://a.test', type, id, title: 'Titre ' + id });

beforeEach(() => localStorage.clear());

describe('addonUserStore', () => {
  it('la clé de titre est addon:type:id', () => {
    expect(addonTitleKey('anime', 'fk:1')).toBe('addon:anime:fk:1');
  });

  it('toggleAddonLibrary ajoute puis retire, et renvoie l’état après l’appel', () => {
    expect(isInAddonLibrary('addon:anime:fk:1')).toBe(false);
    expect(toggleAddonLibrary(entry('fk:1'))).toBe(true);
    expect(isInAddonLibrary('addon:anime:fk:1')).toBe(true);
    expect(readAddonLibrary()[0]).toMatchObject({ key: 'addon:anime:fk:1', id: 'fk:1', title: 'Titre fk:1' });
    expect(readAddonLibrary()[0].addedAt).toBeGreaterThan(0);
    expect(toggleAddonLibrary(entry('fk:1'))).toBe(false);
    expect(readAddonLibrary()).toEqual([]);
  });

  it('la plus récente est en tête', () => {
    toggleAddonLibrary({ ...entry('fk:1'), addedAt: 10 });
    toggleAddonLibrary({ ...entry('fk:2'), addedAt: 20 });
    expect(readAddonLibrary().map((e) => e.id)).toEqual(['fk:2', 'fk:1']);
  });

  it('stocke à part de la bibliothèque et de la progression TMDB', () => {
    toggleAddonLibrary(entry('fk:1'));
    saveAddonProgress('addon:anime:fk:1', { t: 40, d: 100, at: 5 });
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    expect(localStorage.getItem(LIBRARY_KEY)).toBeNull();
    expect(localStorage.getItem(ADDON_LIBRARY_KEY)).not.toBeNull();
    expect(localStorage.getItem(ADDON_PROGRESS_KEY)).not.toBeNull();
  });

  it('progression : enregistre et relit, épisode compris', () => {
    expect(getAddonProgress('addon:anime:fk:1')).toBeNull();
    saveAddonProgress('addon:anime:fk:1', { t: 61, d: 1400, at: 99, episode: { season: 1, episode: 3 } });
    saveAddonProgress('addon:movie:fk:2', { t: 5, d: 50, at: 100 });
    expect(getAddonProgress('addon:anime:fk:1')).toEqual({ t: 61, d: 1400, at: 99, episode: { season: 1, episode: 3 } });
    expect(getAddonProgress('addon:movie:fk:2')).toEqual({ t: 5, d: 50, at: 100 });
    saveAddonProgress('addon:anime:fk:1', { t: 70, d: 1400, at: 120, episode: { season: 1, episode: 4 } });
    expect(getAddonProgress('addon:anime:fk:1')?.episode).toEqual({ season: 1, episode: 4 });
  });

  it('refuse une position ou une durée invalide', () => {
    saveAddonProgress('k', { t: Number.NaN, d: 10, at: 1 });
    expect(getAddonProgress('k')).toBeNull();
  });

  it('JSON corrompu : listes vides, sans exception, et l’écriture suivante repart de zéro', () => {
    localStorage.setItem(ADDON_LIBRARY_KEY, '{pas du json');
    localStorage.setItem(ADDON_PROGRESS_KEY, '[1,2');
    expect(readAddonLibrary()).toEqual([]);
    expect(getAddonProgress('addon:anime:fk:1')).toBeNull();
    expect(toggleAddonLibrary(entry('fk:1'))).toBe(true);
    saveAddonProgress('addon:anime:fk:1', { t: 1, d: 2, at: 3 });
    expect(getAddonProgress('addon:anime:fk:1')).not.toBeNull();
  });

  it('entrées mal formées ignorées', () => {
    localStorage.setItem(ADDON_LIBRARY_KEY, JSON.stringify([{ key: 1 }, null, { ...entry('fk:9'), addedAt: 1 }]));
    expect(readAddonLibrary().map((e) => e.id)).toEqual(['fk:9']);
    localStorage.setItem(ADDON_PROGRESS_KEY, JSON.stringify({ a: { t: 'x' }, b: 'y' }));
    expect(getAddonProgress('a')).toBeNull();
    expect(getAddonProgress('b')).toBeNull();
  });
});
