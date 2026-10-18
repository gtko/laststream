/* Miniatures de la barre de progression sans ffmpeg : démultiplexage MP4/MKV par plages d'octets + décodage WebCodecs.
 * Point d'entrée : openVideoIndex (index des images clés), decodeKeyframe (échantillon → WebP), makeLocalFeed (pont vers ThumbFeed). */

import { ByteSource, type ByteSourceOptions, type FetchRange } from './bytes';
import { openMkv } from './mkv';
import { openMp4 } from './mp4';
import type { VideoIndex } from './types';

export * from './bytes';
export * from './codec';
export * from './decode';
export * from './feed';
export * from './proxy';
export * from './store';
export * from './types';
export { openMkv, readId, readSize } from './mkv';
export { openMp4 } from './mp4';

/** Ouvre le fichier (MKV ou MP4 reconnu à ses premiers octets) ; null si le format ou le codec n'est pas pris en charge. */
export async function openVideoIndex(fetchRange: FetchRange, options: ByteSourceOptions = {}, signal?: AbortSignal): Promise<{ index: VideoIndex; source: ByteSource } | null> {
  const source = new ByteSource(fetchRange, options);
  await source.open(signal);
  const head = await source.read(0, 12, signal);
  if (head.length < 8) return null;
  const mkv = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const index = mkv ? await openMkv(source, signal) : await openMp4(source, signal);
  return index === null ? null : { index, source };
}
