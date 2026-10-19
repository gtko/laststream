// Page de test du son de repli web : le vrai HtmlEngine + le vrai contrôleur, sans le reste de l'app.
// Expose window.__w pour que web-audio.mjs la pilote avec Playwright (headless uniquement).
import { HtmlEngine } from '../../../src/player/engines.js';
import { browserCaps } from '../../../src/player/caps';
import { startWebAudio, type WebAudioHandle } from '../../../src/player/webaudio/controller';
import type { WebAudioFallback } from '../../../src/player/webaudio/engine';

type Alt = { index: number; filename: string; playable: boolean; stream: { url: string } };
const video = document.getElementById('v') as HTMLVideoElement;
const html = new HtmlEngine(video) as HtmlEngine & { audio: WebAudioFallback | null; load(o: { url: string; startAt: number }): Promise<void> };
const toasts: Array<{ message: string; action?: string }> = [];
const state: { handle: WebAudioHandle | null; mode: string | null; played: string[]; actions: Array<() => void> } = { handle: null, mode: null, played: [], actions: [] };

// Prise de son : un analyseur est branché en parallèle sur tout ce qui va vers la sortie.
const w = window as unknown as Record<string, unknown> & { __tap: { analyser: AnalyserNode | null; ctx: AudioContext | null } };

function rms(): number {
  const an = w.__tap.analyser;
  if (!an) return 0;
  const b = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(b);
  let s = 0;
  for (const x of b) s += x * x;
  return Math.sqrt(s / b.length);
}

/** Relevé des attaques de bip (un bip de 100 ms au début de chaque seconde de média) : position vidéo au front montant. */
const edges: Array<{ videoTime: number; offset: number }> = [];
let armed = true;
setInterval(() => {
  const level = rms();
  if (level > 0.06 && armed) {
    armed = false;
    const t = video.currentTime;
    // Écart au début de seconde le plus proche : positif = le bip arrive quand la vidéo a déjà dépassé la seconde.
    let off = t - Math.round(t);
    if (Math.abs(off) > 0.5) off = 0;
    edges.push({ videoTime: t, offset: off });
  } else if (level < 0.01) armed = true;
}, 4);

w.__w = {
  video,
  toasts,
  edges,
  rms,
  state,
  caps: () => browserCaps(),
  env: () => ({
    ua: navigator.userAgent,
    eac3: video.canPlayType('audio/mp4; codecs="ec-3"'),
    ac3: video.canPlayType('audio/mp4; codecs="ac-3"'),
    aac: video.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    audioDecoder: typeof AudioDecoder !== 'undefined',
    isolated: crossOriginIsolated,
  }),
  async run(url: string, opts: { nameCodec?: string | null; alternatives?: Alt[]; autoplay?: boolean } = {}) {
    toasts.length = 0;
    edges.length = 0;
    state.actions = [];
    await html.load({ url, startAt: 0 });
    const alternatives = opts.alternatives ?? [];
    const handle = await startWebAudio(
      {
        video: video as never,
        caps: browserCaps(),
        attach: (fb) => html.attachAudio(fb),
        onChange: () => (html as unknown as { emit(e: string): void }).emit('state'),
        toast: (message, _ms, action) => { toasts.push({ message, action: action?.label }); if (action) state.actions.push(action.run); },
        alternatives: () => alternatives,
        currentIndex: () => 0,
        probeView: async () => null,
        describe: (v) => (v as Alt).filename,
        play: (v) => state.played.push((v as Alt).filename),
        setMode: (mode) => { state.mode = mode; },
      },
      { url, nameCodec: opts.nameCodec ?? null, stale: () => false },
    );
    state.handle = handle;
    return handle.plan;
  },
  stats: () => html.audio?.stats() ?? null,
  engineState: () => html.state(),
  playing: () => html.audio?.playingMedia() ?? null,
  setVolume: (v: number) => html.setVolume(v),
  setMuted: (m: boolean) => html.setMuted(m),
  setRate: (r: number) => html.setRate(r),
  seek: (t: number) => html.seek(t),
  pause: () => html.pause(),
  play: () => html.play(),
  decodedBytes: () => (video as unknown as { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? null,
};
