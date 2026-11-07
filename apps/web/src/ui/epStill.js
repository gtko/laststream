/* Vignettes d’épisode : jamais d’image cassée. Une <img data-still> dont le chargement échoue passe à son fond de repli
 * (data-fb : fond de la série), puis disparaît si elle n’en a pas. Le conteneur (.lp-ep-still, .ep-still) reçoit alors
 * la classe is-fb : dégradé et numéro en surimpression. Un seul écouteur global, en capture : les images sont rendues
 * par innerHTML, sans gestionnaire propre. */

const EP_STILL = '.lp-ep-still, .ep-still';

/** Traite une vignette en erreur ; renvoie son conteneur (ou null). */
export function stillFallback(img) {
  const box = img.parentElement;
  if (box && box.matches(EP_STILL)) box.classList.add('is-fb');
  const fb = img.getAttribute('data-fb');
  img.removeAttribute('data-fb');
  if (fb && img.getAttribute('src') !== fb) img.setAttribute('src', fb);
  else img.remove();
  return box;
}

let bound = false;

/** Installe l’écouteur d’erreurs (une seule fois). */
function bindStillFallback(root = globalThis.document) {
  if (bound || !root) return;
  bound = true;
  root.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-still')) stillFallback(t);
  }, true);
}

bindStillFallback();
