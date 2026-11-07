import { ALL_FORMATS, AudioSampleSink, CustomSource, Input, type InputAudioTrack } from 'mediabunny';
import { isAc3Codec, loadAc3Decoder, type Ac3Loader } from '../../relay/player/ac3';
import type { RangeReader } from '../../relay/player/types';
import { PREFETCH_TARGET_S } from './timing';
import { PrefetchReader, type PrefetchStats } from './reader';

/* Piste audio d'un fichier distant lue par plages (mediabunny) et décodée : AudioDecoder natif, ou @mediabunny/ac3 pour
 * AC-3 / E-AC-3. Rend des segments PCM horodatés (AudioBuffer) prêts pour WebAudio. */

export interface PcmChunk {
  /** Début du segment dans le média (s). */
  timestamp: number;
  duration: number;
  buffer: AudioBuffer;
  /** Taille mémoire approximative (octets), pour borner le tampon. */
  bytes: number;
}

export interface AudioSource {
  /** Segments PCM à partir de `startSec` (le premier peut commencer un peu avant). La boucle s'arrête avec `return()`. */
  chunks(startSec: number): AsyncGenerator<PcmChunk, void, unknown>;
  prefetchStats(): PrefetchStats;
  /** Octets par seconde de média (taille / durée), ou 0 si inconnu. */
  bytesPerSecond: number;
  close(): void;
}

export interface InspectedAudio {
  /** Null : aucune piste audio. */
  info: { codec: string; container: string; sampleRate: number; channels: number; duration: number } | null;
  /** L'app sait décoder la piste (décodeur AC-3 chargé si besoin). */
  canDecode: boolean;
  /** Source de segments PCM (mêmes plages, même cache). */
  createSource(): AudioSource;
  close(): void;
}

export interface InspectOptions {
  loadAc3?: Ac3Loader;
  prefetch?: { maxBytes?: number; blockSize?: number };
}

/** Ouvre le fichier (en-tête seulement) et décrit sa piste audio principale. */
export async function inspectAudio(reader: RangeReader, opts: InspectOptions = {}): Promise<InspectedAudio> {
  const cache = new PrefetchReader(reader, { aheadBytes: 0, ...opts.prefetch });
  const input = new Input({ source: new CustomSource({ getSize: () => cache.size(), read: (s, e) => cache.read(s, e), prefetchProfile: 'network' }), formats: ALL_FORMATS });
  const close = (): void => { input.dispose(); cache.close(); };
  try {
    const format = await input.getFormat();
    const track: InputAudioTrack | null = await input.getPrimaryAudioTrack();
    if (!track) return { info: null, canDecode: false, createSource: () => { throw new Error('aucune piste audio'); }, close };
    const codec = track.codec ?? '';
    if (isAc3Codec(codec)) {
      try { await (opts.loadAc3 ?? loadAc3Decoder)(); } catch { /* décodeur indisponible : canDecode dira non */ }
    }
    const canDecode = await track.canDecode().catch(() => false);
    let duration = 0;
    try { duration = await input.computeDuration(); } catch { duration = 0; }
    const size = await cache.size();
    const bytesPerSecond = duration > 0 ? size / duration : 0;
    return {
      info: { codec, container: format.name, sampleRate: track.sampleRate, channels: track.numberOfChannels, duration },
      canDecode,
      close,
      createSource: () => {
        // 30 s de fichier d'avance (entrelacé avec la vidéo), dans la limite de la mémoire du cache.
        cache.setAheadBytes(bytesPerSecond > 0 ? bytesPerSecond * PREFETCH_TARGET_S : 24 * 1024 * 1024);
        const sink = new AudioSampleSink(track);
        return {
          bytesPerSecond,
          prefetchStats: () => cache.stats(),
          close,
          async *chunks(startSec: number) {
            const it = sink.samples(Math.max(0, startSec));
            try {
              for (;;) {
                const next = await it.next();
                if (next.done) return;
                const s = next.value;
                try {
                  const buffer = s.toAudioBuffer();
                  yield { timestamp: s.timestamp, duration: s.duration, buffer, bytes: s.numberOfFrames * s.numberOfChannels * 4 };
                } finally {
                  s.close();
                }
              }
            } finally {
              void it.return(undefined).catch(() => undefined);
            }
          },
        };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
