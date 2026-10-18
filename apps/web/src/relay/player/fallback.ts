import { checkSupport, type CodecEnv, type TrackSet } from './detect';
import type { PlaybackPlan, SupportResult } from './types';

export type { TrackSet } from './detect';

export interface FallbackContext {
  tracks: TrackSet;
  support: Extract<SupportResult, { ok: false }>;
}

/**
 * Repli quand WebCodecs ne décode pas le fichier. Renvoie un plan de lecture, ou `null` pour laisser
 * le suivant (puis le message « non pris en charge ») prendre la main.
 */
export type FallbackHandler = (ctx: FallbackContext) => PlaybackPlan | null | Promise<PlaybackPlan | null>;

/** Point d'extension pour un moteur de repli (libvlc-wasm plus tard). Vide dans cette version. */
const handlers: FallbackHandler[] = [];

/** Enregistre un repli. Renvoie la fonction qui le retire. */
export function registerFallback(handler: FallbackHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function unsupportedMessage(codec: string): string {
  const detail = codec ? ` (codec ${codec})` : '';
  return `Format non pris en charge dans ce navigateur${detail}. Le repli vlc.js n'est pas disponible dans cette version.`;
}

/**
 * Choisit la manière de lire le fichier : décodage natif si WebCodecs suffit, sinon le premier repli
 * enregistré qui accepte, sinon un résultat `unsupported` avec un message clair.
 */
export async function resolvePlayback(tracks: TrackSet, env?: CodecEnv): Promise<PlaybackPlan> {
  const support = await checkSupport(tracks, env);
  if (support.ok) return { kind: 'native' };
  for (const handler of [...handlers]) {
    const plan = await handler({ tracks, support });
    if (plan) return plan;
  }
  return { kind: 'unsupported', message: unsupportedMessage(support.codec) };
}
