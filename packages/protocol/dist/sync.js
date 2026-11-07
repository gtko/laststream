/**
 * Synchronisation de lecture par horloge serveur. L'état (`pos` à l'instant serveur `at`) permet à chacun de calculer
 * la position attendue : `pos + (maintenant_serveur - at)` tant que ça joue. L'horloge serveur s'estime côté client
 * avec les `ping` / `pong` (voir estimateOffset). Fonctions pures, communes au serveur et à l'application.
 */
/** Seuils de correction de dérive (secondes). */
export const DRIFT_IGNORE_SEC = 0.3;
export const DRIFT_SEEK_SEC = 2;
/** Position attendue (secondes) à l'instant serveur `now` (ms). `rev` n'intervient pas (état accepté sans lui). */
export function expectedPosition(state, now) {
    if (!state.playing)
        return state.pos;
    return Math.max(0, state.pos + Math.max(0, now - state.at) / 1000);
}
/**
 * Décalage d'horloge client -> serveur (ms), estimé à partir d'un échange ping/pong : `t0` envoi, `t1` réception du
 * pong (horloge client), `serverTime` instant serveur de la réponse. On suppose l'aller et le retour symétriques.
 * Instant serveur estimé = `Date.now() + offset`. Garder l'échantillon au plus petit aller-retour (t1 - t0).
 */
export function estimateOffset(t0, t1, serverTime) {
    return serverTime - (t0 + t1) / 2;
}
