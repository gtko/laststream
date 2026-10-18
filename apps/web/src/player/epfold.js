/* Synopsis déplié dans le panneau Épisodes. L'état vit ici et non dans le DOM, pour survivre aux rafraîchissements
 * du panneau (panels.js réécrit la liste) ; un seul épisode est déplié à la fois. Seul le synopsis change de hauteur
 * (~150 ms), et uniquement au clic sur le bouton « Plus » ; la ligne ne bouge jamais au survol. */
const MS = 150;
let openKey = null;
const timers = new WeakMap();

export const epKey = (season, episode) => season + ':' + episode;
export const isEpFolded = (season, episode) => openKey !== null && openKey === epKey(season, episode);

const reduceMotion = () => !!globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Interrompt l'animation en cours du synopsis : la hauteur revient à « auto ». */
function endAnim(syn) {
  clearTimeout(timers.get(syn));
  syn.style.height = '';
}

/** Ouvre ou referme le synopsis d'une ligne ; la hauteur passe de la valeur courante à la cible. */
function setRowFolded(row, open) {
  const syn = row.querySelector('.lp-ep-syn');
  const more = row.querySelector('.lp-ep-more');
  if (more) more.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!syn) { row.classList.toggle('is-open', open); return; }
  const from = syn.offsetHeight;
  endAnim(syn);
  row.classList.toggle('is-open', open);
  const to = syn.offsetHeight;
  if (from === to || reduceMotion()) return;
  syn.style.height = from + 'px';
  void syn.offsetHeight; // force le calcul de style avant la transition
  syn.style.height = to + 'px';
  // Le délai couvre la transition (150 ms) puis rend la main à « auto », qui vaut la même hauteur.
  timers.set(syn, setTimeout(() => endAnim(syn), MS + 60));
}

/** Branche le clic sur les boutons « Plus » du panneau. À appeler une seule fois, sur l'élément du panneau. */
export function bindEpisodeFold(panel) {
  panel.addEventListener('click', (e) => {
    const more = e.target instanceof Element ? e.target.closest('.lp-ep-more') : null;
    if (!more || !panel.contains(more)) return;
    const row = more.closest('.lp-ep-row');
    if (!row) return;
    const key = epKey(more.dataset.season, more.dataset.episode);
    const open = openKey !== key;
    const prev = panel.querySelector('.lp-ep-row.is-open');
    openKey = open ? key : null;
    if (prev && prev !== row) setRowFolded(prev, false);
    setRowFolded(row, open);
  });
}
