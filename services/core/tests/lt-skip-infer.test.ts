import { describe, expect, it } from 'vitest';
import { consensus, inferCredits, inferIntro, type Span } from '../src/lt/skip-infer.js';
import { median } from '../src/user/skip-segments.js';

describe('médiane', () => {
  it('impair : valeur centrale ; pair : moyenne des deux centres', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('consensus des voisins (intro)', () => {
  it('tolérance de ±5 s sur le début et sur la durée : 4,9 s accepté, 10 s refusé', () => {
    const spans: Span[] = [
      { episode: 2, a: 10, b: 90 },
      { episode: 3, a: 14.9, b: 94.9 },
      { episode: 4, a: 25, b: 105 },
    ];
    const found = inferIntro(spans);
    expect(found?.start).toBeCloseTo(12.45, 9);
    expect(found?.end).toBeCloseTo(92.45, 9);
  });

  it('un seul épisode qui concorde ne suffit pas (deux voisins au minimum)', () => {
    expect(inferIntro([{ episode: 2, a: 10, b: 90 }])).toBeUndefined();
  });

  it('une durée différente de plus de 5 s ne concorde pas', () => {
    expect(
      inferIntro([
        { episode: 2, a: 10, b: 90 },
        { episode: 3, a: 10, b: 120 },
      ]),
    ).toBeUndefined();
  });

  it('le groupe le plus nombreux l’emporte', () => {
    const spans: Span[] = [
      { episode: 2, a: 60, b: 140 },
      { episode: 3, a: 10, b: 90 },
      { episode: 4, a: 11, b: 91 },
      { episode: 5, a: 12, b: 92 },
    ];
    expect(consensus(spans)).toEqual({ a: 11, b: 91, support: 3 });
  });
});

describe('générique déduit (par rapport à la fin)', () => {
  it('reporté sur la durée de la cible', () => {
    // Voisins : générique à 120 s de la fin, 10 s avant la fin (durée 2400 s).
    const spans: Span[] = [
      { episode: 2, a: 120, b: 10 },
      { episode: 3, a: 118, b: 8 },
      { episode: 4, a: 121, b: 11 },
    ];
    expect(inferCredits(spans, 2400)).toEqual({ start: 2280, end: 2390 });
  });

  it('refusé si la plage sort de l’épisode cible (durée plus courte)', () => {
    const spans: Span[] = [
      { episode: 2, a: 120, b: 10 },
      { episode: 3, a: 118, b: 8 },
      { episode: 4, a: 121, b: 11 },
    ];
    expect(inferCredits(spans, 100)).toBeUndefined();
  });
});
