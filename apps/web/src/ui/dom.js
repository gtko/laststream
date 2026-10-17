/* Port du prototype (voir tools/port-prototype.mjs). */


let toastTimer = null;
export const app = document.getElementById('app');
export const detailEl = document.getElementById('detail');
export const modal = document.getElementById('modal');
export const modalBox = modal.querySelector('.modal');
export const modalBody = document.getElementById('modal-body');
export const modalClose = document.getElementById('modal-close');
export const toastEl = document.getElementById('toast');
export function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2400);
}
