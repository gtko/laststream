/* Port du prototype (voir tools/port-prototype.mjs). */
import { DAY_MS } from './constants.js';

export const todayStr = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10);
export const dayDiff = (iso) => Math.round((Date.parse(String(iso).slice(0, 10)) - Date.parse(todayStr())) / DAY_MS);
export const isFuture = (iso) => !!iso && dayDiff(iso) > 0;
export const fmtShort = (iso) => {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};
export function countdown(iso) {
  const n = dayDiff(iso);
  if (n < 0) return '';
  if (n === 0) return 'aujourd’hui';
  if (n === 1) return 'demain';
  if (n < 61) return 'dans ' + n + ' jours';
  return 'dans ' + Math.round(n / 30) + ' mois';
}
