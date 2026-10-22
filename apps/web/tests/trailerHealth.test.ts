import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAIL_MAX, FAIL_STORAGE_KEY, FAIL_TTL_MS, isTrailerFailed, isUnplayableError, markTrailerFailed, parseYoutubeError,
} from '../src/data/trailerHealth';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('mémoire des bandes-annonces en échec', () => {
  it('une vidéo marquée est en échec, pas les autres', () => {
    markTrailerFailed('abc', 1000);
    expect(isTrailerFailed('abc', 1000)).toBe(true);
    expect(isTrailerFailed('xyz', 1000)).toBe(false);
    expect(isTrailerFailed('', 1000)).toBe(false);
  });
  it('l’échec expire après 7 jours', () => {
    markTrailerFailed('abc', 1000);
    expect(isTrailerFailed('abc', 1000 + FAIL_TTL_MS - 1)).toBe(true);
    expect(isTrailerFailed('abc', 1000 + FAIL_TTL_MS)).toBe(false);
  });
  it('purge les expirés à l’écriture suivante', () => {
    markTrailerFailed('vieux', 1000);
    markTrailerFailed('neuf', 1000 + FAIL_TTL_MS + 5);
    const stored = JSON.parse(localStorage.getItem(FAIL_STORAGE_KEY) ?? '{}');
    expect(Object.keys(stored)).toEqual(['neuf']);
  });
  it('plafonne le nombre d’entrées en gardant les plus récentes', () => {
    for (let i = 0; i < FAIL_MAX + 20; i++) markTrailerFailed('k' + i, 1000 + i);
    const stored = JSON.parse(localStorage.getItem(FAIL_STORAGE_KEY) ?? '{}');
    expect(Object.keys(stored)).toHaveLength(FAIL_MAX);
    expect(stored['k' + (FAIL_MAX + 19)]).toBeDefined();
    expect(stored.k0).toBeUndefined();
  });
  it('stockage corrompu : aucun échec, sans erreur', () => {
    localStorage.setItem(FAIL_STORAGE_KEY, '{pas du json');
    expect(isTrailerFailed('abc')).toBe(false);
    localStorage.setItem(FAIL_STORAGE_KEY, '[1,2]');
    expect(isTrailerFailed('abc')).toBe(false);
    localStorage.setItem(FAIL_STORAGE_KEY, JSON.stringify({ abc: 'hier' }));
    expect(isTrailerFailed('abc')).toBe(false);
  });
  it('localStorage indisponible : aucune erreur', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('bloqué'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('plein'); });
    expect(() => markTrailerFailed('abc')).not.toThrow();
    expect(isTrailerFailed('abc')).toBe(false);
  });
});

describe('erreurs de l’API IFrame', () => {
  it('lit le code des chaînes JSON et des objets', () => {
    for (const code of [2, 5, 100, 101, 150]) {
      expect(parseYoutubeError(JSON.stringify({ event: 'onError', info: code }))).toBe(code);
      expect(parseYoutubeError({ event: 'onError', info: code })).toBe(code);
      expect(isUnplayableError(code)).toBe(true);
    }
  });
  it('ignore tout le reste', () => {
    expect(parseYoutubeError('pas du json')).toBeNull();
    expect(parseYoutubeError(null)).toBeNull();
    expect(parseYoutubeError(42)).toBeNull();
    expect(parseYoutubeError(JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }))).toBeNull();
    expect(parseYoutubeError(JSON.stringify({ event: 'onError', info: '101' }))).toBeNull();
    expect(parseYoutubeError(JSON.stringify({ event: 'onError' }))).toBeNull();
    expect(isUnplayableError(null)).toBe(false);
  });
});
