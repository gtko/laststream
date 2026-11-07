import { describe, expect, it } from 'vitest';
import { isFullyWatched, SEEN_PROGRESS_RATIO, type SeenStore } from '../src/data/seen';

const store = (seen: string[] = [], progress: Record<string, { position: number; duration: number }> = {}): SeenStore => ({
  isWatched: (k) => seen.includes(k),
  getProgress: (k) => progress[k] ?? null,
});

describe('isFullyWatched', () => {
  it('seuil de lecture à 90 %', () => {
    expect(SEEN_PROGRESS_RATIO).toBe(0.9);
  });

  it('un film marqué vu est vu', () => {
    expect(isFullyWatched({ type: 'movie', id: 550 }, store(['movie:550']))).toBe(true);
  });

  it('un film regardé à 90 % ou plus est vu, à 89 % non', () => {
    expect(isFullyWatched({ type: 'movie', id: 550 }, store([], { 'movie:550': { position: 90, duration: 100 } }))).toBe(true);
    expect(isFullyWatched({ type: 'movie', id: 550 }, store([], { 'movie:550': { position: 89, duration: 100 } }))).toBe(false);
  });

  it('un film sans durée connue n’est pas vu', () => {
    expect(isFullyWatched({ type: 'movie', id: 550 }, store([], { 'movie:550': { position: 50, duration: 0 } }))).toBe(false);
  });

  it('une série commencée n’est pas vue, même épisodes marqués', () => {
    expect(isFullyWatched({ type: 'tv', id: 1399 }, store(['tv:1399:1:1', 'tv:1399:1:2']))).toBe(false);
  });

  it('une série marquée vue en entier est vue', () => {
    expect(isFullyWatched({ type: 'tv', id: 1399 }, store(['tv:1399:1:1']), new Set(['tv:1399']))).toBe(true);
  });

  it('une progression d’épisode ne rend pas une série vue', () => {
    expect(isFullyWatched({ type: 'tv', id: 1399 }, store([], { 'tv:1399': { position: 100, duration: 100 } }))).toBe(false);
  });

  it('accepte une clé explicite', () => {
    expect(isFullyWatched({ type: 'movie', id: 1, key: 'movie:2' }, store(['movie:2']))).toBe(true);
  });
});
