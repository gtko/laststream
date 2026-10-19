import type { FileCodecs, SourceLike } from '../../party/compat';
import type { MediaCaps } from '../server';
import type { WebAudioFallback, VideoLike } from './engine';
import { nativeAudioSilent, pickReadableAlternative, type AudioPlan } from './policy';
import { prepareWebAudio, type PrepareDeps, type PreparedAudio } from './prepare';

/* Pilote le son de repli pour une lecture web directe : prépare le plan (CORS, codec), attache le moteur audio au moteur HTML,
 * affiche les notes (DTS, CORS) et propose une source au son lisible. Tout l'accès à l'interface passe par `WebAudioHost`
 * (injecté : testé sans DOM). */

export type AudioMode = 'app' | 'unsupported' | 'cors' | null;

export interface WebAudioHost<V extends SourceLike = SourceLike> {
  video: VideoLike & { webkitAudioDecodedByteCount?: number };
  caps: Pick<MediaCaps, 'audioCodecs' | 'videoCodecs'>;
  /** Le moteur de repli prend le relais du son (volume, muet, attente du son). */
  attach(engine: WebAudioFallback): void;
  /** L'état du lecteur change (attente du son…) : l'interface se rafraîchit. */
  onChange(): void;
  toast(message: string, ms?: number, action?: { label: string; run: () => void }): void;
  /** Sources classées du titre (sans torrent), et indice de celle en cours. */
  alternatives(): readonly V[];
  currentIndex(): number | null;
  /** Codecs lus dans l'en-tête d'une autre source (plages), ou null. */
  probeView(view: V, signal: AbortSignal): Promise<FileCodecs | null>;
  describe(view: V): string;
  play(view: V): void;
  setMode(mode: AudioMode, note: string): void;
}

export interface WebAudioInput {
  url: string;
  nameCodec: string | null;
  stale: () => boolean;
}

export interface WebAudioHandle {
  readonly plan: AudioPlan;
  dispose(): void;
}

/** Délai de lecture réelle avant de conclure que le navigateur est muet, et période de vérification (ms). */
export const SILENCE_AFTER_S = 2.5;
const WATCH_MS = 1000;

export async function startWebAudio<V extends SourceLike>(host: WebAudioHost<V>, input: WebAudioInput, deps: PrepareDeps = {}): Promise<WebAudioHandle> {
  let current: AudioPlan = { mode: 'none' };
  let prep: PreparedAudio | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const stale = (): boolean => disposed || input.stale();
  const dispose = (): void => {
    disposed = true;
    if (watch) clearInterval(watch);
    watch = null;
    prep?.dispose();
    prep = null;
  };
  const handle: WebAudioHandle = { get plan() { return current; }, dispose };

  const propose = async (note: string): Promise<void> => {
    const alt = await pickReadableAlternative(host.alternatives(), host.currentIndex(), host.caps, { probe: host.probeView }).catch(() => null);
    if (stale() || !alt) return;
    host.toast(note + ' · Source avec un son lisible : ' + host.describe(alt.view), 20_000, { label: 'Essayer', run: () => host.play(alt.view) });
  };

  const apply = (plan: AudioPlan, engine: WebAudioFallback | null): void => {
    current = plan;
    if (plan.mode === 'app' && engine) {
      host.attach(engine);
      engine.start();
      host.setMode('app', '');
      host.toast('Son décodé par l’app', 3500);
    } else if (plan.mode === 'unsupported' || plan.mode === 'cors') {
      host.setMode(plan.mode, plan.note);
      host.toast(plan.note, 9000);
      void propose(plan.note);
    } else {
      host.setMode(null, '');
    }
  };

  const created = await prepareWebAudio({
    video: host.video, url: input.url, caps: host.caps, web: true, hls: false, nameCodec: input.nameCodec,
    engineOptions: {
      onChange: () => host.onChange(),
      onError: () => host.toast('Le son s’est interrompu (la source refuse les requêtes par plages)', 8000),
    },
  }, deps);
  if (stale()) { created.dispose(); return handle; }
  prep = created;
  apply(created.plan, created.engine);

  if (created.plan.mode === 'native') {
    // Le navigateur annonce pouvoir lire la piste : on vérifie qu'il décode vraiment des octets (Chromium). Muet malgré tout :
    // on reprend la décision en le tenant pour incapable.
    let playedFrom: number | null = null;
    watch = setInterval(() => {
      const v = host.video;
      if (stale()) return;
      if (v.paused || v.ended || v.seeking || v.muted || v.volume === 0) { playedFrom = null; return; }
      playedFrom ??= v.currentTime;
      if (!nativeAudioSilent(v.webkitAudioDecodedByteCount, v.currentTime - playedFrom, SILENCE_AFTER_S)) return;
      clearInterval(watch as ReturnType<typeof setInterval>);
      watch = null;
      void prep?.escalate().then((r) => { if (!stale()) apply(r.plan, r.engine); }).catch(() => undefined);
    }, WATCH_MS);
  }
  return handle;
}
