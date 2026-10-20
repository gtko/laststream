/* Aperçu d'image sur la barre de position : seaux de 10 s, cache LRU, cadence des déplacements. Logique pure, testée. */

export const BUCKET_SECONDS = 10;
export const CACHE_FRAMES = 120;
/** Intervalle minimal entre deux déplacements de la vidéo d'aperçu. */
export const MIN_SEEK_INTERVAL_MS = 150;
/** Le pointeur doit être resté immobile ce temps avant de demander une image. */
export const REST_MS = 90;
/** En dessous de ce débit connu, pas d'aperçu : il concurrencerait la lecture. */
export const MIN_BANDWIDTH_KBPS = 4000;

export const bucketOf = (t: number, size = BUCKET_SECONDS): number => Math.max(0, Math.floor(t / size));

/** Instant demandé pour un seau : son milieu, jamais au-delà de la fin. */
export function bucketTime(bucket: number, duration: number, size = BUCKET_SECONDS): number {
  const mid = bucket * size + size / 2;
  return duration > 1 ? Math.min(mid, duration - 1) : mid;
}

/** Cache LRU d'images par seau ; `nearest` renvoie le seau le plus proche déjà connu. */
export class FrameCache<T> {
  private readonly map = new Map<number, T>();

  constructor(private readonly capacity = CACHE_FRAMES) {}

  get size(): number { return this.map.size; }

  has(bucket: number): boolean { return this.map.has(bucket); }

  get(bucket: number): T | undefined {
    const v = this.map.get(bucket);
    if (v !== undefined) { this.map.delete(bucket); this.map.set(bucket, v); }
    return v;
  }

  set(bucket: number, value: T): void {
    this.map.delete(bucket);
    this.map.set(bucket, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as number;
      this.map.delete(oldest);
    }
  }

  nearest(bucket: number): { bucket: number; value: T } | null {
    let best: number | null = null;
    for (const k of this.map.keys()) if (best === null || Math.abs(k - bucket) < Math.abs(best - bucket)) best = k;
    return best === null ? null : { bucket: best, value: this.map.get(best) as T };
  }

  clear(): void { this.map.clear(); }
}

export interface SeekState {
  now: number;
  bucket: number;
  lastMoveAt: number;
  lastSeekAt: number;
  /** Seau en cours de chargement (null : aucun déplacement en attente). */
  pendingBucket: number | null;
  cached: boolean;
}

/** Faut-il déplacer la vidéo d'aperçu maintenant ? Pointeur au repos, cadence respectée, rien en attente pour ce seau. */
export function shouldSeek(s: SeekState): boolean {
  if (s.cached || s.pendingBucket === s.bucket) return false;
  if (s.now - s.lastMoveAt < REST_MS) return false;
  return s.now - s.lastSeekAt >= MIN_SEEK_INTERVAL_MS;
}

export interface ThumbContext {
  enabled: boolean;
  /** Une source d'aperçu existe pour le moteur et le format courants (voir `thumbSource`). */
  hasSource: boolean;
  duration: number;
  /** Débit connu en kb/s (null : inconnu). */
  bandwidthKbps: number | null;
  /** Torrent encore en train de se remplir : l'aperçu lui volerait des pièces. */
  torrentBuffering: boolean;
}

export function thumbsAllowed(c: ThumbContext): boolean {
  if (!c.enabled || !c.hasSource || !(c.duration > 30)) return false;
  if (c.bandwidthKbps !== null && c.bandwidthKbps < MIN_BANDWIDTH_KBPS) return false;
  return !c.torrentBuffering;
}

/** Position du cadre d'aperçu au-dessus de la barre : centré sur le curseur sans déborder (pixels, relatifs à la barre). */
export function clampTooltip(center: number, barWidth: number, tipWidth: number): number {
  const half = tipWidth / 2;
  return Math.min(Math.max(center, half), Math.max(half, barWidth - half));
}

/** Largeur demandée au serveur pour la session HLS réservée aux aperçus (légère : une image 240x135 suffit). */
export const THUMB_HLS_WIDTH = 320;
/** Après ce nombre d'échecs de lecture, on renonce aux aperçus pour la source courante (repli silencieux). */
export const MAX_THUMB_FAILURES = 3;

export type ThumbSource = { mode: 'direct' } | { mode: 'hls'; forceTranscoding: boolean; maxWidth: number } | { mode: 'addon' } | { mode: 'range' } | { mode: 'none' };

export interface ThumbSourceInput {
  /** Moteur de lecture choisi : 'direct' | 'hls' | 'mpv' | 'native'. */
  engine: string | null | undefined;
  hasMedia: boolean;
  /** Serveur de streaming joignable (nécessaire pour toute session HLS). */
  serverUp: boolean;
  forceHls?: boolean;
  /** lastAddon annonce qu'il sait générer des miniatures (ffmpeg disponible). */
  addon?: boolean;
  /** Lien débridé https distant et WebCodecs disponible : miniatures décodées ici (src/thumbs), lues chez l'hébergeur. */
  range?: boolean;
}

/**
 * D'où viennent les images d'aperçu selon le moteur :
 * - lien débridé distant (toutes plateformes) : src/thumbs, démultiplexage par plages lues chez l'hébergeur + WebCodecs, sans ffmpeg ;
 * - lecture directe : le fichier lui-même (le navigateur sait le lire) ;
 * - HLS : une seconde session du serveur, basse résolution ;
 * - mpv : le fichier n'est souvent pas décodable par la WebView (MKV/HEVC/AV1/DTS) → images générées par ffmpeg côté lastAddon
 *   (une toutes les 30 s), si le serveur l'annonce ; sinon aucun aperçu ;
 * - natif (Android) ou serveur absent : aucun aperçu (l'option est alors masquée).
 */
export function thumbSource(i: ThumbSourceInput): ThumbSource {
  if (!i.hasMedia) return { mode: 'none' };
  if (i.range) return { mode: 'range' };
  if (i.engine === 'direct') return { mode: 'direct' };
  if (i.engine === 'hls') return i.serverUp ? { mode: 'hls', forceTranscoding: !!i.forceHls, maxWidth: THUMB_HLS_WIDTH } : { mode: 'none' };
  if (i.engine === 'mpv') return i.addon ? { mode: 'addon' } : { mode: 'none' };
  return { mode: 'none' };
}
