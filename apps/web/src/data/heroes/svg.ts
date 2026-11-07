/* Petites primitives SVG : formes encrées (contour fin façon comics), traits, symétrie. */
import type { Ctx } from './types';

/** Forme pleine avec contour d'encre arrondi. */
export const p = (c: Ctx, d: string, fill: string, sw = 1.3, extra = ''): string =>
  `<path d="${d}" fill="${fill}" stroke="${c.ink}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"${extra ? ' ' + extra : ''}/>`;

/** Forme pleine sans contour. */
export const f = (d: string, fill: string, extra = ''): string => `<path d="${d}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;

/** Trait seul. */
export const ln = (d: string, stroke: string, w = 1.5, extra = ''): string =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra ? ' ' + extra : ''}/>`;

export const circ = (c: Ctx, x: number, y: number, r: number, fill: string, sw = 1.3): string =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"${sw ? ` stroke="${c.ink}" stroke-width="${sw}"` : ''}/>`;

/** Reflet horizontal autour de l'axe x = 64. */
export const mirror = (s: string): string => `<g transform="translate(128 0) scale(-1 1)">${s}</g>`;

/** Dessine `s` puis son reflet. */
export const both = (s: string): string => s + mirror(s);
