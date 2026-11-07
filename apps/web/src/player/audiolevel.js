/* Mesure du niveau sonore dans la bande de la voix (WebAudio) pour caler automatiquement les sous-titres.
 * Le son passe par un graphe WebAudio : on ne l'active que sur demande, et pas sur un média d'une autre origine sans CORS
 * (le navigateur le rendrait muet). Les flux HLS (blob MSE) et les médias de la même origine conviennent. */

const SAMPLE_MS = 100;
const MAX_SAMPLES = 24000;

function sameOriginOrBlob(src) {
  if (!src) return false;
  if (src.startsWith('blob:')) return true;
  try { return new URL(src, location.href).origin === location.origin; } catch (_) { return false; }
}

/** Le flux se prête-t-il à l'analyse (sans rien brancher) ? */
export function levelProbeSupported(video) {
  if (!(window.AudioContext || window.webkitAudioContext)) return { ok: false, reason: 'Ce navigateur n’a pas WebAudio.' };
  if (!sameOriginOrBlob(video.currentSrc || video.src)) return { ok: false, reason: 'Disponible en lecture convertie (HLS) ; ce flux direct vient d’une autre origine.' };
  return { ok: true, reason: '' };
}

/** Renvoie { ok:false, reason } ou { ok:true, samples, start(), stop(), seconds() } (secondes de vidéo couvertes). */
export function createLevelProbe(video) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return { ok: false, reason: 'Ce navigateur n’a pas WebAudio.' };
  if (!sameOriginOrBlob(video.currentSrc || video.src)) return { ok: false, reason: 'Disponible en lecture convertie (HLS) ; ce flux direct vient d’une autre origine.' };
  let graph = video._lsLevelGraph;
  try {
    if (!graph) {
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(video);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1200;
      band.Q.value = 0.45;
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(ctx.destination); // le son continue d'aller aux enceintes
      src.connect(band);
      band.connect(an);
      graph = { ctx, an, buf: new Float32Array(an.fftSize) };
      video._lsLevelGraph = graph;
    }
  } catch (_) {
    return { ok: false, reason: 'Impossible de brancher l’analyse audio sur cette vidéo.' };
  }
  const samples = [];
  let timer = null;
  return {
    ok: true,
    samples,
    start() {
      graph.ctx.resume().catch(() => {});
      timer = setInterval(() => {
        if (video.paused || video.seeking || video.readyState < 3) return;
        graph.an.getFloatTimeDomainData(graph.buf);
        let sum = 0;
        for (let i = 0; i < graph.buf.length; i++) sum += graph.buf[i] * graph.buf[i];
        samples.push({ t: video.currentTime, v: Math.sqrt(sum / graph.buf.length) });
        if (samples.length > MAX_SAMPLES) samples.shift();
      }, SAMPLE_MS);
    },
    stop() { clearInterval(timer); timer = null; },
    /** Secondes de vidéo distinctes mesurées. */
    seconds() { return new Set(samples.map((s) => Math.floor(s.t))).size; },
  };
}
