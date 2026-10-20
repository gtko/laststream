/** Outils de couleur du panneau « Personnalisé » : conversion HSL, contraste du texte sombre et correction de luminosité. */
import { contrastRatio, onAccent } from './theme';

/** Seuil WCAG AA pour un texte de taille normale. */
export const AA_TEXT = 4.5;

export interface Hsl {
  /** Teinte, 0 à 360. */
  h: number;
  /** Saturation, 0 à 1. */
  s: number;
  /** Luminosité, 0 à 1. */
  l: number;
}

/** #RRGGBB valide (vérifié en amont avec isHexColor) vers HSL. */
export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: Math.min(1, s), l };
}

/** HSL vers #rrggbb (minuscules). */
export function hslToHex({ h, s, l }: Hsl): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')).join('');
}

/** Contraste du texte que l'application pose réellement sur l'accent (sombre, ou blanc si le sombre n'atteint pas 4,5 : onAccent). */
export const textContrast = (accent: string): number => contrastRatio(accent, onAccent(accent));

/**
 * Même teinte et même saturation, luminosité relevée pas à pas jusqu'à ce que le texte posé sur l'accent atteigne `target`.
 * Ne sert que si ni le texte sombre ni le blanc n'y arrivent (tons moyens). Relever la luminosité HSL éclaircit chaque canal :
 * le contraste avec le texte sombre ne fait que croître (blanc au pire), la boucle aboutit donc toujours.
 */
export function brightenForText(accent: string, target = AA_TEXT): string {
  if (textContrast(accent) >= target) return accent.toLowerCase();
  const { h, s, l } = hexToHsl(accent);
  for (let k = Math.ceil(l * 200); k <= 200; k += 1) {
    const hex = hslToHex({ h, s, l: k / 200 });
    if (textContrast(hex) >= target) return hex;
  }
  return '#ffffff';
}

/** Ratio à une décimale, virgule française, arrondi vers le bas (on n'annonce jamais 4,5 pour 4,49). */
export const formatRatio = (r: number): string => (Math.floor(r * 10) / 10).toFixed(1).replace('.', ',');
