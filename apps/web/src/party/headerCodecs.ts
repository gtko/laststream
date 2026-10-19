import type { DecodeCap } from '../relay/protocol';
import { openMedia, type OpenedMedia } from '../relay/player/demux';
import type { MediaInfo, RangeReader } from '../relay/player/types';
import { urlRangeSource } from '../relay/sources';
import type { FileCodecs, SourceLike } from './compat';

/* Codecs lus dans l'en-tête d'un fichier (mediabunny, lecture de plages seulement), en remplacement prioritaire du nom de la
 * source. Le cache garde les codecs par identité de fichier : jamais l'URL. Le cache partagé serveur viendra plus tard : les
 * fonctions `getCodecs` / `putCodecs` sont isolées pour cela. */

const VIDEO_KEYS = new Map<string, DecodeCap>([
  ['avc', 'h264'],
  ['hevc', 'hevc'],
  ['av1', 'av1'],
  ['vp9', 'vp9'],
]);

const AUDIO_KEYS = new Map<string, DecodeCap | 'truehd'>([
  ['aac', 'aac'],
  ['opus', 'opus'],
  ['flac', 'flac'],
  ['ac3', 'ac3'],
  ['eac3', 'eac3'],
  ['dts', 'dts'],
  ['truehd', 'truehd'],
]);

/** Codec vidéo tel que mediabunny le rapporte (`avc`, `hevc`, `av1`, `vp9`) -> clé de capacité ; autre : null (inconnu). */
export function videoCodecKey(codec: string | null | undefined): DecodeCap | null {
  return codec ? (VIDEO_KEYS.get(codec) ?? null) : null;
}

/** Codec audio tel que mediabunny le rapporte -> clé de capacité, ou `truehd` ; autre : null (inconnu). */
export function audioCodecKey(codec: string | null | undefined): DecodeCap | 'truehd' | null {
  return codec ? (AUDIO_KEYS.get(codec) ?? null) : null;
}

/** Codecs d'un fichier à partir de ses pistes lues par mediabunny. */
export function fileCodecsFromMedia(info: Pick<MediaInfo, 'video' | 'audio'>): FileCodecs {
  return { video: videoCodecKey(info.video?.codec), audio: audioCodecKey(info.audio?.codec) };
}

/**
 * Codecs lus dans l'en-tête d'une source (plages seulement). Null si aucune piste n'est identifiée : c'est alors inconnu,
 * et le nom de la source reprend la main.
 */
export async function probeSource(reader: RangeReader): Promise<FileCodecs | null> {
  const media: OpenedMedia = await openMedia(reader);
  try {
    const codecs = fileCodecsFromMedia(media.info);
    return codecs.video || codecs.audio ? codecs : null;
  } finally {
    media.close();
  }
}

/** Codecs lus dans l'en-tête d'un lien HTTP(S) lisible par cet appareil (débridé ou direct). L'URL n'est ni gardée ni journalisée. */
export function probeUrl(url: string): Promise<FileCodecs | null> {
  return probeSource(urlRangeSource({ url }));
}

// ---- Cache des codecs ----

const LS_PREFIX = 'laststream.codecs.';
const memory = new Map<string, FileCodecs>();

const VIDEO_CAP_KEYS = new Set<string>(VIDEO_KEYS.values());
const AUDIO_CAP_KEYS = new Set<string>(AUDIO_KEYS.values());

/** Valeur de cache bien formée : clés de capacité (pas les noms mediabunny), ou null pour une piste absente. */
function isFileCodecs(v: unknown): v is FileCodecs {
  if (typeof v !== 'object' || v === null) return false;
  const { video, audio } = v as Record<string, unknown>;
  const okVideo = video === null || (typeof video === 'string' && VIDEO_CAP_KEYS.has(video));
  const okAudio = audio === null || (typeof audio === 'string' && AUDIO_CAP_KEYS.has(audio));
  return okVideo && okAudio;
}

/** Codecs en cache pour cette clé (mémoire, puis localStorage), ou null. Un stockage indisponible ne lève rien. */
export function getCodecs(key: string): FileCodecs | null {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isFileCodecs(parsed)) return null;
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Range les codecs d'une clé en mémoire et dans localStorage. Un stockage indisponible ne lève rien. */
export function putCodecs(key: string, codecs: FileCodecs): void {
  memory.set(key, codecs);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_PREFIX + key, JSON.stringify(codecs));
  } catch {
    // Stockage plein ou bloqué : le cache mémoire suffit pour cette session.
  }
}

/** SHA-256 en hexadécimal, ou null si l'API de chiffrement n'est pas disponible. */
async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Clé de cache d'une source, sans aucune URL : `h:<infoHash>:<fileIdx>` si la source a un infoHash, sinon
 * `n:<SHA-256 du nom de fichier et de la taille>`. Null si l'identité du fichier est inconnue.
 */
export async function codecCacheKey(view: (Pick<SourceLike, 'filename' | 'stream'> & { sizeBytes?: number }) | null | undefined): Promise<string | null> {
  if (!view) return null;
  const stream = view.stream ?? null;
  const hash = (stream?.infoHash ?? '').trim().toLowerCase();
  if (hash) return 'h:' + hash.slice(0, 64) + ':' + (stream?.fileIdx ?? '');
  const name = (view.filename || stream?.behaviorHints?.filename || '').trim();
  if (!name) return null;
  const size = Math.round(view.sizeBytes || stream?.behaviorHints?.videoSize || 0);
  const digest = await sha256Hex(name + '\u0000' + size);
  return digest ? 'n:' + digest : null;
}
