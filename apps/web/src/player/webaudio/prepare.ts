import { urlRangeSource } from '../../relay/sources';
import { rememberRange } from '../../sources/hostRange';
import type { RangeReader } from '../../relay/player/types';
import type { MediaCaps } from '../server';
import { WebAudioFallback, type FallbackOptions, type VideoLike } from './engine';
import { NOTE_STALLED, chooseAudioPlan, chooseAudioPlanBlind, probeRange, type AudioPlan, type RangeProbe } from './policy';
import { inspectAudio, type InspectedAudio } from './source';

/* Préparation du son en lecture web directe : sonde Range (CORS), lecture de l'en-tête (codec de la piste son), choix du plan
 * (`chooseAudioPlan`) et, si l'app doit décoder, création du moteur de repli. Dépendances injectables pour les tests. */

export interface PrepareInput {
  video: VideoLike;
  /** Lien HTTP(S) lu par le `<video>` ; ne sort jamais de ce module (ni journal, ni message). */
  url: string;
  caps: Pick<MediaCaps, 'audioCodecs'>;
  /** Navigateur seul (ni coque Windows ni Android). */
  web: boolean;
  /** Lecture HLS via le serveur de streaming : son déjà converti. */
  hls: boolean;
  /** Codec audio deviné d'après le nom de la source (`dts`, `eac3`, `aac`…), pour le cas où l'en-tête est illisible. */
  nameCodec: string | null;
  signal?: AbortSignal;
  engineOptions?: FallbackOptions;
}

/** Délai maximal pour lire l'en-tête (codec de la piste son) : au-delà, la source est jugée trop lente. */
export const HEADER_TIMEOUT_MS = 10_000;

export interface PrepareDeps {
  headerTimeoutMs?: number;
  probeRange?: (url: string, signal?: AbortSignal) => Promise<RangeProbe>;
  reader?: (url: string) => RangeReader;
  inspect?: (reader: RangeReader) => Promise<InspectedAudio>;
  createEngine?: (video: VideoLike, audio: InspectedAudio, opts?: FallbackOptions) => WebAudioFallback;
}

export interface PreparedAudio {
  plan: AudioPlan;
  /** Codec lu dans l'en-tête (`ac3`, `eac3`, `aac`…), ou null. */
  codec: string | null;
  /** Moteur prêt à démarrer (`start()`), seulement pour le plan `app`. */
  engine: WebAudioFallback | null;
  /** Sonde de plage : sert aux messages (CORS refusé ou plage ignorée). */
  range: RangeProbe | null;
  /**
   * Le navigateur est resté muet alors qu'il annonçait pouvoir lire la piste : on reprend la décision en le tenant pour
   * incapable (repli sur l'app, DTS, ou CORS selon le cas).
   */
  escalate(): Promise<{ plan: AudioPlan; engine: WebAudioFallback | null }>;
  dispose(): void;
}

const defaultEngine = (video: VideoLike, audio: InspectedAudio, opts?: FallbackOptions): WebAudioFallback =>
  new WebAudioFallback(video, audio.createSource(), audio.info?.sampleRate || 48000, opts);

export async function prepareWebAudio(input: PrepareInput, deps: PrepareDeps = {}): Promise<PreparedAudio> {
  const none = (plan: AudioPlan, range: RangeProbe | null = null): PreparedAudio => ({ plan, codec: null, engine: null, range, escalate: async () => ({ plan, engine: null }), dispose: () => undefined });
  if (!input.web || input.hls || !/^https?:\/\//i.test(input.url)) return none({ mode: 'none' });

  const probe = deps.probeRange ?? ((u, s) => probeRange(u, undefined, undefined, s));
  const range = await probe(input.url, input.signal);
  if (input.signal?.aborted) return none({ mode: 'none' }, range);
  rememberRange(input.url, range === 'ok');

  const blind = (): AudioPlan => {
    // En-tête illisible : seul le nom dit si le son est lisible. Inconnu ou lisible : on laisse le navigateur faire (le
    // compteur d'octets décodés tranchera plus tard, voir `escalate`).
    const n = input.nameCodec;
    if (n && !input.caps.audioCodecs.includes(n)) return chooseAudioPlanBlind(n);
    return { mode: 'native' };
  };
  const blindForced = (): AudioPlan => chooseAudioPlanBlind(input.nameCodec);

  if (range !== 'ok') {
    return { plan: blind(), codec: null, engine: null, range, escalate: async () => ({ plan: blindForced(), engine: null }), dispose: () => undefined };
  }

  let inspected: InspectedAudio;
  try {
    const reader = (deps.reader ?? ((u: string) => urlRangeSource({ url: u })))(input.url);
    const pending = (deps.inspect ?? ((r: RangeReader) => inspectAudio(r)))(reader);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deps.headerTimeoutMs ?? HEADER_TIMEOUT_MS); });
    const first = await Promise.race([pending, late]).finally(() => clearTimeout(timer));
    if (first === 'late') {
      // Trop lent : on libère l'ouverture quand elle finira, et on prévient plutôt que d'attendre sans fin.
      void pending.then((i) => i.close(), () => undefined);
      return none({ mode: 'stalled', note: NOTE_STALLED }, range);
    }
    inspected = first;
  } catch {
    // En-tête illisible malgré la sonde (fichier tronqué, conteneur inconnu) : le navigateur garde la main.
    return none({ mode: 'native' }, range);
  }
  if (input.signal?.aborted) { inspected.close(); return none({ mode: 'none' }, range); }

  const codec = inspected.info?.codec ?? null;
  const decide = (nativeSilent: boolean): AudioPlan => chooseAudioPlan({
    web: input.web, hls: input.hls, url: input.url, codec, container: inspected.info?.container ?? '', caps: input.caps,
    appCanDecode: inspected.canDecode, range, nativeSilent,
  });
  let engine: WebAudioFallback | null = null;
  const build = (): WebAudioFallback => {
    engine ??= (deps.createEngine ?? defaultEngine)(input.video, inspected, input.engineOptions);
    return engine;
  };
  const plan = decide(false);
  if (plan.mode === 'app') build();
  else if (plan.mode !== 'native') inspected.close();
  return {
    plan, codec, engine, range,
    async escalate() {
      const p = decide(true);
      if (p.mode === 'app') return { plan: p, engine: build() };
      return { plan: p, engine: null };
    },
    dispose() {
      if (engine) engine.destroy();
      else inspected.close();
    },
  };
}
