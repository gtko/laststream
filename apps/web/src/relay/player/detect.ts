import { DECODE_CAPS, type DecodeCap } from '../protocol';
import type { AudioTrackInfo, SupportResult, VideoTrackInfo } from './types';

/** Sous-ensemble de WebCodecs utilisé ici ; injectable pour les tests. */
export interface CodecEnv {
  VideoDecoder?: { isConfigSupported(config: VideoDecoderConfig): Promise<{ supported?: boolean }> };
  AudioDecoder?: { isConfigSupported(config: AudioDecoderConfig): Promise<{ supported?: boolean }> };
}

export interface TrackSet {
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
}

const LABELS: Record<string, string> = {
  avc: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
};

/** Libellé lisible d'un codec (nom court mediabunny). */
export function codecLabel(codec: string): string {
  return LABELS[codec] ?? (codec ? codec.toUpperCase() : 'inconnu');
}

export function defaultCodecEnv(): CodecEnv {
  return globalThis as unknown as CodecEnv;
}

const fail = (reason: string, codec: string): SupportResult => ({ ok: false, reason, codec });

async function isSupported(probe: () => Promise<{ supported?: boolean }>): Promise<boolean> {
  try {
    return (await probe()).supported === true;
  } catch {
    // Configuration refusée (TypeError) : équivalent à « non décodable ».
    return false;
  }
}

/**
 * Vérifie que le navigateur peut décoder les pistes du fichier (WebCodecs).
 * Renvoie `{ok: true}` si tout est décodable, sinon la raison et le codec en cause, en français.
 */
export async function checkSupport(tracks: TrackSet, env: CodecEnv = defaultCodecEnv()): Promise<SupportResult> {
  if (!tracks.video && !tracks.audio) return fail('Aucune piste audio ou vidéo lisible dans ce fichier.', '');

  const v = tracks.video;
  if (v) {
    const label = codecLabel(v.codec);
    if (!env.VideoDecoder) return fail('WebCodecs (VideoDecoder) indisponible dans ce navigateur.', label);
    if (!v.codecString) return fail(`Codec vidéo ${label} non décodable dans ce navigateur.`, label);
    const config: VideoDecoderConfig = {
      codec: v.codecString,
      ...(v.width > 0 ? { codedWidth: v.width } : {}),
      ...(v.height > 0 ? { codedHeight: v.height } : {}),
      ...(v.description ? { description: v.description } : {}),
    };
    const decoder = env.VideoDecoder;
    if (!(await isSupported(() => decoder.isConfigSupported(config)))) {
      return fail(`Codec vidéo ${label} non décodable dans ce navigateur.`, label);
    }
  }

  const a = tracks.audio;
  if (a) {
    const label = codecLabel(a.codec);
    if (!env.AudioDecoder) return fail('WebCodecs (AudioDecoder) indisponible dans ce navigateur.', label);
    if (!a.codecString) return fail(`Codec audio ${label} non décodable dans ce navigateur.`, label);
    const config: AudioDecoderConfig = {
      codec: a.codecString,
      sampleRate: a.sampleRate,
      numberOfChannels: a.numberOfChannels,
      ...(a.description ? { description: a.description } : {}),
    };
    const decoder = env.AudioDecoder;
    if (!(await isSupported(() => decoder.isConfigSupported(config)))) {
      return fail(`Codec audio ${label} non décodable dans ce navigateur.`, label);
    }
  }

  return { ok: true, reason: null, codec: null };
}

/** Codes WebCodecs sondés par capacité vidéo : la capacité est vraie si l'un d'eux est accepté. */
const VIDEO_PROBES: Partial<Record<DecodeCap, readonly string[]>> = {
  h264: ['avc1.640028', 'avc1.42E01E'],
  hevc: ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
  av1: ['av01.0.08M.08'],
  vp9: ['vp09.00.10.08'],
};

/** Codes WebCodecs sondés par capacité audio (AC-3 et E-AC-3 : ceux de WebCodecs, puis le repli). */
const AUDIO_PROBES: Partial<Record<DecodeCap, readonly string[]>> = {
  aac: ['mp4a.40.2'],
  opus: ['opus'],
  flac: ['flac'],
  dts: ['dtsc', 'dtse', 'dtsh', 'dtsl', 'dtsx'],
  ac3: ['ac-3'],
  eac3: ['ec-3'],
};

/**
 * Repli AC-3 / E-AC-3 : décodeur wasm de @mediabunny/ac3, chargé à la demande. Sa présence se réduit à celle de WebAssembly
 * (le module n'est pas téléchargé pour cette sonde).
 */
export const ac3FallbackAvailable = (): boolean => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

async function probeCap(cap: DecodeCap, env: CodecEnv, ac3Fallback: () => boolean): Promise<boolean> {
  const video = VIDEO_PROBES[cap];
  if (video) {
    const decoder = env.VideoDecoder;
    if (!decoder) return false;
    for (const codec of video) {
      if (await isSupported(() => decoder.isConfigSupported({ codec }))) return true;
    }
    return false;
  }
  const decoder = env.AudioDecoder;
  if (decoder) {
    for (const codec of AUDIO_PROBES[cap] ?? []) {
      if (await isSupported(() => decoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 }))) return true;
    }
  }
  return (cap === 'ac3' || cap === 'eac3') && ac3Fallback();
}

/**
 * Capacités de décodage de ce navigateur, dans l'ordre de DECODE_CAPS. Ne sonde que des codecs génériques (jamais un
 * fichier, ni une URL) : le résultat ne contient aucune donnée personnelle.
 */
export async function detectDecodeCaps(env: CodecEnv = defaultCodecEnv(), ac3Fallback: () => boolean = ac3FallbackAvailable): Promise<DecodeCap[]> {
  const out: DecodeCap[] = [];
  for (const cap of DECODE_CAPS) {
    if (await probeCap(cap, env, ac3Fallback)) out.push(cap);
  }
  return out;
}
