import type { VideoCodec } from './codec';

export interface VideoInfo {
  container: 'mp4' | 'mkv';
  codec: VideoCodec;
  /** Chaîne WebCodecs (avc1.64001F, hvc1.1.6.L93.B0, av01.0.08M.08…). */
  codecString: string;
  /** Extradata du décodeur : avcC, hvcC ou av1C (échantillons au format du conteneur, longueurs préfixées). */
  description: Uint8Array;
  width: number;
  height: number;
  /** Durée en secondes (0 si inconnue). */
  duration: number;
}

export interface KeyframeRef {
  /** Position de l'échantillon (MP4) ou de son bloc (MKV) dans le fichier. */
  offset: number;
  /** Taille de l'échantillon ; null tant qu'elle n'est pas lue (MKV : elle est dans l'en-tête du bloc). */
  size: number | null;
  /** Instant de présentation, en secondes. */
  timestamp: number;
}

export interface VideoIndex {
  info: VideoInfo;
  /** Image clé la plus proche de `time` (secondes), ou null s'il n'y en a pas. */
  keyframeAt(time: number, signal?: AbortSignal): Promise<KeyframeRef | null>;
  /** Octets de l'échantillon clé (format du conteneur : H.264/HEVC préfixés par leur longueur). */
  readSample(ref: KeyframeRef, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Nombre d'images clés connues d'avance (0 : recherche à la demande, sans Cues). */
  readonly keyframeCount: number;
}
