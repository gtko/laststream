/* Port du prototype (voir tools/port-prototype.mjs). */
import { userStore } from '../data/userStore';

export const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
