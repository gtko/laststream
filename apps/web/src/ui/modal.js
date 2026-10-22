/* Port du prototype (voir tools/port-prototype.mjs). */
import { captionParams } from '../data/trailers';
import { getDetail } from './catalog.js';
import { modal, modalBody, modalBox, modalClose, toast } from './dom.js';
import { heroVideoSync } from './heroVideo.js';
import { closeHover } from './hover.js';
import { stopPreview, ytSrc } from './preview.js';
import { guardAmbient, hideTrailerButtons } from './trailerFallback.js';
import { state } from './state.js';
import { esc } from './util.js';

let stopGuard = null;

export async function openTrailer(it, opener) {
  const d = await getDetail(it);
  if (!d || !d.trailer) { toast('Bande-annonce indisponible'); return; }
  openVideo(d.trailer, 'Bande-annonce : ' + it.name, opener, d.trailerVO, d, it.key);
}

/**
 * Détail (ou fiche) dont la bande-annonce principale est cette vidéo : sert de repli si elle est indisponible. Une vidéo
 * « Bonus » n'a pas de repli (elle est seulement mémorisée en échec).
 */
function ownerOf(key) {
  const has = (d) => !!d && Array.isArray(d.trailers) && d.trailer === key;
  if (has(state.model)) return state.model;
  for (const d of state.details.values()) if (has(d)) return d;
  return null;
}

/**
 * Lecteur avec son. `vo` : sous-titres dans la langue principale, seulement si la vidéo n'y est pas doublée. `d` : détail du
 * titre (sinon retrouvé d'après la clé) ; si YouTube refuse la vidéo, la candidate suivante est lancée, et à défaut la
 * fenêtre se ferme. `titleKey` : clé du titre, dont les boutons « Bande-annonce » partent quand plus rien n'est lisible.
 */
export function openVideo(key, title, opener, vo = false, d = /** @type {any} */ (null), titleKey = '') {
  const srcOf = (k, v) => {
    const caps = captionParams(!!v);
    return ytSrc(k, 'autoplay=1&rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(location.origin) +
      (caps ? '&' + caps : ''));
  };
  if (stopGuard) { stopGuard(); stopGuard = null; }
  openModal(
    '<h2 id="modal-title" class="sr-only">' + esc(title) + '</h2>' +
    '<div class="video"><iframe src="' + esc(srcOf(key, vo)) + '" title="' + esc(title) +
    '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>',
    opener, '');
  const iframe = modalBody.querySelector('iframe');
  if (!iframe) return;
  const owner = d || ownerOf(key);
  const tried = [key];
  let cur = vo;
  stopGuard = guardAmbient(iframe, owner, key, {
    srcFor: (k) => srcOf(k, cur),
    onSwap: (next) => { cur = !!next.vo; tried.push(next.key); },
    onExhausted: () => {
      hideTrailerButtons(document.body, tried);
      // jsdom n'a pas `CSS.escape` : échappement des guillemets et barres obliques inverses pour le sélecteur d'attribut.
      if (titleKey) document.querySelectorAll('[data-trailer="' + String(titleKey).replace(/["\\]/g, '\\$&') + '"]').forEach((b) => b.remove());
      closeModal();
      if (!document.activeElement || document.activeElement === document.body) document.body.focus({ preventScroll: true });
      toast('Bande-annonce indisponible');
    },
  });
}

export function openModal(html, opener, cls) {
  stopPreview();
  closeHover();
  if (modal.hidden) state.modalFocus = opener || document.activeElement;
  modalBox.className = 'modal' + (cls ? ' ' + cls : '');
  modalBody.innerHTML = html;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  heroVideoSync();
  modalClose.focus();
}

export function closeModal(silent) {
  if (modal.hidden) return;
  modal.hidden = true;
  if (stopGuard) { stopGuard(); stopGuard = null; }
  modalBody.innerHTML = ''; // arrête la lecture de l'iframe
  document.body.classList.remove('modal-open');
  const t = state.modalFocus;
  state.modalFocus = null;
  heroVideoSync();
  if (!silent && t && t.isConnected) t.focus();
}

export function focusables() {
  return Array.from(modal.querySelectorAll('button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])'));
}
