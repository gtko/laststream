import { DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC, estimateOffset, expectedPosition } from '@laststream/protocol/sync';

/**
 * Synchronisation de lecture par horloge serveur. L'état (`pos` à l'instant serveur `at`) permet à chacun de calculer
 * la position attendue : `pos + (maintenant_serveur - at)` tant que ça joue. L'horloge serveur s'estime côté client
 * avec les `ping` / `pong` (voir estimateOffset). Ces fonctions pures sont aussi celles que l'application doit appliquer.
 */

export type DriftAction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'seek'; to: number };

/**
 * Correction de dérive du lecteur local : moins de 0,3 s d'écart, rien ; jusqu'à 2 s, vitesse 0,95 (en avance) ou 1,05
 * (en retard) pour rattraper sans à-coup ; au-delà, saut à la position attendue. À l'arrêt, un écart > 0,3 s fait sauter.
 */
export function driftAction(localPos: number, expected: number, playing: boolean): DriftAction {
  const diff = localPos - expected;
  const abs = Math.abs(diff);
  if (abs < DRIFT_IGNORE_SEC) return { kind: 'none' };
  if (!playing || abs >= DRIFT_SEEK_SEC) return { kind: 'seek', to: expected };
  return { kind: 'rate', rate: diff > 0 ? 0.95 : 1.05 };
}

// Position attendue et décalage d'horloge : source unique dans @laststream/protocol (partagée avec l'application).
export { DRIFT_IGNORE_SEC, DRIFT_SEEK_SEC, estimateOffset, expectedPosition };
