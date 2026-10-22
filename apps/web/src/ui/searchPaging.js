/* Pagination par section de la page Recherche (ODY-215) : nombre de résultats affichés au départ et taille d'un lot « Charger plus ».
 * Vue « Tout » : 18 par section (trois rangées de six sur grand écran) ; dans un filtre unique, 36. Personnalités : 12, puis 24. */
const BASE_ALL = 18;
const BASE_ONE = 36;
const PEOPLE_ALL = 12;
const PEOPLE_ONE = 24;
/** Pages TMDB demandées au plus par clic : évite une rafale de requêtes quand presque rien ne passe les filtres. */
export const MAX_PAGES_PER_CLICK = 3;

/** Taille d'un lot (et du départ) pour une section, selon le filtre actif. */
export function batchSize(kind, filter) {
  const single = filter !== 'all';
  return kind === 'people' ? (single ? PEOPLE_ONE : PEOPLE_ALL) : (single ? BASE_ONE : BASE_ALL);
}

/** Nombre de résultats affichables dans une section après `lots` clics sur « Charger plus ». */
export function sectionLimit(kind, filter, lots) {
  return batchSize(kind, filter) * (1 + Math.max(0, Number(lots) || 0));
}

/** Le clic doit-il aller chercher d'autres pages ? Oui s'il manque des résultats pour remplir le lot et que la liste n'est pas finie. */
export function needsMore(loaded, limit, done) {
  return !done && loaded < limit;
}

/** Résultats chargés mais encore masqués dans une section (jamais négatif). */
export function hiddenCount(loaded, limit) {
  return Math.max(0, loaded - limit);
}

/** Libellé du bouton : ce qu'il reste ; « + » tant que d'autres pages peuvent encore arriver. */
export function moreLabel(loaded, limit, done) {
  const rest = hiddenCount(loaded, limit);
  if (!rest && done) return '';
  return rest ? 'Charger plus (' + rest + (done ? '' : '+') + ' restant' + (rest > 1 ? 's' : '') + ')' : 'Charger plus';
}

/** Un bouton est-il utile ? Oui s'il reste des résultats masqués ou d'autres pages à venir. */
export const hasMore = (loaded, limit, done) => hiddenCount(loaded, limit) > 0 || !done;

