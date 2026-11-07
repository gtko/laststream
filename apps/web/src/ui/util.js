/* Port du prototype (voir tools/port-prototype.mjs). */
import { userStore } from '../data/userStore';

export { escapeHtml as esc } from '../data/format';

/** Réécrit `el.innerHTML` en rendant le focus clavier au contrôle qui l'avait (retrouvé par data-ens-knock, data-ens-invite, data-wp-more, data-evening-act ou href). */
export function rewriteKeepingFocus(el, html) {
  const a = document.activeElement;
  let sel = '';
  if (a && a !== el && el.contains(a)) {
    for (const attr of ['data-ens-knock', 'data-ens-invite', 'data-wp-more', 'data-evening-act', 'href']) {
      const v = a.getAttribute(attr);
      if (v !== null) { sel = '[' + attr + (v ? '="' + v.replace(/["\\]/g, '\\$&') + '"' : '') + ']'; break; }
    }
  }
  // eslint-disable-next-line no-restricted-syntax -- données serveur échappées par esc dans chaque gabarit
  el.innerHTML = html;
  const next = sel ? el.querySelector(sel) : null;
  if (next) next.focus({ preventScroll: true });
}
export const fmtNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(d).replace('.', ',') : '';
};
export const fmtMin = (n) => {
  if (!n || n <= 0) return '';
  if (n < 60) return n + ' min';
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? h + ' h ' + String(r).padStart(2, '0') : h + ' h';
};
export const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
};
export const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
export const typeLabel = (it) => (it.type === 'tv' ? 'Série' : 'Film');
export const cut = (list, n) => (list ? list.slice(0, n) : null);
export function store(key, value) {
  try {
    if (value === undefined) {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* stockage indisponible */ }
  return null;
}
export const names = (type, code) => {
  try {
    return new Intl.DisplayNames(['fr'], { type }).of(code) || code;
  } catch (_) {
    return code;
  }
};
export const getSeen = () => userStore.getSeen();
