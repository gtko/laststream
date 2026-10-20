import { DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC, estimateOffset } from '@laststream/protocol/sync';

/* Synchronisation de lecture par horloge serveur (protocole docs/social.md, §6). Position attendue, décalage d'horloge et
 * seuils communs : @laststream/protocol. Ici : estimateur d'horloge et correction de dérive du lecteur. L'état d'un salon est une position `pos`
 * (secondes) à l'instant serveur `at` (ms) ; la position attendue s'en déduit à tout instant. Fonctions pures, testées. */

export type { PlaybackState } from '@laststream/protocol/party';
export { DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC, estimateOffset, expectedPosition } from '@laststream/protocol/sync';

/** Garde l'échantillon au plus petit aller-retour (le plus fiable). */
export class ClockEstimator {
  offset = 0;
  rtt = Infinity;
  samples = 0;
  add(t0: number, t1: number, serverTime: number): void {
    const rtt = Math.max(0, t1 - t0);
    this.samples += 1;
    if (rtt <= this.rtt) {
      this.rtt = rtt;
      this.offset = estimateOffset(t0, t1, serverTime);
    }
  }
}

export type DriftAction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'seek'; to: number };

/** Écart toléré tant qu'une vitesse corrective est en cours (hystérésis : on finit de rattraper). */
export const DRIFT_SETTLE_SEC = 0.15;
/** Vitesses correctives. */
export const RATE_SLOW = 0.95;
export const RATE_FAST = 1.05;

export interface DriftOptions {
  /** La vitesse de lecture est réglable (sinon la correction passe par des sauts). */
  canRate?: boolean;
  /** Une vitesse corrective est déjà appliquée. */
  correcting?: boolean;
}

/**
 * Correction de dérive du lecteur local : moins de 0,3 s d'écart, rien ; jusqu'à 2 s, vitesse 0,95 (en avance) ou 1,05
 * (en retard) ; au-delà, saut à la position attendue. À l'arrêt, tout écart de 0,3 s ou plus fait sauter. Sans vitesse
 * réglable (lecteur natif), un écart d'au moins 1 s est corrigé par un saut, en dessous on ne touche à rien.
 */
export function driftAction(localPos: number, expected: number, playing: boolean, opts: DriftOptions = {}): DriftAction {
  const diff = localPos - expected;
  const abs = Math.abs(diff);
  const canRate = opts.canRate !== false;
  const ignore = opts.correcting && canRate ? DRIFT_SETTLE_SEC : DRIFT_IGNORE_SEC;
  if (abs < ignore) return { kind: 'none' };
  if (!playing || abs >= DRIFT_SEEK_SEC) return { kind: 'seek', to: expected };
  if (!canRate) return abs >= 1 ? { kind: 'seek', to: expected } : { kind: 'none' };
  return { kind: 'rate', rate: diff > 0 ? RATE_SLOW : RATE_FAST };
}
