import { copySignature, type SourceView } from '../sources/info';

/* Reprise automatique : ordre des sources à essayer et détection des blocages. Fonctions pures, testées. */

export const STALL_LIMIT_MS = 15_000;
/** Délai avant la première image (le transcodage et les torrents démarrent plus lentement). */
export const STARTUP_LIMIT_MS = 45_000;

/**
 * Sources à essayer après `current` : d'abord les copies équivalentes (même qualité, source, codec, langues),
 * puis les autres lisibles dans l'ordre de `ranked` en gardant la langue d'abord. `tried` : indices déjà essayés.
 */
export function failoverOrder(ranked: readonly SourceView[], current: SourceView, tried: ReadonlySet<number>): SourceView[] {
  const sig = copySignature(current);
  const open = ranked.filter((v) => v.playable && !tried.has(v.index) && v.index !== current.index);
  const copies = open.filter((v) => copySignature(v) === sig);
  const sameLang = open.filter((v) => copySignature(v) !== sig && v.hasFrench === current.hasFrench);
  const rest = open.filter((v) => copySignature(v) !== sig && v.hasFrench !== current.hasFrench);
  return [...copies, ...sameLang, ...rest];
}

export type StallVerdict = 'ok' | 'stalled' | 'startup-timeout';

/** Surveille la progression de lecture. Horloge injectée : `tick(now, …)`. */
export class StallWatch {
  private lastTime = -1;
  private lastProgressAt: number;
  private started = false;

  constructor(private readonly begunAt: number, private readonly stallMs = STALL_LIMIT_MS, private readonly startupMs = STARTUP_LIMIT_MS) {
    this.lastProgressAt = begunAt;
  }

  /** `time` : position actuelle ; `idle` : en pause, terminée ou en recherche (jamais considéré comme un blocage). */
  tick(now: number, time: number, idle: boolean): StallVerdict {
    if (idle) {
      this.lastProgressAt = now;
      return 'ok';
    }
    if (time !== this.lastTime && time > 0) {
      this.lastTime = time;
      this.lastProgressAt = now;
      this.started = true;
      return 'ok';
    }
    if (!this.started) return now - this.begunAt > this.startupMs ? 'startup-timeout' : 'ok';
    return now - this.lastProgressAt > this.stallMs ? 'stalled' : 'ok';
  }

  /** Après une recherche ou un changement de piste, la mesure repart de zéro. */
  reset(now: number): void {
    this.lastProgressAt = now;
  }
}
