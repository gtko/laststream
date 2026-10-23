import type { QualityGroupKey } from '../data/sources';
import { getResolutionCap, type ResolutionCap } from '../data/prefs';
import { nativeScreenShortSide } from './nativeScreen';

/* Plafond de résolution (ODY-236) : la source choisie d'office, en lecture comme en téléchargement, ne dépasse pas la résolution
 * réglée (ou celle de l'écran en mode automatique) tant qu'une source plus légère existe. Fonctions pures, testées. */

/** Hauteur en pixels de chaque groupe de qualité (`other` : résolution inconnue, jamais comptée au-dessus d'un plafond). */
export const GROUP_HEIGHT: Record<QualityGroupKey, number> = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, SD: 480, other: 0 };

/** « 4K », « 2K », « 1080p »… pour une hauteur de plafond. */
export function capLabel(height: number): string {
  return height >= 2160 ? '4K' : height === 1440 ? '2K' : height + 'p';
}

/**
 * Hauteur de plafond : celle du réglage, ou en automatique celle de l'écran (côté court en pixels physiques, arrondi à la
 * résolution courante : 1920×1080 → 1080p, 2560×1440 → 1440p). Jamais sous 1080p en automatique (le zoom du navigateur réduit
 * `devicePixelRatio` : le 720p reste un choix explicite). Écran inconnu : aucun plafond.
 */
export function capHeightOf(setting: ResolutionCap, screenShortSidePx: number | null): number | null {
  if (setting !== 'auto') return parseInt(setting, 10);
  if (screenShortSidePx === null || !Number.isFinite(screenShortSidePx) || screenShortSidePx <= 0) return null;
  if (screenShortSidePx <= 1200) return 1080;
  if (screenShortSidePx <= 1600) return 1440;
  return 2160;
}

/**
 * Côté court de l'écran en pixels physiques (null si le moteur ne le dit pas). Sur Android, la sortie vidéo réelle lue par le
 * plugin natif prime (la WebView d'une TV 4K déclare souvent 1080p) ; ailleurs, `screen` × `devicePixelRatio`.
 */
export function screenShortSide(): number | null {
  const native = nativeScreenShortSide();
  if (native !== null) return native;
  const s = globalThis.screen;
  if (!s || !(s.width > 0) || !(s.height > 0)) return null;
  const ratio = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
  return Math.round(Math.min(s.width, s.height) * ratio);
}

/** Plafond en vigueur sur cet appareil (réglage + écran), ou null. */
export function currentCapHeight(): number | null {
  return capHeightOf(getResolutionCap(), screenShortSide());
}

export interface CapResult<T> {
  /** Sources retenues pour le choix automatique. */
  pool: T[];
  /** Sources écartées parce qu'elles dépassent le plafond. */
  hidden: number;
  /** Aucune source sous le plafond : groupe de la plus proche au-dessus, qui devient le choix. */
  above: QualityGroupKey | null;
}

/**
 * Applique le plafond. Sous le plafond (ou de résolution inconnue) : on garde ces sources ; aucune ? la résolution connue la
 * plus proche au-dessus est gardée seule (`above`). Sans plafond, tout passe.
 */
export function capViews<T extends { group: QualityGroupKey }>(views: readonly T[], capHeight: number | null): CapResult<T> {
  if (capHeight === null) return { pool: [...views], hidden: 0, above: null };
  const over = (v: T): boolean => GROUP_HEIGHT[v.group] > capHeight;
  const under = views.filter((v) => !over(v));
  if (under.some((v) => v.group !== 'other') || (under.length > 0 && !views.some(over))) {
    return { pool: under, hidden: views.length - under.length, above: null };
  }
  const aboveViews = views.filter(over);
  if (!aboveViews.length) return { pool: [...views], hidden: 0, above: null };
  const nearest = aboveViews.reduce((m, v) => (GROUP_HEIGHT[v.group] < GROUP_HEIGHT[m.group] ? v : m)).group;
  return { pool: aboveViews.filter((v) => v.group === nearest), hidden: views.length - aboveViews.filter((v) => v.group === nearest).length, above: nearest };
}

/** La source dépasse-t-elle le plafond ? */
export const overCap = (group: QualityGroupKey, capHeight: number | null): boolean => capHeight !== null && GROUP_HEIGHT[group] > capHeight;
