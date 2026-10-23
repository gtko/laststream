/**
 * Actions lentes ou rejouables (ODY-237) : verrou par action, état « en cours » immédiat et délai de redéclenchement.
 * Un clic répété pendant que l'action tourne, ou juste après, est ignoré ; le bouton montre tout de suite qu'il travaille
 * (aria-busy, classe is-busy) sans perdre le focus (télécommande, clavier) : on n'utilise pas `disabled`.
 */

const running = new Set();
/** Clé → instant (ms) avant lequel l'action ne se relance pas. */
const cooling = new Map();
const ids = new WeakMap();
let seq = 0;

/** Délai de redéclenchement par défaut pour une bascule (bibliothèque, vu, rappel, favori) : un double clic ne revient pas en arrière. */
export const TOGGLE_COOLDOWN_MS = 350;
/**
 * Après le lancement d'une lecture ou de l'ouverture des sources : un second appui (double clic) ne relance pas la session qui démarre.
 * Seul le lancement est verrouillé, pas la recherche de sources : fermer le lecteur puis réappuyer relance bien la lecture.
 */
export const PLAY_COOLDOWN_MS = 300;
/** Filet de sécurité : un verrou ne dépasse jamais cette durée, même si l'action ne rend jamais la main. */
export const MAX_LOCK_MS = 20000;

/** Clé stable propre à un élément (un verrou par bouton). */
export function elKey(prefix, el) {
  let id = ids.get(el);
  if (!id) { id = ++seq; ids.set(el, id); }
  return prefix + '#' + id;
}

/** aria-disabled que l'élément portait avant d'être marqué « en cours » (à remettre à la fin). */
const prevDisabled = new WeakMap();

/** Pose ou retire l'état « en cours » d'un bouton. Le bouton reste focusable. */
export function setBusy(el, on) {
  if (!(el instanceof Element)) return;
  el.classList.toggle('is-busy', on);
  if (on) {
    prevDisabled.set(el, el.getAttribute('aria-disabled'));
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-disabled', 'true');
    return;
  }
  el.removeAttribute('aria-busy');
  const prev = prevDisabled.get(el);
  prevDisabled.delete(el);
  if (prev === null || prev === undefined) el.removeAttribute('aria-disabled'); else el.setAttribute('aria-disabled', prev);
}

/** Vrai si l'action `key` tourne ou se trouve dans son délai de redéclenchement. */
export function isLocked(key) {
  if (running.has(key)) return true;
  const until = cooling.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  cooling.delete(key);
  return false;
}

/**
 * Lance `fn` sous le verrou `key`. Retourne `undefined` sans rien lancer si l'action est déjà en cours ou dans son délai
 * de redéclenchement ; sinon le résultat de `fn` (promesse comprise). Options :
 * - `el` : bouton à marquer « en cours » jusqu'à la fin ;
 * - `cooldown` : ms pendant lesquelles un nouveau déclenchement reste ignoré après la fin ;
 * - `maxMs` : durée maximale du verrou (filet de sécurité).
 */
export function runOnce(key, fn, { el = /** @type {Element | null} */ (null), cooldown = 0, maxMs = MAX_LOCK_MS } = {}) {
  if (isLocked(key)) return undefined;
  running.add(key);
  setBusy(el, true);
  let done = false;
  let timer = null;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    running.delete(key);
    setBusy(el, false);
    if (cooldown > 0) cooling.set(key, Date.now() + cooldown);
  };
  timer = setTimeout(release, maxMs);
  let out;
  try {
    out = fn();
  } catch (err) {
    release();
    throw err;
  }
  if (out && typeof out.then === 'function') return out.then((v) => { release(); return v; }, (err) => { release(); throw err; });
  release();
  return out;
}

/** Réinitialise tous les verrous (tests). */
export function resetBusy() {
  running.clear();
  cooling.clear();
}
