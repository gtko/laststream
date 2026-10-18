import type { RoomState } from './types';

/** Écart au-delà duquel le lecteur se recale sur le salon (secondes, strictement supérieur). */
export const DRIFT_SEEK_THRESHOLD_S = 0.5;

/** Tolérance d'affichage : une image dont l'horodatage dépasse l'horloge de ce delta (s) attend encore. */
export const FRAME_EPSILON_S = 0.005;

/**
 * Position attendue du salon à l'instant `nowMs` : si la lecture tourne, on extrapole depuis `room.at`.
 * Bornée à [0, duration] quand la durée est connue (duration > 0).
 */
export function expectedPosition(room: RoomState, nowMs: number, duration = 0): number {
  const elapsed = room.playing ? Math.max(0, nowMs - room.at) / 1000 : 0;
  const max = duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, room.position + elapsed), max);
}

/** Vrai si la position locale s'écarte de la cible de plus que le seuil : il faut se recaler. */
export function needsResync(localPos: number, targetPos: number, threshold = DRIFT_SEEK_THRESHOLD_S): boolean {
  return Math.abs(localPos - targetPos) > threshold;
}

/**
 * Horloge maîtresse (position média, en s). `clockNow` est l'horloge audio (`AudioContext.currentTime`)
 * si le fichier a de l'audio, sinon l'horloge murale, dans la même unité. Quand la lecture est en pause,
 * la position reste figée à `anchorMedia`.
 */
export function mediaClock(anchorMedia: number, anchorClock: number, clockNow: number, playing: boolean): number {
  return playing ? anchorMedia + (clockNow - anchorClock) : anchorMedia;
}

/**
 * Index de l'image à afficher : la dernière dont l'horodatage (s) ne dépasse pas `now` (à la tolérance près).
 * Les images qui la précèdent sont périmées. Renvoie -1 s'il n'y en a aucune. `timestamps` est trié croissant.
 */
export function pickFrame(timestamps: readonly number[], now: number): number {
  let idx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] <= now + FRAME_EPSILON_S) idx = i;
    else break;
  }
  return idx;
}

export interface FeedLimits {
  /** Images décodées en attente d'affichage. */
  maxQueue: number;
  /** Paquets confiés au décodeur mais pas encore sortis. */
  maxDecodeQueue: number;
  /** Avance maximale, en secondes de média, au-delà de la position courante. */
  maxAheadSec: number;
}

export interface FeedState {
  queued: number;
  decodeQueue: number;
  aheadSec: number;
}

/** Vrai si le producteur peut encore confier un paquet au décodeur (buffering borné). */
export function canFeed(state: FeedState, limits: FeedLimits): boolean {
  return state.queued < limits.maxQueue && state.decodeQueue < limits.maxDecodeQueue && state.aheadSec < limits.maxAheadSec;
}

/**
 * Où démarrer un segment audio de média `mediaTs` sur l'horloge audio. Si cet instant est déjà passé,
 * on démarre maintenant avec le décalage correspondant dans le segment.
 */
export function audioSchedule(
  mediaTs: number,
  anchorMedia: number,
  anchorClock: number,
  clockNow: number,
): { when: number; offset: number } {
  const when = anchorClock + (mediaTs - anchorMedia);
  if (when < clockNow) return { when: clockNow, offset: clockNow - when };
  return { when, offset: 0 };
}
