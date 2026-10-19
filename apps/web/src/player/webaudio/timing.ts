/* Moteur audio de repli (web) : horloge, dérive et ordonnancement. Fonctions pures, testées avec des mocks.
 * L'horloge maîtresse est `video.currentTime` ; l'horloge de sortie est `AudioContext.currentTime`. Une « ancre »
 * (position média, instant du contexte, vitesse) relie les deux. */

/** Écart audio/vidéo au-delà duquel on se recale (secondes, strictement supérieur). */
export const DRIFT_RESYNC_S = 0.08;
/** Au-delà de cet écart, un seul relevé suffit pour se recaler (sinon il en faut deux de suite : currentTime est quantifié par image). */
export const DRIFT_HARD_S = 0.25;
/** Son décodé d'avance nécessaire pour démarrer ou reprendre (secondes). Sous ce seuil, le lecteur attend. */
export const START_AHEAD_S = 3;
/** Son décodé d'avance sous lequel la lecture s'interrompt (« chargement du son »). */
export const UNDERRUN_S = 0.25;
/** Le décodage s'arrête quand cette avance est atteinte (mémoire bornée). */
export const MAX_AHEAD_S = 8;
/** On ne programme dans le contexte audio que ce qui sera joué dans cette fenêtre (secondes). */
export const LOOKAHEAD_S = 1;
/** Compressé préchargé en avant de la position de décodage, en secondes de média. */
export const PREFETCH_TARGET_S = 30;
/** Deux segments dont les horodatages diffèrent de moins que cela sont considérés comme jointifs (secondes). */
export const CONTIGUOUS_EPS_S = 0.002;

export interface Anchor {
  /** Position média (s) à l'instant `ctx`. */
  media: number;
  /** `AudioContext.currentTime` correspondant. */
  ctx: number;
  /** Vitesse de lecture. */
  rate: number;
}

/** Position média que la sortie audio est en train de jouer d'après l'ancre. */
export function mappedMedia(a: Anchor, ctxNow: number): number {
  return a.media + (ctxNow - a.ctx) * a.rate;
}

/** Instant du contexte où jouer la position média `ts` (la latence de sortie avance le départ). */
export function whenFor(a: Anchor, ts: number, latency = 0): number {
  return a.ctx + (ts - a.media) / a.rate - latency;
}

/** Dérive en secondes : positif = l'audio est en avance sur la vidéo. */
export function driftSeconds(a: Anchor, ctxNow: number, videoTime: number): number {
  return mappedMedia(a, ctxNow) - videoTime;
}

/** Faut-il se recaler ? Strictement au-delà du seuil. */
export function needsRecalibration(drift: number, threshold = DRIFT_RESYNC_S): boolean {
  return Math.abs(drift) > threshold;
}

/**
 * Décision de recalage avec anti-rebond : `strikes` = relevés consécutifs déjà hors seuil. Renvoie le nouveau compteur et
 * si l'on se recale maintenant (écart franc, ou deux relevés de suite au-delà du seuil).
 */
export function driftVerdict(drift: number, strikes: number): { strikes: number; resync: boolean } {
  if (!needsRecalibration(drift)) return { strikes: 0, resync: false };
  if (Math.abs(drift) > DRIFT_HARD_S || strikes + 1 >= 2) return { strikes: 0, resync: true };
  return { strikes: strikes + 1, resync: false };
}

/** Son décodé d'avance (secondes) : fin du dernier segment moins la position vidéo, jamais négatif. */
export function aheadSeconds(lastEnd: number, videoTime: number): number {
  return Number.isFinite(lastEnd) ? Math.max(0, lastEnd - videoTime) : 0;
}

/** Le tampon permet-il de démarrer ? Prêt si l'avance suffit, ou si le flux audio est fini (silence ensuite). */
export function readyToPlay(ahead: number, eof: boolean, minAhead = START_AHEAD_S): boolean {
  return ahead >= minAhead || eof;
}

/** Le tampon est-il vide en cours de lecture ? (jamais tant que le flux n'est pas fini : après sa fin, c'est du silence.) */
export function underrun(ahead: number, eof: boolean, min = UNDERRUN_S): boolean {
  return !eof && ahead < min;
}

export type Placement =
  | { kind: 'skip' }
  | { kind: 'start'; when: number; offset: number; /** Trou (s) laissé avant ce segment par rapport au précédent ; 0 si jointif. */ gap: number };

export interface PlaceInput {
  ts: number;
  duration: number;
  anchor: Anchor;
  ctxNow: number;
  latency?: number;
  /** Segment précédemment programmé : fin média et fin sur l'horloge du contexte (null après un recalage). */
  prev: { mediaEnd: number; whenEnd: number } | null;
}

/**
 * Où et comment démarrer un segment. Jointif avec le précédent (même horodatage à 2 ms près) : il commence exactement à la fin
 * du précédent, sans trou ni recouvrement. Sinon, position calculée depuis l'ancre. Un segment déjà en partie écoulé est
 * rogné (`offset`, en secondes de segment) ; un segment entièrement écoulé est ignoré.
 */
export function placeChunk(i: PlaceInput): Placement {
  const { anchor: a, ctxNow } = i;
  const rate = a.rate;
  let when = whenFor(a, i.ts, i.latency ?? 0);
  let gap = 0;
  if (i.prev && Math.abs(i.ts - i.prev.mediaEnd) <= CONTIGUOUS_EPS_S) when = i.prev.whenEnd;
  else if (i.prev) gap = Math.max(0, when - i.prev.whenEnd);
  const span = i.duration / rate;
  if (when + span <= ctxNow) return { kind: 'skip' };
  if (when < ctxNow) return { kind: 'start', when: ctxNow, offset: (ctxNow - when) * rate, gap };
  return { kind: 'start', when, offset: 0, gap };
}
