/* Points d'accroche du mouvement de l'interface. ui/motion.js (et sa feuille) est chargé à part, juste après le démarrage,
 * pour ne pas peser sur le premier chargement (budget gzip) : il remplace ces fonctions, sans effet tant qu'il n'est pas là. */
export const motionHooks = {
  /** @type {(el: HTMLElement) => void} écran qui s'ouvre */
  enterView: () => {},
  /** @type {(el: HTMLElement) => void} retour à l'accueil */
  returnView: () => {},
  /** @type {() => () => void} chargement d'une page : renvoie la fonction qui le termine */
  navProgress: () => () => {},
};
