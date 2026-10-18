import { describe, expect, it } from 'vitest';
import {
  audioSchedule,
  canFeed,
  DRIFT_SEEK_THRESHOLD_S,
  expectedPosition,
  mediaClock,
  needsResync,
  pickFrame,
} from './sync';

describe('expectedPosition', () => {
  it('renvoie la position telle quelle quand le salon est en pause', () => {
    expect(expectedPosition({ playing: false, position: 42, at: 1000 }, 99_000)).toBe(42);
  });

  it('extrapole la position quand le salon lit', () => {
    // 10 s au moment de `at`, 2,5 s plus tard.
    expect(expectedPosition({ playing: true, position: 10, at: 1000 }, 3500)).toBeCloseTo(12.5, 6);
  });

  it("ne va pas en arrière si l'horodatage du salon est dans le futur", () => {
    expect(expectedPosition({ playing: true, position: 10, at: 5000 }, 1000)).toBe(10);
  });

  it('borne la position à la durée connue, et à 0 au minimum', () => {
    expect(expectedPosition({ playing: true, position: 58, at: 0 }, 10_000, 60)).toBe(60);
    expect(expectedPosition({ playing: false, position: -3, at: 0 }, 0)).toBe(0);
  });
});

describe('needsResync (dérive)', () => {
  it('ne recale pas tant que l’écart reste sous 0,5 s', () => {
    expect(DRIFT_SEEK_THRESHOLD_S).toBe(0.5);
    expect(needsResync(10.3, 10)).toBe(false);
    expect(needsResync(9.6, 10)).toBe(false);
  });

  it('recale au-delà de 0,5 s, dans les deux sens', () => {
    expect(needsResync(10.6, 10)).toBe(true);
    expect(needsResync(9.4, 10)).toBe(true);
  });

  it('ne recale pas à exactement 0,5 s (seuil strict)', () => {
    expect(needsResync(10.5, 10)).toBe(false);
  });

  it('détecte la dérive d’un invité qui prend du retard pendant une lecture', () => {
    // Le salon lit depuis la seconde 10 à l'instant 1000 ms. L'invité avance de 1 s entre deux contrôles,
    // sans que le salon bouge : seul le contrôle à 3000 ms voit un écart de plus de 0,5 s.
    const room = { playing: true, position: 10, at: 1000 };
    const local = [10.9, 11.9, 12.9];
    const verdicts = local.map((pos, i) => needsResync(pos, expectedPosition(room, 1000 + i * 1000)));
    expect(verdicts).toEqual([true, true, true]);
    // Après recalage sur la cible, l'invité suit de nouveau sans correction.
    expect(needsResync(expectedPosition(room, 2000) + 0.2, expectedPosition(room, 2000))).toBe(false);
  });
});

describe('mediaClock', () => {
  it('avance avec l’horloge maîtresse quand la lecture tourne', () => {
    expect(mediaClock(5, 100, 101.5, true)).toBeCloseTo(6.5, 9);
  });

  it('reste figée à l’ancre en pause', () => {
    expect(mediaClock(5, 100, 250, false)).toBe(5);
  });
});

describe('pickFrame', () => {
  it('ne trouve rien sans image ou si toutes sont futures', () => {
    expect(pickFrame([], 1)).toBe(-1);
    expect(pickFrame([2, 2.04], 1)).toBe(-1);
  });

  it('choisit la dernière image dont l’horodatage ne dépasse pas l’horloge', () => {
    expect(pickFrame([0.9, 0.93, 0.97, 1.02], 1)).toBe(2);
  });

  it('tolère quelques millisecondes d’avance', () => {
    expect(pickFrame([1.004], 1)).toBe(0);
    expect(pickFrame([1.02], 1)).toBe(-1);
  });

  it('donne la dernière image quand la file est en retard', () => {
    expect(pickFrame([0, 0.04, 0.08], 9)).toBe(2);
  });
});

describe('canFeed (buffering borné)', () => {
  const limits = { maxQueue: 6, maxDecodeQueue: 8, maxAheadSec: 2 };

  it('autorise le décodage tant que chaque plafond n’est pas atteint', () => {
    expect(canFeed({ queued: 5, decodeQueue: 7, aheadSec: 1.9 }, limits)).toBe(true);
  });

  it('bloque dès qu’un plafond est atteint', () => {
    expect(canFeed({ queued: 6, decodeQueue: 0, aheadSec: 0 }, limits)).toBe(false);
    expect(canFeed({ queued: 0, decodeQueue: 8, aheadSec: 0 }, limits)).toBe(false);
    expect(canFeed({ queued: 0, decodeQueue: 0, aheadSec: 2 }, limits)).toBe(false);
  });
});

describe('audioSchedule', () => {
  it('programme un segment futur à sa place sur l’horloge audio', () => {
    // Ancre : média 10 s == horloge audio 50 s. Segment à 10,5 s -> 50,5 s.
    expect(audioSchedule(10.5, 10, 50, 50.2)).toEqual({ when: 50.5, offset: 0 });
  });

  it('démarre un segment déjà passé au présent, décalé dans le segment', () => {
    // Segment à 9,8 s (ancre 10 s, horloge 50 s) : il devait commencer à 49,8 s, on est à 50,1 s.
    const { when, offset } = audioSchedule(9.8, 10, 50, 50.1);
    expect(when).toBeCloseTo(50.1, 9);
    expect(offset).toBeCloseTo(0.3, 9);
  });
});
