/* Graphiques SVG maison de la console d'administration (aucune bibliothèque). Fonctions pures : données -> chaîne HTML.
 * Couleurs : variables CSS --adm-* (admin.css), donc thème et contraste suivent la page. Chaque graphique est un role="img"
 * avec une description FR ; les mêmes chiffres sont toujours donnés en tableau à côté. */
import { esc } from './util.js';

const W = 480;
const H = 190;
const PAD = { l: 46, r: 10, t: 10, b: 24 };

const num = (n) => Math.round(n * 10) / 10;

/** Valeur « ronde » au-dessus du max, pour une échelle lisible. */
function niceMax(max) {
  if (!(max > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** Mini-courbe sans axes (cartes de la vue d'ensemble). */
export function sparkline(values, label, cls) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return '<svg class="adm-spark" viewBox="0 0 120 36" role="img" aria-label="' + esc(label + ' : pas assez de données') + '"><path class="adm-spark-base" d="M0 34H120"/></svg>';
  const max = Math.max(...v, 1);
  const pts = v.map((y, i) => [num((i / (v.length - 1)) * 120), num(33 - (y / max) * 30)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join('');
  return '<svg class="adm-spark ' + (cls || '') + '" viewBox="0 0 120 36" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
    '<path class="adm-spark-area" d="' + line + 'L120 36L0 36Z"/><path class="adm-spark-line" d="' + line + '"/></svg>';
}

/**
 * Courbes sur une même échelle. series : [{ name, values, cls }] ; labels : étiquettes de l'axe X (même longueur) ;
 * yFmt : formateur de l'axe Y ; description : texte alternatif.
 */
export function lineChart({ series, labels, yFmt, description }) {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (n < 2) return '<p class="adm-empty" role="status">Pas encore assez de données sur cette période.</p>';
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter(Number.isFinite))));
  const x = (i) => num(PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v) => num(H - PAD.b - (v / max) * (H - PAD.t - PAD.b));
  const grid = [0, 0.5, 1].map((f) => {
    const gy = y(max * f);
    return '<line class="adm-grid" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + gy + '" y2="' + gy + '"/><text class="adm-axis" x="' + (PAD.l - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + esc(yFmt(max * f)) + '</text>';
  }).join('');
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].map((i, k) =>
    '<text class="adm-axis" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (k === 0 ? 'start' : k === 2 ? 'end' : 'middle') + '">' + esc(labels[i] || '') + '</text>').join('');
  const paths = series.map((s) => {
    const d = s.values.map((v, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(Number.isFinite(v) ? v : 0)).join('');
    const area = s.area ? '<path class="adm-area ' + s.cls + '" d="' + d + 'L' + x(s.values.length - 1) + ' ' + y(0) + 'L' + x(0) + ' ' + y(0) + 'Z"/>' : '';
    return area + '<path class="adm-line ' + s.cls + '" d="' + d + '"/>';
  }).join('');
  const legend = series.length > 1
    ? '<ul class="adm-legend" aria-hidden="true">' + series.map((s) => '<li><i class="adm-key ' + s.cls + '"></i>' + esc(s.name) + '</li>').join('') + '</ul>' : '';
  return '<figure class="adm-fig"><svg class="adm-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(description) + '">' + grid + paths + ticks + '</svg>' + legend + '</figure>';
}

/** Barre empilée d'une ligne (statuts) : parts : [{ value, cls, label }]. */
export function stackedBar(parts, description) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return '<svg class="adm-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="' + esc(description) + '"><rect class="adm-bar-bg" width="100" height="10" rx="2"/></svg>';
  let at = 0;
  const rects = parts.filter((p) => p.value > 0).map((p) => {
    const w = (p.value / total) * 100;
    const r = '<rect class="adm-seg ' + p.cls + '" x="' + num(at) + '" width="' + num(w) + '" height="10"><title>' + esc(p.label + ' : ' + p.value) + '</title></rect>';
    at += w;
    return r;
  }).join('');
  return '<svg class="adm-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="' + esc(description) + '"><rect class="adm-bar-bg" width="100" height="10" rx="2"/>' + rects + '</svg>';
}

/** Barre simple, `ratio` entre 0 et 1. */
export function simpleBar(ratio, cls, description) {
  return stackedBar([{ value: Math.max(0, Math.min(1, ratio)), cls, label: description }, { value: 1 - Math.max(0, Math.min(1, ratio)), cls: 'adm-seg-none', label: '' }], description);
}
