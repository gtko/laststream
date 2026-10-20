import { isAc3Codec, loadAc3Decoder, type Ac3Loader } from './ac3';
import { checkSupport, type CodecEnv, type TrackSet } from './detect';
import type { PlaybackPlan, SupportResult } from './types';

export type { TrackSet } from './detect';

interface FallbackContext {
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

/** Note affichée quand la vidéo se lit sans son (son refusé par le navigateur, aucun repli audio). */
export const AUDIO_UNSUPPORTED_NOTE = 'Son non pris en charge par ce navigateur';

export function unsupportedMessage(codec: string): string {
  const detail = codec ? ` (codec ${codec})` : '';
  return `Format non pris en charge dans ce navigateur${detail}.`;
}

/**
 * Choisit la manière de lire le fichier : décodage natif si WebCodecs suffit, sinon le premier repli
 * enregistré qui accepte, puis le décodeur AC-3 / E-AC-3 chargé à la demande. Si seul le son est refusé, la vidéo se lit sans son, avec une note. Sinon,
 * un résultat `unsupported` avec un message clair.
 */
export async function resolvePlayback(
  tracks: TrackSet,
  env?: CodecEnv,
  loadAc3: Ac3Loader = loadAc3Decoder,
): Promise<PlaybackPlan> {
  const support = await checkSupport(tracks, env);
  if (support.ok) return { kind: 'native' };
  for (const handler of [...handlers]) {
    const plan = await handler({ tracks, support });
    if (plan) return plan;
  }
  const rest = tracks.audio ? await checkSupport({ video: tracks.video, audio: null }, env) : null;
  // Son AC-3 / E-AC-3 refusé par AudioDecoder : décodeur wasm de mediabunny, chargé à la demande.
  // (Piste audio seule : checkSupport sans piste échoue, on ne tente que si la vidéo est décodable ou absente.)
  if (tracks.audio && isAc3Codec(tracks.audio.codec) && (tracks.video ? rest?.ok : true)) {
    try {
      await loadAc3();
      return { kind: 'native', audioDecoder: 'ac3' };
    } catch {
      // Chargement impossible (réseau, wasm) : on retombe sur la vidéo seule ci-dessous.
    }
  }
  if (tracks.video && tracks.audio && rest?.ok) {
    return { kind: 'native', withoutAudio: true, note: AUDIO_UNSUPPORTED_NOTE };
  }
  return { kind: 'unsupported', message: unsupportedMessage(support.codec) };
}
