/* Utilitaires du générateur d'avatars « Héros » : hasard déterministe et couleurs. */

export type Rng = () => number;

/** Hachage FNV-1a 32 bits. */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Générateur pseudo-aléatoire mulberry32 : même graine, même suite. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rng, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;

/** Tirage pondéré : liste de [valeur, poids]. */
export function pickW<T>(r: Rng, list: ReadonlyArray<readonly [T, number]>): T {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of list) {
    x -= w;
    if (x < 0) return v;
  }
  return (list[list.length - 1] as readonly [T, number])[0];
}

const hex2rgb = (c: string): [number, number, number] => {
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Mélange a -> b (t de 0 à 1). */
export function mix(a: string, b: string, t: number): string {
  const x = hex2rgb(a);
  const y = hex2rgb(b);
  return '#' + to2(x[0] + (y[0] - x[0]) * t) + to2(x[1] + (y[1] - x[1]) * t) + to2(x[2] + (y[2] - x[2]) * t);
}
export const darken = (c: string, t: number): string => mix(c, '#0b0d14', t);
export const lighten = (c: string, t: number): string => mix(c, '#ffffff', t);

/** Éclat d'une couleur (saturation x luminosité), pour choisir la teinte du fond. */
export function vividness(c: string): number {
  const [r, g, b] = hex2rgb(c).map((v) => v / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return (mx - mn) * (0.4 + mx);
}

/** Arrondi à 2 décimales pour garder des SVG compacts. */
export const n2 = (n: number): string => String(Math.round(n * 100) / 100);

/** Distance entre deux couleurs (RGB), pour choisir celle qui contraste. */
export function colorDist(a: string, b: string): number {
  const x = hex2rgb(a);
  const y = hex2rgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
