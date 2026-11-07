import { describe, expect, it } from 'vitest';
import { HEAP_GROWTH_WARN_MB, MEMORY_EVERY_TICKS, MemoryWatch, memorySnapshot, readHeapMb } from '../src/player/memoryProbe';

const MB = 1048576;
const perf = (mb: number) => ({ memory: { usedJSHeapSize: mb * MB } });

describe('indicateur de mémoire du lecteur (ODY-239)', () => {
  it('lit le tas en Mo, null sans mesure (Safari, Firefox)', () => {
    expect(readHeapMb(perf(120))).toBe(120);
    expect(readHeapMb({})).toBeNull();
    expect(readHeapMb({ memory: { usedJSHeapSize: Number.NaN } })).toBeNull();
  });

  it('un relevé tous les 5 min à 10 relevés par seconde', () => {
    expect(MEMORY_EVERY_TICKS).toBe(5 * 60 * 10);
  });

  it('relevé : tas et tailles des collections', () => {
    expect(memorySnapshot({ thumbFrames: 12, notes: 3 }, perf(80))).toEqual({ heapMb: 80, counts: { thumbFrames: 12, notes: 3 } });
  });

  it('signale une croissance continue du tas, pas un tas simplement gros', () => {
    const w = new MemoryWatch();
    expect(w.suspicious(memorySnapshot({}, perf(900)))).toBe(false); // premier relevé : référence
    expect(w.growthMb(memorySnapshot({}, perf(950)))).toBe(50);
    expect(w.suspicious(memorySnapshot({}, perf(900 + HEAP_GROWTH_WARN_MB - 1)))).toBe(false);
    expect(w.suspicious(memorySnapshot({}, perf(900 + HEAP_GROWTH_WARN_MB)))).toBe(true);
    w.reset(); // nouvelle session : nouvelle référence
    expect(w.suspicious(memorySnapshot({}, perf(2000)))).toBe(false);
  });

  it('sans mesure, jamais de signalement', () => {
    const w = new MemoryWatch();
    expect(w.growthMb(memorySnapshot({}, {}))).toBeNull();
    expect(w.suspicious(memorySnapshot({}, {}))).toBe(false);
  });
});
