/* Indicateur de mémoire du lecteur pour les journaux de debug : tas JavaScript (Chromium : WebView2, navigateur) et taille des
 * collections qui peuvent grossir pendant une longue lecture. Pas de mesure là où le navigateur ne la donne pas. Logique pure, testée. */

/** Un relevé toutes les 5 minutes de lecture (le relevé tourne à 10 Hz). */
export const MEMORY_EVERY_TICKS = 3000;
/** Croissance du tas depuis le premier relevé de la session au-delà de laquelle on signale une fuite probable. */
export const HEAP_GROWTH_WARN_MB = 200;

export interface MemorySnapshot {
  /** Tas JavaScript utilisé (Mo), null si le navigateur ne l'expose pas. */
  heapMb: number | null;
  counts: Record<string, number>;
}

interface PerfWithMemory { memory?: { usedJSHeapSize?: number } }

export function readHeapMb(perf: PerfWithMemory | undefined = (globalThis as { performance?: PerfWithMemory }).performance): number | null {
  const used = perf?.memory?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) ? Math.round(used / 1048576) : null;
}

export function memorySnapshot(counts: Record<string, number>, perf?: PerfWithMemory): MemorySnapshot {
  return { heapMb: readHeapMb(perf), counts };
}

/** Garde le premier relevé de la session et dit si le tas a trop grossi depuis. */
export class MemoryWatch {
  private first: number | null = null;

  /** Croissance en Mo depuis le premier relevé (null : pas de mesure). */
  growthMb(s: MemorySnapshot): number | null {
    if (s.heapMb === null) return null;
    if (this.first === null) this.first = s.heapMb;
    return s.heapMb - this.first;
  }

  suspicious(s: MemorySnapshot): boolean {
    const g = this.growthMb(s);
    return g !== null && g >= HEAP_GROWTH_WARN_MB;
  }

  reset(): void { this.first = null; }
}
