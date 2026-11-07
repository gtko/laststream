/**
 * Mémoire tampon de lecture : réglage « Mémoire tampon » (standard, grand, maximum), propre à l'appareil (pas de synchro compte).
 * Les trois niveaux ont la même signification dans chaque moteur : plus le niveau est grand, plus la lecture absorbe une source lente.
 * Valeurs partagées avec la coque Windows (mpv) : ne pas les changer sans les changer là-bas aussi.
 */

export type BufferLevel = 'standard' | 'large' | 'max';

const BUFFER_LEVEL_DEFAULT: BufferLevel = 'large';

const STORAGE_KEY = 'laststream.bufferlevel';
const LEVELS: readonly BufferLevel[] = ['standard', 'large', 'max'];

const isBufferLevel = (v: unknown): v is BufferLevel => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);

/** Niveau enregistré sur cet appareil ; absent, illisible ou inconnu : grand. */
export function getBufferLevel(): BufferLevel {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isBufferLevel(v) ? v : BUFFER_LEVEL_DEFAULT;
  } catch {
    return BUFFER_LEVEL_DEFAULT;
  }
}

/** Enregistre le niveau ; une valeur hors contrat est ignorée. Appliqué à la prochaine lecture. */
export function setBufferLevel(level: BufferLevel): void {
  if (!isBufferLevel(level)) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, level);
  } catch {
    // Stockage indisponible : le réglage vaut pour la session.
  }
}

export interface HlsBuffer {
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxBufferSize: number;
  backBufferLength: number;
}

const HLS: Record<BufferLevel, HlsBuffer> = {
  standard: { maxBufferLength: 40, maxMaxBufferLength: 600, maxBufferSize: 60e6, backBufferLength: 30 },
  large: { maxBufferLength: 120, maxMaxBufferLength: 600, maxBufferSize: 200e6, backBufferLength: 30 },
  max: { maxBufferLength: 300, maxMaxBufferLength: 600, maxBufferSize: 400e6, backBufferLength: 60 },
};

/** Options hls.js (lecteur web, VOD transcodée) pour ce niveau. */
export function hlsBuffer(level: BufferLevel): HlsBuffer {
  return { ...HLS[level] };
}

// cache-secs et demuxer-readahead-secs restent hauts et identiques : la taille du tampon ne dépend que des octets (demuxer-max-bytes), sinon une limite en secondes plafonnerait les vidéos à faible débit.
const MPV: Record<BufferLevel, Array<[string, string]>> = {
  standard: [['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '150MiB'], ['demuxer-max-back-bytes', '50MiB'], ['cache-pause-wait', '2']],
  large: [['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '512MiB'], ['demuxer-max-back-bytes', '64MiB'], ['cache-pause-wait', '5']],
  max: [['cache', 'yes'], ['cache-secs', '3600'], ['demuxer-readahead-secs', '3600'], ['demuxer-max-bytes', '1GiB'], ['demuxer-max-back-bytes', '128MiB'], ['cache-pause-wait', '10']],
};

/** Propriétés mpv (coque Windows) pour ce niveau, en chaînes comme les envoie `mpv-set-prop`. */
export function mpvBufferProps(level: BufferLevel): Array<[string, string]> {
  return MPV[level].map(([k, v]) => [k, v]);
}

const VLC_CACHING_MS: Record<BufferLevel, number> = { standard: 3000, large: 8000, max: 30000 };

/** Mise en tampon réseau de libVLC (Android), en millisecondes. */
export function vlcNetworkCachingMs(level: BufferLevel): number {
  return VLC_CACHING_MS[level];
}
