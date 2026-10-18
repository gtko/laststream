/* Port du prototype (voir tools/port-prototype.mjs). */
import { REDUCE } from './constants.js';
import { ICON } from './icons.js';
import { state } from './state.js';

// ---------- Rangées horizontales : glisser, molette, flèches ----------
export const ROW_SEL = '.row,.cast-row,.vid-row';
let rowsRaf = 0;



export function updateArrows(wrap) {
  const r = wrap.querySelector(ROW_SEL);
  if (!r) return;
  const max = r.scrollWidth - r.clientWidth;
  const prev = wrap.querySelector('.row-arrow.prev');
  const next = wrap.querySelector('.row-arrow.next');
  if (prev) prev.hidden = max <= 2 || r.scrollLeft <= 2;
  if (next) next.hidden = max <= 2 || r.scrollLeft >= max - 2;
}

/**
 * Change le contenu d'une rangée (`change`) sans perdre le défilement horizontal ni le focus clavier / télécommande.
 * La carte focalisée est retrouvée par l'attribut `attr` (ex. `data-resume`) ; si elle a disparu, la carte de même rang.
 */
export function keepRowState(slot, change, attr) {
  const before = slot.querySelector(ROW_SEL);
  const left = before ? before.scrollLeft : 0;
  const act = document.activeElement;
  const focused = act instanceof HTMLElement && attr && act.hasAttribute(attr) && slot.contains(act) ? act : null;
  const cards = () => Array.from(slot.querySelectorAll('[' + attr + ']'));
  const idx = focused ? cards().indexOf(focused) : -1;
  const id = focused ? focused.getAttribute(attr) : null;
  change();
  const after = slot.querySelector(ROW_SEL);
  if (after) after.scrollLeft = left;
  if (!focused) return;
  const all = cards();
  const back = all.find((el) => el.getAttribute(attr) === id) || all[Math.min(idx, all.length - 1)];
  if (back) back.focus({ preventScroll: true });
}

export function decorateRows() {
  rowsRaf = 0;
  document.querySelectorAll(ROW_SEL).forEach((r) => {
    if (r.dataset.rw || !r.parentNode) return;
    r.dataset.rw = '1';
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    r.parentNode.insertBefore(wrap, r);
    wrap.appendChild(r);
    wrap.insertAdjacentHTML('beforeend',
      '<button type="button" class="row-arrow prev" tabindex="-1" aria-label="Faire défiler vers la gauche" hidden>' + ICON.chev + '</button>' +
      '<button type="button" class="row-arrow next" tabindex="-1" aria-label="Faire défiler vers la droite" hidden>' + ICON.chev + '</button>');
    r.addEventListener('scroll', () => updateArrows(wrap), { passive: true });
    wrap.addEventListener('mouseenter', () => updateArrows(wrap));
    updateArrows(wrap);
  });
}

if ('MutationObserver' in window) {
  new MutationObserver(() => { if (!rowsRaf) rowsRaf = requestAnimationFrame(decorateRows); })
    .observe(document.body, { childList: true, subtree: true });
}

// La molette verticale fait toujours défiler la page : les rangées se parcourent au glisser, aux flèches ou au trackpad.

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0 || !(e.target instanceof Element)) return;
  const r = e.target.closest(ROW_SEL);
  if (!r || r.scrollWidth <= r.clientWidth + 2) return;
  state.dragRow = { r, x: e.clientX, sl: r.scrollLeft, moved: false };
});
document.addEventListener('pointermove', (e) => {
  if (!state.dragRow) return;
  const dx = e.clientX - state.dragRow.x;
  if (!state.dragRow.moved && Math.abs(dx) > 6) { state.dragRow.moved = true; state.dragRow.r.classList.add('is-dragging'); }
  if (state.dragRow.moved) { state.dragRow.r._wt = null; state.dragRow.r.scrollLeft = state.dragRow.sl - dx; e.preventDefault(); }
});
export const endDrag = () => {
  if (!state.dragRow) return;
  if (state.dragRow.moved) { state.suppressClick = true; setTimeout(() => { state.suppressClick = false; }, 0); }
  state.dragRow.r.classList.remove('is-dragging');
  state.dragRow = null;
};
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('click', (e) => {
  if (state.suppressClick) { e.stopPropagation(); e.preventDefault(); }
}, true);
document.addEventListener('dragstart', (e) => {
  if (e.target instanceof Element && e.target.closest(ROW_SEL)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element && e.target.closest('.row-arrow');
  if (!a) return;
  e.preventDefault();
  const r = a.parentNode.querySelector(ROW_SEL);
  if (r) r.scrollBy({ left: (a.classList.contains('prev') ? -1 : 1) * r.clientWidth * 0.85, behavior: REDUCE ? 'auto' : 'smooth' });
});
