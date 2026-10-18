/* Mini-lecteur : calculs purs (géométrie de la vignette, aimantation aux coins, marges mpv, découpe de la page) et petit
 * contrôleur d'état. Aucun accès au DOM ici : le rendu est dans miniview.js, le perçage de la page dans minihole.js. */

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface Rect { left: number; top: number; width: number; height: number }
export interface WinSize { width: number; height: number }
export interface MpvMargins { left: number; right: number; top: number; bottom: number }
export interface MiniLayout {
  /** Boîte du mini-lecteur (la barre entière en mode mobile). */
  box: Rect;
  /** Zone de l'image : c'est là que la vidéo est vue (et mpv calé). */
  video: Rect;
  /** Barre pleine largeur en bas (fenêtre étroite). */
  bar: boolean;
}

export const MINI_MARGIN = 24;
export const MINI_MIN = 280;
export const MINI_MAX = 480;
export const MINI_VW = 0.22;
export const MOBILE_BREAKPOINT = 640;
export const BAR_HEIGHT = 72;
export const MINI_RADIUS = 12;
export const CORNERS: readonly Corner[] = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_CORNER: Corner = 'br';
export const CORNER_KEY = 'laststream.player.miniCorner';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const isCorner = (v: unknown): v is Corner => typeof v === 'string' && (CORNERS as readonly string[]).includes(v);

/** Barre mobile : fenêtre de moins de 640 px. */
export const isBarLayout = (winWidth: number): boolean => winWidth < MOBILE_BREAKPOINT;

/** Largeur de la vignette : 22 vw, entre 280 et 480 px. */
export const miniWidth = (winWidth: number): number => clamp(Math.round(winWidth * MINI_VW), MINI_MIN, MINI_MAX);

/** Position et taille du mini-lecteur pour une fenêtre et un coin donnés. */
export function miniLayout(win: WinSize, corner: Corner = DEFAULT_CORNER): MiniLayout {
  if (isBarLayout(win.width)) {
    const box = { left: 0, top: Math.max(0, win.height - BAR_HEIGHT), width: win.width, height: BAR_HEIGHT };
    return { box, video: { left: 0, top: box.top, width: Math.round((BAR_HEIGHT * 16) / 9), height: BAR_HEIGHT }, bar: true };
  }
  const width = miniWidth(win.width);
  const height = Math.round((width * 9) / 16);
  const left = corner === 'tl' || corner === 'bl' ? MINI_MARGIN : Math.max(0, win.width - MINI_MARGIN - width);
  const top = corner === 'tl' || corner === 'tr' ? MINI_MARGIN : Math.max(0, win.height - MINI_MARGIN - height);
  const box = { left, top, width, height };
  return { box, video: { ...box }, bar: false };
}

/** Coin le plus proche du centre de la vignette (aimantation après un glissement). */
export function snapCorner(center: { x: number; y: number }, win: WinSize): Corner {
  const horizontal = center.x < win.width / 2 ? 'l' : 'r';
  const vertical = center.y < win.height / 2 ? 't' : 'b';
  return (vertical + horizontal) as Corner;
}

/** Garde la boîte entièrement dans la fenêtre (glissement libre avant l'aimantation). */
export function clampBox(box: Rect, win: WinSize): Rect {
  return {
    ...box,
    left: clamp(box.left, 0, Math.max(0, win.width - box.width)),
    top: clamp(box.top, 0, Math.max(0, win.height - box.height)),
  };
}

export const ZERO_MARGINS: MpvMargins = { left: 0, right: 0, top: 0, bottom: 0 };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Marges `video-margin-ratio-*` de mpv : la part de la fenêtre laissée libre de chaque côté de l'image.
 * `rect` est exprimé dans le repère de la fenêtre (px CSS, comme `getBoundingClientRect`).
 */
export function mpvMargins(rect: Rect, win: WinSize): MpvMargins {
  if (!(win.width > 0) || !(win.height > 0)) return { ...ZERO_MARGINS };
  const unit = (n: number) => round6(clamp(n, 0, 0.99));
  const left = unit(rect.left / win.width);
  const top = unit(rect.top / win.height);
  const right = unit((win.width - rect.left - rect.width) / win.width);
  const bottom = unit((win.height - rect.top - rect.height) / win.height);
  return { left, right, top, bottom };
}

