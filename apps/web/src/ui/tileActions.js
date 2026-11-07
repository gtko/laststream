// LAST-162 : ••• et ✕ des cartes sont de vrais <button> (focusables, nommés), et la carte elle-même est un
// role="button" (un <button> ne peut pas en contenir un autre : le HTML fermerait la carte avant eux).
// Boutons dans une carte role=button (axe nested-interactive) : compromis assumé, refonte en surcouche suivie dans une issue séparée.
import { ICON } from './icons.js';
import { esc } from './util.js';

/** Bouton « ••• » (menu contextuel, géré par délégation dans ctxmenu.js). */
export const moreButtonHTML = (title) =>
  '<button type="button" class="t-more" aria-label="' + esc('Plus d’actions pour ' + title) + '" title="' + esc('Plus d’actions pour ' + title) + '">•••</button>';

/** Bouton ✕ (retire de « Reprendre », géré par délégation dans ctxmenu.js via data-continue-remove). */
export const removeButtonHTML = (key, title) =>
  '<button type="button" class="t-remove" data-continue-remove="' + esc(key) + '" aria-label="' + esc('Retirer ' + title + ' de Reprendre') + '" title="Retirer de Reprendre la lecture">' + ICON.close + '</button>';

/** Entrée / Espace sur la carte (pas sur ses boutons) : même effet qu'un clic, comme le faisait le <button> natif. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.getAttribute('role') !== 'button' || !t.classList.contains('card')) return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  e.preventDefault();
  t.click();
});
