/* Règle commune des boutons qui ouvrent un panneau, un menu ou un popover (ODY-217) :
 * le bouton garde l'état ouvert / fermé (`aria-expanded`) et un second appui referme ce qu'il a ouvert. */

/** Reflète l'état ouvert d'un bouton d'ouverture : `aria-expanded` pour les technologies d'assistance, `is-open` pour le style actif. */
export function setOpenState(btn, open) {
  if (!btn) return;
  btn.setAttribute('aria-expanded', String(!!open));
  btn.classList.toggle('is-open', !!open);
}

/** Bascule : ferme si c'est ouvert, ouvre sinon. Renvoie vrai si cet appel a ouvert. */
export function toggleOpen(isOpen, open, close) {
  if (isOpen()) { close(); return false; }
  open();
  return true;
}
