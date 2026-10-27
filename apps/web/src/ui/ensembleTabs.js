/* Onglets de la page Ensemble (#/ensemble[/<onglet>]) : identifiants d'adresse et libellés. Module léger, partagé par le routeur et la page. */

/** [identifiant dans l'adresse, libellé]. Le premier est la vue par défaut (#/ensemble). */
export const ENSEMBLE_TABS = [
  ['maintenant', 'Maintenant'],
  ['ce-soir', 'Ce soir'],
  ['a-venir', 'À venir'],
  ['salons-publics', 'Salons publics'],
  ['passees', 'Passées'],
];

/** Identifiant d'onglet valide, ou chaîne vide. */
export const ensembleTabOf = (slug) => (ENSEMBLE_TABS.some(([id]) => id === slug) ? slug : '');

/** Adresse d'un onglet : #/ensemble pour le premier, #/ensemble/<onglet> pour les autres. */
export const ensembleHash = (tab) => (tab && tab !== ENSEMBLE_TABS[0][0] ? '#/ensemble/' + tab : '#/ensemble');
