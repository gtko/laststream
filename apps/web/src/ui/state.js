/* Port du prototype (voir tools/port-prototype.mjs). */


export const state = {
  status: 'loading', // loading | ready | error
  data: null,
  details: new Map(), // clé -> détail léger (mise en avant)
  byKey: new Map(), // clé -> élément canonique
  ai: { status: 'idle', items: [] },
  dwell: { timer: null, el: null },
  preview: null,
  lastFocus: null,
  inDetail: false,
  homeScroll: 0,
  depth: 0, // 1 si la fiche a été ouverte depuis l'accueil (history.back() y revient)
  token: 0, // jeton de rendu de la fiche
  ficheKey: '',
  libView: { type: 'all', sort: 'date' },
  libMode: 'library', // onglet de la bibliothèque : « library » (Ma bibliothèque) ou « watched » (Vus)
  scrolls: new Map(), curHash: '', popping: false, restoreY: null, pp: null,
  top10: new Map(), // clé -> rang dans le Top 10 du jour (serveur) : titres déjà affichés à l'accueil
  topBadge: new Map(), // clé -> rang dans les Top 10 serveur (semaine d'abord, puis jour) : badge des tuiles
  upcoming: null,
  svcIO: null, // observateur des rangées de la page service
  ctxMenu: null, // menu contextuel ouvert
  dragRow: null, // rangée en cours de glisser
  suppressClick: false,
};

/** Autres modules (suivis, notes…) ajoutent leurs entrées au menu contextuel : (cible) => [{ id, label, icon, run }]. Dans state.js (feuille) pour rester utilisable pendant le chargement des modules. */
export function registerCtxItems(fn) {
  (state.ctxExtras || (state.ctxExtras = [])).push(fn);
}
