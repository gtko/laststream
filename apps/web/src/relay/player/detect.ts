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
