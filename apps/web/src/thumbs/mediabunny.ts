/* Repli de démultiplexage (mediabunny) pour les conteneurs que les parseurs maison ne lisent pas : MP4 fragmenté, WebM, QuickTime…
 * Même contrat que mp4.ts et mkv.ts (VideoIndex). Les octets passent par ByteSource : plages ≤ 4 Mo, comptées, annulables.
 * Pas d'index d'images clés à l'ouverture (keyframeCount = 0) : chaque demande interroge le démultiplexeur à l'instant voulu. */

import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny';
import { ByteSource, type ByteSourceOptions, type FetchRange } from './bytes';
import { codecStringFor, type VideoCodec } from './codec';
import type { KeyframeRef, VideoIndex, VideoInfo } from './types';

/** Codecs de mediabunny pris en charge (les autres : pas de miniatures). */
const CODECS: Record<string, VideoCodec> = { avc: 'h264', hevc: 'hevc', av1: 'av1' };
/** Types MIME ramenés aux deux conteneurs de VideoInfo (WebM est du Matroska pour le décodeur). */
const CONTAINERS: Record<string, VideoInfo['container']> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mp4',
  'video/x-matroska': 'mkv',
  'video/webm': 'mkv',
};
/** Recherche sans charger les octets : l'instant et la taille suffisent jusqu'à readSample. */
const META = { metadataOnly: true } as const;

const toBytes = (data: AllowSharedBufferSource): Uint8Array =>
  ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

/** Image clé la plus proche de `time` ; égalité : la plus ancienne. */
function nearestOf(before: EncodedPacket | null, after: EncodedPacket | null, time: number): EncodedPacket | null {
  if (before === null || after === null) return before ?? after;
  return time - before.timestamp <= after.timestamp - time ? before : after;
}

async function durationOf(input: Input): Promise<number> {
  try {
    const d = await input.computeDuration();
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/**
 * Ouvre le fichier déjà entamé par `source` (en-tête lu, taille connue). Rejette si le conteneur, la piste primaire
 * ou le codec ne sont pas gérés, ou si la taille est inconnue (mediabunny ne peut pas lire sans elle).
 */
export async function openMediabunnySource(source: ByteSource, signal?: AbortSignal): Promise<VideoIndex> {
  const size = source.size;
  if (size === null) throw new Error('mediabunny_size_unknown');
  const input = new Input({
    source: new CustomSource({
      getSize: () => size,
      // mediabunny demande [start, end) (end exclu) ; ByteSource prend une longueur et découpe en plages ≤ 4 Mo.
      read: async (start, end) => {
        signal?.throwIfAborted();
        return source.read(start, end - start, signal);
      },
      prefetchProfile: 'network',
    }),
    formats: ALL_FORMATS,
  });
  try {
    const format = await input.getFormat();
    const container = CONTAINERS[format.mimeType];
    if (container === undefined) throw new Error('mediabunny_container');
    const track = await input.getPrimaryVideoTrack();
    if (track === null) throw new Error('mediabunny_no_video');
    const codec = CODECS[track.codec ?? ''];
    if (codec === undefined) throw new Error('mediabunny_codec');
    const cfg = await track.getDecoderConfig();
    if (cfg === null) throw new Error('mediabunny_no_config');
    const description = cfg.description === undefined ? new Uint8Array(0) : toBytes(cfg.description);
    const codecString = codecStringFor(codec, description, cfg.codec.startsWith('hev1') ? 'hev1' : 'hvc1') ?? cfg.codec;
    const info: VideoInfo = {
      container, codec, codecString, description,
      width: track.codedWidth, height: track.codedHeight,
      duration: await durationOf(input),
    };
    const sink = new EncodedPacketSink(track);

    return {
      info,
      keyframeCount: 0,
      keyframeAt: async (time, s): Promise<KeyframeRef | null> => {
        s?.throwIfAborted();
        const before = await sink.getKeyPacket(time, META);
        s?.throwIfAborted();
        const after = before === null ? await sink.getFirstKeyPacket(META) : await sink.getNextKeyPacket(before, META);
        const pick = nearestOf(before, after, time);
        // mediabunny ne donne pas la position de l'échantillon dans le fichier : offset -1 = inconnu.
        return pick === null ? null : { offset: -1, size: pick.byteLength > 0 ? pick.byteLength : null, timestamp: pick.timestamp };
      },
      readSample: async (ref, s): Promise<Uint8Array | null> => {
        s?.throwIfAborted();
        const packet = await sink.getKeyPacket(ref.timestamp);
        s?.throwIfAborted();
        if (packet === null || packet.timestamp !== ref.timestamp || packet.data.length === 0) return null;
        if (ref.size !== null && packet.data.length !== ref.size) return null;
        return packet.data;
      },
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

/** Ouvre le fichier par plages d'octets avec mediabunny. Rejette si rien n'en est lisible. */
export async function openMediabunnyIndex(fetchRange: FetchRange, options: ByteSourceOptions = {}, signal?: AbortSignal): Promise<VideoIndex> {
  const source = new ByteSource(fetchRange, options);
  await source.open(signal);
  return openMediabunnySource(source, signal);
}
