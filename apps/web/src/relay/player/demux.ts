import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input } from 'mediabunny';
import type { AudioTrackInfo, MediaInfo, RangeReader, VideoTrackInfo } from './types';

export interface OpenedMedia {
  info: MediaInfo;
  videoSink: EncodedPacketSink | null;
  audioSink: EncodedPacketSink | null;
  /** Configuration WebCodecs prête à l'emploi (null si mediabunny ne sait pas la produire). */
  videoConfig: VideoDecoderConfig | null;
  audioConfig: AudioDecoderConfig | null;
  close(): void;
}

function toBytes(data: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!data) return undefined;
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

/**
 * Ouvre un MP4 ou un MKV/WebM à partir d'un RangeReader. Les octets ne sont lus qu'à la demande
 * (mediabunny appelle `read` pour les seules plages dont il a besoin, pas de téléchargement complet).
 */
export async function openMedia(reader: RangeReader): Promise<OpenedMedia> {
  const source = new CustomSource({
    getSize: () => reader.size(),
    read: (start, end) => reader.read(start, end),
    prefetchProfile: 'network',
  });
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const format = await input.getFormat();

    let video: VideoTrackInfo | null = null;
    let videoSink: EncodedPacketSink | null = null;
    let videoConfig: VideoDecoderConfig | null = null;
    const vt = await input.getPrimaryVideoTrack();
    if (vt) {
      const cfg = await vt.getDecoderConfig();
      const codecString = cfg?.codec ?? (await vt.getCodecParameterString()) ?? '';
      video = {
        codec: vt.codec ?? '',
        codecString,
        description: toBytes(cfg?.description),
        width: vt.codedWidth,
        height: vt.codedHeight,
      };
      if (cfg) {
        videoConfig = cfg;
        videoSink = new EncodedPacketSink(vt);
      }
    }

    let audio: AudioTrackInfo | null = null;
    let audioSink: EncodedPacketSink | null = null;
    let audioConfig: AudioDecoderConfig | null = null;
    const at = await input.getPrimaryAudioTrack();
    if (at) {
      const cfg = await at.getDecoderConfig();
      audio = {
        codec: at.codec ?? '',
        codecString: cfg?.codec ?? (await at.getCodecParameterString()) ?? '',
        sampleRate: cfg?.sampleRate ?? at.sampleRate,
        numberOfChannels: cfg?.numberOfChannels ?? at.numberOfChannels,
        description: toBytes(cfg?.description),
      };
      if (cfg) {
        audioConfig = cfg;
        audioSink = new EncodedPacketSink(at);
      }
    }

    let duration = 0;
    try {
      duration = await input.computeDuration();
    } catch {
      duration = 0;
    }

    return {
      info: { container: format.name, duration, video, audio },
      videoSink,
      audioSink,
      videoConfig,
      audioConfig,
      close: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
