/* Miniatures de la barre de progression sans ffmpeg : démultiplexage MP4/MKV par plages d'octets (repli mediabunny) + décodage WebCodecs.
 * Point d'entrée : openVideoIndex (index des images clés), decodeKeyframe (échantillon → WebP), makeLocalFeed (pont vers ThumbFeed). */

import { ByteSource, type ByteSourceOptions, type FetchRange } from './bytes';
import { openMkv } from './mkv';
import { openMp4 } from './mp4';
import { RangeAuthError } from './direct';
import type { VideoIndex } from './types';

export * from './bytes';
export * from './codec';
export * from './decode';
export * from './feed';
export * from './direct';
export * from './store';
export * from './types';
export { openMkv, readId, readSize } from './mkv';
export { openMp4 } from './mp4';

/** Démultiplexage maison : MKV si l'en-tête EBML est là, sinon MP4. null si le conteneur ou le codec n'est pas reconnu. */
async function openNative(source: ByteSource, signal?: AbortSignal): Promise<VideoIndex | null> {
  const head = await source.read(0, 12, signal);
  if (head.length < 8) return null;
  const mkv = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  return mkv ? openMkv(source, signal) : openMp4(source, signal);
}

/**
 * Ouvre le fichier (MKV ou MP4 reconnu à ses premiers octets) ; null si le format ou le codec n'est pas pris en charge.
 * Repli : si le démuxeur maison échoue ou ne reconnaît pas le conteneur, mediabunny est essayé (module chargé à ce moment seulement).
 * Si les deux échouent : l'erreur du démuxeur maison est relancée quand il y en a une, sinon null (comportement existant).
 * L'annulation et le refus de la source (RangeAuthError) sont toujours relancés, pour que l'appelant réenregistre la source.
 */
export async function openVideoIndex(fetchRange: FetchRange, options: ByteSourceOptions = {}, signal?: AbortSignal): Promise<{ index: VideoIndex; source: ByteSource } | null> {
  const source = new ByteSource(fetchRange, options);
  await source.open(signal);
  let nativeFailed = false;
  let nativeError: unknown;
  try {
    const index = await openNative(source, signal);
    if (index !== null) return { index, source };
  } catch (error) {
    if (signal?.aborted || error instanceof RangeAuthError) throw error;
    nativeFailed = true;
    nativeError = error;
  }
  try {
    const { openMediabunnySource } = await import('./mediabunny');
    return { index: await openMediabunnySource(source, signal), source };
  } catch (error) {
    if (signal?.aborted || error instanceof RangeAuthError) throw error;
    if (nativeFailed) throw nativeError;
    return null;
  }
}
