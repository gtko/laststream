import { copySignature, type SourceView } from '../sources/info';

/* Reprise automatique : ordre des sources à essayer et détection des blocages. Fonctions pures, testées. */

const STALL_LIMIT_MS = 15_000;
/** Position figée malgré un cache qui avance : plafond au-delà duquel la source est tout de même tenue pour bloquée. */
const HARD_STALL_LIMIT_MS = 60_000;
/** Délai avant la première image (le transcodage et le débridage à la demande démarrent plus lentement). */
const STARTUP_LIMIT_MS = 45_000;

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

/**
 * Surveille la progression de lecture. Horloge injectée : `tick(now, …)`.
 * `cacheTime` : fin des données déjà reçues (secondes), null si le moteur ne la connaît pas. Un tampon qui se remplit
 * (mpv en `paused-for-cache`, HTML5 qui reçoit les octets) n'est pas un blocage : la position peut rester figée jusqu'à
 * HARD_STALL_LIMIT_MS tant que le cache avance.
 */
export class StallWatch {
  private lastTime = -1;
  private lastProgressAt: number;
  private lastCache = -1;
  private lastCacheProgressAt: number;
  private started = false;

  constructor(private readonly begunAt: number, private readonly stallMs = STALL_LIMIT_MS, private readonly startupMs = STARTUP_LIMIT_MS) {
    this.lastProgressAt = begunAt;
    this.lastCacheProgressAt = begunAt;
  }

  /** `time` : position actuelle ; `idle` : en pause, terminée ou en recherche (jamais considéré comme un blocage). */
  tick(now: number, time: number, idle: boolean, cacheTime: number | null = null): StallVerdict {
    if (idle) {
      this.lastProgressAt = now;
      this.lastCacheProgressAt = now;
      return 'ok';
    }
    if (cacheTime !== null) {
      if (cacheTime > 0 && cacheTime !== this.lastCache) this.lastCacheProgressAt = now;
      this.lastCache = cacheTime;
    }
    if (time !== this.lastTime && time > 0) {
      this.lastTime = time;
      this.lastProgressAt = now;
      this.started = true;
      return 'ok';
    }
    if (!this.started) return now - this.begunAt > this.startupMs ? 'startup-timeout' : 'ok';
    const sincePosition = now - this.lastProgressAt;
    if (sincePosition <= this.stallMs) return 'ok';
    if (sincePosition > HARD_STALL_LIMIT_MS) return 'stalled';
    const cacheStuck = cacheTime === null || now - this.lastCacheProgressAt > this.stallMs;
    return cacheStuck ? 'stalled' : 'ok';
  }

  /** Après une recherche ou un changement de piste, la mesure repart de zéro (position et cache). */
  reset(now: number): void {
    this.lastProgressAt = now;
    this.lastCacheProgressAt = now;
  }
}

/**
 * Meilleur candidat pour la course quand la source choisie tarde : même langue, puis la plus facile à lancer (lecture directe,
 * puis conversion audio, puis réencodage vidéo), puis en cache ; jamais une source déjà essayée ni mémorisée comme lente.
 */
export function pickRaceCandidate(
  ranked: readonly SourceView[], current: SourceView, tried: ReadonlySet<number>, bad: ReadonlySet<string>, keyOf: (v: SourceView) => string,
): SourceView | null {
  const open = failoverOrder(ranked, current, tried).filter((v) => !bad.has(keyOf(v)));
  const ease = (v: SourceView): number => (v.appAudio === 'unsupported' ? 5 : v.web === 'direct' ? 0 : v.convert === 'audio' ? 1 : v.web === 'unknown' ? 2 : 3);
  const score = (v: SourceView): number => (v.hasFrench === current.hasFrench ? 0 : 100) + ease(v) * 10 + (v.status === 'cached' ? 0 : 1);
  const sorted = open.map((v, i) => ({ v, i })).sort((a, b) => score(a.v) - score(b.v) || a.i - b.i);
  return sorted.length ? sorted[0].v : null;
}
