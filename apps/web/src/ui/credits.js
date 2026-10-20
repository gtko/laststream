/*
 * Crédits des avatars (licences à attribution : CC BY 4.0 et assimilées) : liste unique, rendue dans le repli du
 * sélecteur d'avatars et dans la modale « Crédits » ouverte depuis le pied de page. Les données viennent toutes de
 * avatarCredits() (data/avatars.ts) : aucune liste dupliquée.
 */
import { avatarCredits, LICENSE_LABEL, LICENSE_URL } from '../data/avatars';
import { esc } from './util.js';

const EXT = 'target="_blank" rel="noopener noreferrer"';
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Crédits des illustrations : liste des illustrateurs et licences, puis les mentions finales (Héros, DiceBear). */
export function creditsHTML() {
  return '<ul class="av-credits">' + avatarCredits().map((c) =>
    '<li><strong>' + esc(c.creator) + '</strong> : ' + c.styles.map((st) => '<a href="' + esc(st.source) + '" ' + EXT + '>' + esc(st.label) + '</a>').join(', ') +
    ' · <a href="' + esc(LICENSE_URL[c.license]) + '" ' + EXT + '>' + esc(LICENSE_LABEL[c.license]) + '</a></li>').join('') +
    '</ul><p class="av-credits">Avatars « Héros » : dessins originaux laststream, générés en local.</p><p class="av-credits">Avatars générés avec <a href="https://www.dicebear.com" ' + EXT + '>DiceBear</a> (MIT), en local sur ton appareil.</p>';
}

/** Lien discret « Crédits » des pieds de page ; le clic est géré globalement (data-credits). */
export const creditsLinkHTML = () => '<button type="button" class="cr-link" data-credits>Crédits</button>';

let current = null;

/** Ouvre la modale « Crédits » ; le focus revient à `opener` (ou à l'élément actif) à la fermeture. */
function openCredits(opener) {
  if (current) { current.close(); return; }
  const back = opener || document.activeElement;
  const el = document.createElement('div');
  el.className = 'cr-layer';
  el.innerHTML = '<div class="cr-scrim" data-cr-close></div>' +
    '<section class="cr-sheet" role="dialog" aria-modal="true" aria-labelledby="cr-title" tabindex="-1">' +
    '<header class="cr-head"><h2 id="cr-title">Crédits</h2><button type="button" class="cr-x" data-cr-close aria-label="Fermer">&times;</button></header>' +
    '<div class="cr-body"><p class="cr-lead">Les avatars illustrés sont l’œuvre de leurs auteurs, utilisés selon leurs licences.</p>' + creditsHTML() + '</div></section>';
  document.body.appendChild(el);
  const addedModal = !document.body.classList.contains('modal-open');
  if (addedModal) document.body.classList.add('modal-open');
  const sheet = el.querySelector('.cr-sheet');
  const api = {
    close() {
      if (current !== api) return;
      current = null;
      el.remove();
      if (addedModal) document.body.classList.remove('modal-open');
      if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
      else if (document.activeElement === document.body || !document.activeElement) document.body.focus?.();
    },
  };
  el.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('[data-cr-close]')) api.close(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(sheet.querySelectorAll(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!items.length || !sheet.contains(document.activeElement)) { e.preventDefault(); (first || sheet).focus(); }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  current = api;
  sheet.focus({ preventScroll: true });
}

document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-credits]') : null;
  if (b) { e.preventDefault(); openCredits(b); }
});
