/* Port du prototype (voir tools/port-prototype.mjs). */
import { ICON } from './icons.js';
import { inLib } from './library.js';
import { state } from './state.js';

// ---------- Menu contextuel des affiches (clic droit, touche Menu, appui long) ----------

let pressTimer = null;
export function closeCtx() {
  if (state.ctxMenu) { state.ctxMenu.remove(); state.ctxMenu = null; }
}
export function openCtx(tile, x, y) {
  closeCtx();
  const key = tile.dataset.tile;
  const it = state.byKey.get(key);
  if (!it) return;
  const on = inLib(key);
  state.ctxMenu = document.createElement('div');
  state.ctxMenu.className = 'ctxmenu glass';
  state.ctxMenu.setAttribute('role', 'menu');
  state.ctxMenu.dataset.key = key;
  state.ctxMenu.innerHTML = '<button type="button" role="menuitem" data-ctx="lib">' + (on ? ICON.check : ICON.list) + '<span>' + (on ? 'Dans ta bibliothèque (retirer)' : 'Ajouter à ma bibliothèque Laststream') + '</span></button>' +
    '<button type="button" role="menuitem" data-ctx="open">' + ICON.info + '<span>Voir la fiche</span></button>';
  document.body.appendChild(state.ctxMenu);
  const w = state.ctxMenu.offsetWidth;
  const h = state.ctxMenu.offsetHeight;
  state.ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  state.ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  const b = state.ctxMenu.querySelector('button');
  if (b) b.focus();
}
document.addEventListener('contextmenu', (e) => {
  const tile = e.target instanceof Element && e.target.closest('[data-tile]');
  if (!tile) return;
  e.preventDefault();
  let x = e.clientX;
  let y = e.clientY;
  if (!x && !y) { const r = tile.getBoundingClientRect(); x = r.left + 20; y = r.top + 20; }
  openCtx(tile, x, y);
});
document.addEventListener('pointerdown', (e) => {
  clearTimeout(pressTimer);
  if (e.pointerType === 'mouse' || !(e.target instanceof Element)) return;
  const tile = e.target.closest('[data-tile]');
  if (!tile) return;
  const x = e.clientX;
  const y = e.clientY;
  pressTimer = setTimeout(() => { state.suppressClick = true; setTimeout(() => { state.suppressClick = false; }, 400); openCtx(tile, x, y); }, 550);
});
['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (ev === 'pointermove' && e.pointerType === 'mouse') return;
  clearTimeout(pressTimer);
}));
