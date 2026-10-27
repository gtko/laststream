/* Retour du téléphone (LAST-499) : chaque couche ouverte (modale, feuille, menu) pose une entrée d'historique à la même adresse.
 * Le retour (geste du bord gauche, bouton Android, bouton Précédent du navigateur) ferme alors la couche du dessus au lieu de
 * changer de page. Une couche fermée autrement (croix, Échap, voile, navigation) laisse son entrée, devenue périmée : le retour
 * qui y mène ou qui la quitte est prolongé d'un pas, pour qu'aucune pression ne reste sans effet. */

const KEY = 'lsLayer';
/** Préfixe propre au chargement : une entrée laissée avant un rechargement de la page ne correspond à aucune couche ouverte. */
const BOOT = Math.random().toString(36).slice(2, 8);
/** Durée pendant laquelle le `popstate` suivant est attribué au retour lancé par ce module (saut d'une entrée périmée). */
const SKIP_MS = 1500;

/** @type {{ id: string, close: () => void }[]} couches ouvertes, la dernière au-dessus */
const stack = [];
let seq = 0;
let skipAt = 0;
/** Adresse où la pression de retour en cours a commencé : les sauts continuent tant que rien de visible n'a changé. */
let pressHref = '';

/** @returns {string | null} couche de l'entrée d'historique courante */
function layerOfState() {
  try {
    const s = history.state;
    return s && typeof s[KEY] === 'string' ? s[KEY] : null;
  } catch (_) { return null; }
}
const here = () => ({ layer: layerOfState(), href: location.href });
/** Dernière entrée connue : celle que le prochain `popstate` quitte. */
let last = here();

const live = (/** @type {string | null} */ id) => !!id && stack.some((l) => l.id === id);

function skip() {
  skipAt = Date.now();
  history.back();
}

/**
 * Couche qui s'ouvre : une entrée d'historique à la même adresse. `close` est appelée au retour (la couche est déjà retirée de
 * la pile). Renvoie la fonction à appeler quand la couche se ferme d'elle-même (sans effet si le retour l'a déjà fermée).
 * @param {() => void} close
 * @returns {() => void}
 */
export function pushLayer(close) {
  const id = BOOT + ':' + ++seq;
  try { history.pushState({ [KEY]: id }, '', location.href); } catch (_) { return () => {}; }
  const entry = { id, close };
  stack.push(entry);
  last = { layer: id, href: location.href };
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Une couche est ouverte (le retour la fermera). */
export const hasLayers = () => stack.length > 0;

/**
 * À appeler au `popstate`. Ferme les couches au-dessus de l'entrée atteinte et saute les entrées périmées.
 * @returns {boolean} true si le retour est consommé ici (même adresse : le routeur n'a rien à rejouer)
 */
export function handlePopState() {
  const prev = last;
  const cur = here();
  last = cur;
  const sameHref = cur.href === prev.href;
  const skipping = Date.now() - skipAt < SKIP_MS;
  skipAt = 0;
  if (!skipping) pressHref = prev.href;
  let closed = false;
  while (stack.length && stack[stack.length - 1].id !== cur.layer) {
    const top = /** @type {{ close: () => void }} */ (stack.pop());
    closed = true;
    try { top.close(); } catch (_) { /* la couche suivante se ferme quand même */ }
  }
  if (closed) return sameHref;
  // Entrée d'une couche déjà fermée (lien suivi depuis un menu, couche fermée par la croix) : un pas de plus.
  if (cur.layer && !live(cur.layer)) { skip(); return sameHref; }
  // Retour depuis l'entrée périmée d'une couche fermée par la croix ou Échap, toujours sur la page où la pression a commencé :
  // rien de visible n'a changé, un pas de plus (autant de fois qu'il y a d'entrées périmées).
  if (cur.href === pressHref && prev.layer && !live(prev.layer)) { skip(); return sameHref; }
  return skipping ? sameHref : false;
}

// Navigation (lien, `location.hash`) : la nouvelle entrée devient la dernière connue.
window.addEventListener('hashchange', () => { last = here(); });

/** Tests : remise à zéro de la pile. */
export function resetBackStack() {
  stack.length = 0;
  skipAt = 0;
  pressHref = '';
  last = here();
}
