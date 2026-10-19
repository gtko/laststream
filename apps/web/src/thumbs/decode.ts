/* Décodage d'une image clé avec WebCodecs puis réduction en WebP (JPEG si le navigateur ne sait pas encoder en WebP).
 * Les globales sont injectables : les tests simulent WebCodecs. Toute impossibilité renvoie false/null, sans exception. */

import type { VideoInfo } from './types';

export const THUMB_WIDTH = 160;
export const THUMB_QUALITY = 0.6;
const DECODE_TIMEOUT_MS = 8000;

/* Les types WebCodecs de TypeScript varient selon la version : on décrit uniquement ce qui sert. */
interface FrameLike { displayWidth: number; displayHeight: number; close(): void }
interface DecoderLike {
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
interface CanvasLike {
  getContext(type: '2d'): { drawImage(image: unknown, x: number, y: number, w: number, h: number): void } | null;
  convertToBlob(options: { type: string; quality: number }): Promise<Blob>;
}

export interface CodecEnv {
  VideoDecoder?: {
    new (init: { output: (frame: FrameLike) => void; error: (e: unknown) => void }): DecoderLike;
    isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
  };
  EncodedVideoChunk?: new (init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) => unknown;
  OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
}

const globalEnv = (): CodecEnv => globalThis as unknown as CodecEnv;

/** WebCodecs + OffscreenCanvas disponibles (WebView2, WebView Chromium Android, Chrome/Edge) ? */
export function webCodecsAvailable(env: CodecEnv = globalEnv()): boolean {
  return typeof env.VideoDecoder === 'function' && typeof env.EncodedVideoChunk === 'function' && typeof env.OffscreenCanvas === 'function';
}

const configOf = (info: VideoInfo): Record<string, unknown> => ({
  codec: info.codecString,
  description: info.description,
  codedWidth: info.width || undefined,
  codedHeight: info.height || undefined,
  optimizeForLatency: true,
});

/** Ce codec/profil/niveau est-il décodable ici ? Sinon pas de miniature (silencieux). */
export async function canDecode(info: VideoInfo, env: CodecEnv = globalEnv()): Promise<boolean> {
  if (!webCodecsAvailable(env)) return false;
  try {
    const r = await env.VideoDecoder!.isConfigSupported(configOf(info));
    return r.supported === true;
  } catch {
    return false;
  }
}

/** Décode un échantillon clé et le réduit à `width` pixels de large. null au moindre échec. */
export async function decodeKeyframe(
  sample: Uint8Array,
  info: VideoInfo,
  options: { width?: number; quality?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  env: CodecEnv = globalEnv(),
): Promise<Blob | null> {
  if (!webCodecsAvailable(env) || options.signal?.aborted) return null;
  const width = options.width ?? THUMB_WIDTH;
  const quality = options.quality ?? THUMB_QUALITY;
  let decoder: DecoderLike | null = null;
  let frame: FrameLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decoded = new Promise<FrameLike>((resolve, reject) => {
      decoder = new env.VideoDecoder!({
        output: (f) => { if (frame === null) { frame = f; resolve(f); } else f.close(); },
        error: (e) => reject(e instanceof Error ? e : new Error('decoder_error')),
      });
      timer = setTimeout(() => reject(new Error('decode_timeout')), options.timeoutMs ?? DECODE_TIMEOUT_MS);
      decoder.configure(configOf(info));
      decoder.decode(new env.EncodedVideoChunk!({ type: 'key', timestamp: 0, data: sample }));
      // flush() fait sortir l'image même avec des B-frames en attente ; son rejet est repris par `error`.
      decoder.flush().catch(reject);
    });
    const f = await decoded;
    if (options.signal?.aborted) return null;
    const ratio = f.displayHeight > 0 && f.displayWidth > 0 ? f.displayHeight / f.displayWidth : info.height / (info.width || 1) || 9 / 16;
    const height = Math.max(2, Math.round((width * ratio) / 2) * 2);
    const canvas = new env.OffscreenCanvas!(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(f, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (webp.type === 'image/webp') return webp;
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { (frame as FrameLike | null)?.close(); } catch { /* déjà fermée */ }
    try { (decoder as DecoderLike | null)?.close(); } catch { /* déjà fermé */ }
  }
}