export const sameMargins = (a: MpvMargins | null, b: MpvMargins | null): boolean =>
  !!a && !!b && a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;

/** Propriétés mpv à envoyer (`mpv-set-prop`) pour des marges données. */
export function marginProps(m: MpvMargins): Array<[string, number]> {
  return [
    ['video-margin-ratio-left', m.left],
    ['video-margin-ratio-right', m.right],
    ['video-margin-ratio-top', m.top],
    ['video-margin-ratio-bottom', m.bottom],
  ];
}

/** Rectangle aux coins arrondis, sous forme de commandes `path()` (rayon borné à la moitié du plus petit côté). */
export function roundedRectPath(r: Rect, radius: number): string {
  const k = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  const x = r.left;
  const y = r.top;
  const right = x + r.width;
  const bottom = y + r.height;
  const n = (v: number) => String(Math.round(v * 100) / 100);
  if (k === 0) return `M${n(x)} ${n(y)}H${n(right)}V${n(bottom)}H${n(x)}Z`;
  return `M${n(x + k)} ${n(y)}H${n(right - k)}A${n(k)} ${n(k)} 0 0 1 ${n(right)} ${n(y + k)}V${n(bottom - k)}`
    + `A${n(k)} ${n(k)} 0 0 1 ${n(right - k)} ${n(bottom)}H${n(x + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x)} ${n(bottom - k)}`
    + `V${n(y + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x + k)} ${n(y)}Z`;
}

/**
 * `clip-path` qui dessine tout l'élément (`size`) sauf un trou arrondi à l'emplacement `hole` (repère de l'élément) :
 * deux sous-chemins en règle `evenodd`, le rectangle plein puis la vignette.
 */
export function holeClipPath(size: { width: number; height: number }, hole: Rect, radius = MINI_RADIUS): string {
  const outer = `M0 0H${Math.round(size.width * 100) / 100}V${Math.round(size.height * 100) / 100}H0Z`;
  return `path(evenodd, '${outer} ${roundedRectPath(hole, radius)}')`;
}

/** Même découpe en repère d'un élément dont la boîte est `el` (le trou est donné dans le repère de la fenêtre). */
export function holeClipFor(el: Rect, hole: Rect, radius = MINI_RADIUS): string {
  return holeClipPath({ width: el.width, height: el.height }, { ...hole, left: hole.left - el.left, top: hole.top - el.top }, radius);
}

/** Position relative d'un rectangle dans un autre (marge de la vidéo dans la barre mobile). */
export const relativeTo = (r: Rect, origin: Rect): Rect => ({ ...r, left: r.left - origin.left, top: r.top - origin.top });

// ---------- Contrôleur d'état ----------

export interface MiniStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }

/**
 * État du mini-lecteur : réduit ou non, coin choisi. La lecture elle-même n'est jamais touchée (même moteur, même élément
 * vidéo) : réduire, agrandir ou naviguer ne change ni la position de lecture ni la session.
 */
export class MiniState {
  mini = false;
  corner: Corner = DEFAULT_CORNER;
  private storage: MiniStorage | null;
  private listener: ((mini: boolean) => void) | null = null;

  constructor(storage: MiniStorage | null = null) {
    this.storage = storage;
    try {
      const saved = storage ? storage.getItem(CORNER_KEY) : null;
      if (isCorner(saved)) this.corner = saved;
    } catch (_) { /* stockage indisponible : coin par défaut */ }
  }

  onChange(fn: (mini: boolean) => void): void { this.listener = fn; }

  /** Réduit. Renvoie faux s'il l'était déjà. */
  minimize(): boolean {
    if (this.mini) return false;
    this.mini = true;
    if (this.listener) this.listener(true);
    return true;
  }

  /** Revient au plein lecteur. Renvoie faux s'il l'était déjà. */
  expand(): boolean {
    if (!this.mini) return false;
    this.mini = false;
    if (this.listener) this.listener(false);
    return true;
  }

  /** Fin de session (fermeture ou autre lecture) : retour au plein lecteur, le coin choisi est conservé. */
  reset(): void { this.expand(); }

  setCorner(c: Corner): void {
    if (!isCorner(c)) return;
    this.corner = c;
    try { if (this.storage) this.storage.setItem(CORNER_KEY, c); } catch (_) { /* ignoré */ }
  }
}
