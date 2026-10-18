/* Port du prototype (voir tools/port-prototype.mjs). */


let toastTimer = null;
export const app = document.getElementById('app');
export const detailEl = document.getElementById('detail');
export const modal = document.getElementById('modal');
export const modalBox = modal.querySelector('.modal');
export const modalBody = document.getElementById('modal-body');
export const modalClose = document.getElementById('modal-close');
export const toastEl = document.getElementById('toast');
/** Message bref. `opts.action` ajoute un bouton (ex. « Annuler »), `opts.ms` règle la durée. */
export function toast(msg, opts) {
  if (!toastEl) return;
  const o = opts || {};
  toastEl.textContent = msg;
  toastEl.classList.toggle('has-action', !!o.action);
  if (o.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = o.action.label;
    btn.addEventListener('click', () => { toastEl.classList.remove('is-on'); o.action.run(); });
    toastEl.appendChild(btn);
  }
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), o.ms || 2400);
}
