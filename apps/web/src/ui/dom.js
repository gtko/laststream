/* Port du prototype (voir tools/port-prototype.mjs). */
import { feedbackAvailable, noteError } from '../data/feedback';
import { t } from '../i18n';


let toastTimer = null;
export const app = document.getElementById('app');
export const detailEl = document.getElementById('detail');
export const modal = document.getElementById('modal');
export const modalBox = modal.querySelector('.modal');
export const modalBody = document.getElementById('modal-body');
export const modalClose = document.getElementById('modal-close');
const toastEl = document.getElementById('toast');
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

/**
 * Message d'une erreur interceptée (try/catch) : l'erreur est notée pour le feedback (LAST-1654) et le message gagne un
 * bouton « Signaler » qui ouvre la fenêtre avec l'erreur jointe. `where` : écran ou module (« social », « listes »…).
 */
export function toastError(msg, err, where = 'app', opts) {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const noted = noteError({ where, title: msg, message: detail, error: err });
  if (!feedbackAvailable()) { toast(msg, opts); return; }
  toast(msg, { ms: 6000, ...opts, action: { label: t('Signaler'), run: () => { void import('./feedback.js').then((m) => m.openFeedback({ error: noted })); } } });
}
