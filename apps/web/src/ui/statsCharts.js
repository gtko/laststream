/* Graphiques SVG maison de la page Statistiques (#/stats, ui/stats.js) : barres verticales et horizontales, sans dépendance.
 * Fonctions pures qui renvoient du HTML : couleurs, polices et tailles sont dans styles/stats.css (classes .bar, .axis, .val). */
import { esc } from './util.js';

const W = 360;
const r = (n) => Math.round(n * 10) / 10;

const svg = (height, label, inner, cls) =>
  '<svg class="stats-svg' + (cls ? ' ' + cls : '') + '" viewBox="0 0 ' + W + ' ' + height + '" role="img" aria-label="' + esc(label) + '" focusable="false">' + inner + '</svg>';

/**
 * Barres verticales. `items` : { label, value, title? } ; `fmt` formate le nombre au-dessus d'une barre non nulle (chaîne vide : rien).
 * La hauteur est proportionnelle au maximum ; une valeur nulle n'a pas de barre.
 */
export function columnsSvg(items, { ariaLabel = '', fmt = (v) => String(Math.round(v)), height = 150 } = {}) {
  const n = Math.max(1, items.length);
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const top = 20;
  const base = height - 22;
  const span = base - top;
  const slot = W / n;
  const bw = Math.min(28, slot * 0.6);
  const bars = items.map((it, i) => {
    const cx = i * slot + slot / 2;
    const h = it.value > 0 ? Math.max(2, (it.value / max) * span) : 0;
    const y = base - h;
    const text = it.value > 0 ? fmt(it.value) : '';
    return '<g><title>' + esc(it.title ?? it.label) + '</title>' +
      (h ? '<rect class="bar" x="' + r(cx - bw / 2) + '" y="' + r(y) + '" width="' + r(bw) + '" height="' + r(h) + '" rx="3"/>' : '') +
      (text ? '<text class="val" x="' + r(cx) + '" y="' + r(y - 5) + '" text-anchor="middle">' + esc(text) + '</text>' : '') +
      '<text x="' + r(cx) + '" y="' + (height - 6) + '" text-anchor="middle">' + esc(it.label) + '</text></g>';
  }).join('');
  return svg(height, ariaLabel, '<line class="axis" x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '"/>' + bars, 'columns');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Barres horizontales : libellé à gauche, barre, valeur. `items` : { label, value }. */
export function rowsSvg(items, { ariaLabel = '', fmt = (v) => String(Math.round(v)) } = {}) {
  const ROW = 26;
  const BAR_X = 124;
  const BAR_MAX = 150;
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const height = Math.max(1, items.length) * ROW + 4;
  const body = items.map((it, i) => {
    const y = i * ROW + 4;
    const w = it.value > 0 ? Math.max(3, (it.value / max) * BAR_MAX) : 0;
    return '<text x="0" y="' + (y + 14) + '">' + esc(clip(it.label, 16)) + '</text>' +
      (w ? '<rect class="bar" x="' + BAR_X + '" y="' + (y + 3) + '" width="' + r(w) + '" height="14" rx="4"/>' : '') +
      '<text class="val" x="' + r(BAR_X + w + 6) + '" y="' + (y + 14) + '">' + esc(fmt(it.value)) + '</text>';
  }).join('');
  return svg(height, ariaLabel, body, 'rows');
}
