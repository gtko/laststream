import type { PlaybackState } from './party.js';
/**
 * Synchronisation de lecture par horloge serveur. L'état (`pos` à l'instant serveur `at`) permet à chacun de calculer
 * la position attendue : `pos + (maintenant_serveur - at)` tant que ça joue. L'horloge serveur s'estime côté client
 * avec les `ping` / `pong` (voir estimateOffset). Fonctions pures, communes au serveur et à l'application.
 */
/** Seuils de correction de dérive (secondes). */
export declare const DRIFT_IGNORE_SEC = 0.3;
export declare const DRIFT_SEEK_SEC = 2;
/** Position attendue (secondes) à l'instant serveur `now` (ms). `rev` n'intervient pas (état accepté sans lui). */
export declare function expectedPosition(state: Pick<PlaybackState, 'playing' | 'pos' | 'at'> & {
    rev?: number;
}, now: number): number;
/**
 * Décalage d'horloge client -> serveur (ms), estimé à partir d'un échange ping/pong : `t0` envoi, `t1` réception du
 * pong (horloge client), `serverTime` instant serveur de la réponse. On suppose l'aller et le retour symétriques.
 * Instant serveur estimé = `Date.now() + offset`. Garder l'échantillon au plus petit aller-retour (t1 - t0).
 */
export declare function estimateOffset(t0: number, t1: number, serverTime: number): number;
