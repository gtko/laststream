/* Affiche typographique : quand TMDB n'a aucune image, une affiche générée (dégradé propre au titre, monogramme, titre,
 * année et genre) remplace la boîte vide. Même composant pour les cartes portrait et paysage. */
import { esc } from './util.js';

const ICON_FILM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg>';
const ICON_TV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';

/** Empreinte stable d'un titre (FNV-1a). */
export function hashTitle(title) {
  let h = 2166136261;
  for (const c of String(title || '')) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Deux teintes sombres et sourdes, dans la gamme de la marque, différentes d'un titre à l'autre. */
export function palette(title) {
  const h = hashTitle(title);
  const hue = h % 360;
  const sat = 24 + (h >>> 9) % 14; // 24 à 37 %
  return { c1: 'hsl(' + hue + ' ' + sat + '% 21%)', c2: 'hsl(' + ((hue + 38) % 360) + ' ' + (sat + 4) + '% 10%)', hue };
}

/** Taille du titre selon sa longueur : il reste lisible sur 2 à 4 lignes. */
export function titleSize(title) {
  const n = String(title || '').length;
  return n <= 12 ? 26 : n <= 22 ? 22 : n <= 34 ? 18 : 15;
}

const monogram = (title) => {
  const words = String(title || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  const m = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return m.toUpperCase();
};

/** Contenu `.card-fallback` d'une tuile : `it` = { name, year, genre, type }. */
export function fallbackHTML(it) {
  const p = palette(it.name);
  const sub = [it.year, it.genre].filter(Boolean).join(' · ');
  return '<span class="card-fallback tp" style="--tp1:' + p.c1 + ';--tp2:' + p.c2 + ';--tp-size:' + titleSize(it.name) + 'px">' +
    '<span class="tp-mono" aria-hidden="true">' + esc(monogram(it.name)) + '</span>' +
    '<span class="tp-icon" aria-hidden="true">' + (it.type === 'tv' ? ICON_TV : ICON_FILM) + '</span>' +
    '<span class="tp-grain" aria-hidden="true"></span>' +
    '<span class="tp-title">' + esc(it.name) + '</span>' +
    (sub ? '<span class="tp-sub">' + esc(sub) + '</span>' : '') + '</span>';
}
