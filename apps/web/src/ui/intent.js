/* Intention de survol : une action qui coûte (TMDB, notes MDBList) ne part qu'après un survol stable ; un passage rapide ne coûte rien. */

/** Délai de survol stable avant de charger les données d'une tuile ou d'une mise en avant. */
const INTENT_MS = 500;

/**
 * Minuterie d'intention : `arm(fn)` (re)lance le compte à rebours, `cancel()` l'annule (pointeur parti, nouvelle cible).
 * `fn` n'est appelée qu'une fois, au terme du délai sans annulation.
 */
export function intentTimer(ms = INTENT_MS) {
  let id = null;
  return {
    arm(fn) {
      clearTimeout(id);
      id = setTimeout(() => {
        id = null;
        fn();
      }, ms);
    },
    cancel() {
      clearTimeout(id);
      id = null;
    },
    pending: () => id !== null,
  };
}
