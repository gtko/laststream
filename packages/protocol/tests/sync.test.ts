import { describe, expect, it } from 'vitest';
import { DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC, estimateOffset, expectedPosition } from '../src/sync.js';

describe('expectedPosition', () => {
  it('à l\'arrêt, la position ne bouge pas', () => {
    expect(expectedPosition({ playing: false, pos: 12, at: 1000 }, 9000)).toBe(12);
  });
  it('en lecture, avance avec l\'horloge serveur', () => {
    expect(expectedPosition({ playing: true, pos: 10, at: 1000 }, 3500)).toBe(12.5);
  });
  it('ignore une horloge en retard sur l\'état', () => {
    expect(expectedPosition({ playing: true, pos: 10, at: 5000 }, 1000)).toBe(10);
  });
  it('accepte un état avec rev', () => {
    expect(expectedPosition({ playing: true, pos: 0, at: 0, rev: 3 }, 2000)).toBe(2);
  });
});

describe('estimateOffset', () => {
  it('aller-retour symétrique', () => {
    expect(estimateOffset(1000, 1100, 5050)).toBe(4000);
  });
});

describe('seuils', () => {
  it('seuils de dérive communs', () => {
    expect([DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC]).toEqual([0.3, 2]);
  });
});
