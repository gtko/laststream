/* Port du prototype (voir tools/port-prototype.mjs). */
import { getDetail } from './catalog.js';
import { modal, modalBody, modalBox, modalClose } from './dom.js';
import { heroVideoSync } from './heroVideo.js';
import { closeHover } from './hover.js';
import { stopPreview, ytSrc } from './preview.js';
import { state } from './state.js';
import { esc } from './util.js';

export async function openTrailer(it, opener) {
  const d = await getDetail(it);
  if (!d || !d.trailer) return;
  openVideo(d.trailer, 'Bande-annonce : ' + it.name, opener);
}

export function openVideo(key, title, opener) {
  const src = ytSrc(key, 'autoplay=1&rel=0&modestbranding=1&playsinline=1');
  openModal(
    '<h2 id="modal-title" class="sr-only">' + esc(title) + '</h2>' +
    '<div class="video"><iframe src="' + esc(src) + '" title="' + esc(title) +
    '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>',
    opener, '');
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
