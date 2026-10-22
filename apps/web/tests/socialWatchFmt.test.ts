import { describe, expect, it } from 'vitest';
import { remainingLabel, watchState } from '../src/ui/socialFmt.js';

describe('carte « En train de regarder » : formats', () => {
  it('remainingLabel : minutes, heures, terminé, durée inconnue', () => {
    expect(remainingLabel({ paused: true, pos: 600, duration: 3600 })).toBe('reste 50 min');
    expect(remainingLabel({ paused: true, pos: 0, duration: 3900 })).toBe('reste 1 h 05');
    expect(remainingLabel({ paused: true, pos: 5000, duration: 3600 })).toBe('terminé');
    expect(remainingLabel({ paused: true, pos: 600 })).toBe('');
  });

  it('watchState : lecture, pause récente, pause ancienne, movedAt absent', () => {
    const now = 10_000_000;
    expect(watchState({ paused: false }, now)).toEqual({ paused: false, label: 'En lecture' });
    expect(watchState({ paused: true, movedAt: now - 30_000 }, now).label).toBe('En pause');
    expect(watchState({ paused: true, movedAt: now - 4 * 60_000 }, now)).toEqual({ paused: true, label: 'En pause · 4 min' });
    expect(watchState({ paused: true }, now).label).toBe('En pause');
  });
});
