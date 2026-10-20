import { runProcess } from './proc.js';
import type { MediaTools } from './tools.js';

/** Fréquence d'échantillonnage du PCM analysé (celle de Chromaprint). */
export const RATE = 11025;
/** Pas entre deux points d'empreinte, en échantillons (comme Chromaprint) et en secondes. */
const HOP = 1365;
export const ITEM_SECONDS = HOP / RATE;

export type FingerprintMethod = 'chromaprint' | 'spectral';

/**
 * Décalage constant (secondes) entre une extrémité de plage d'empreinte et le vrai bord de la séquence commune, mesuré
 * sur les fixtures synthétiques : Chromaprint voit le début ~0,9 s trop tôt (son contexte déborde) et la fin ~1 s trop
 * tôt ; l'empreinte spectrale est quasi exacte.
 */
const EDGE_DELAY: Record<FingerprintMethod, { start: number; end: number }> = {
  chromaprint: { start: 0.9, end: 1.05 },
  spectral: { start: 0.36, end: -0.1 },
};

/** Instant (secondes dans la fenêtre) du début (index du premier point) ou de la fin (index après le dernier) d'une plage. */
export function pointSeconds(method: FingerprintMethod, index: number, edge: 'start' | 'end' = 'start'): number {
  return index * ITEM_SECONDS + EDGE_DELAY[method][edge];
}

/** Empreinte d'une fenêtre audio : un uint32 par pas, et un drapeau « audible » par pas. */
export interface Fingerprint {
  method: FingerprintMethod;
  points: Uint32Array;
  /** 1 si le pas contient du son (le silence numérique donne des empreintes identiques et ne doit pas concorder). */
  audible: Uint8Array;
}

const popcount = (value: number): number => {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
};

// --- Empreinte spectrale interne (Haitsma-Kalker : 33 bandes, signe des différences en fréquence et en temps) ---

const FFT_SIZE = 2048;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 4000;
/** Énergie de bande sous laquelle (par rapport au pic de la trame) un bit reste à 0 : le bruit de fond n'y décide pas. */
const FLOOR = 1e-4;

const WINDOW = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
const COS = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE));
const SIN = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / FFT_SIZE));
const REVERSED = (() => {
  const bits = Math.log2(FFT_SIZE);
  return Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b += 1) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  });
})();
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => {
  const hz = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BANDS);
  return Math.min(FFT_SIZE / 2, Math.max(1, Math.round((hz * FFT_SIZE) / RATE)));
});

/** FFT radix-2 en place. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const j = REVERSED[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = COS[k * step] ?? 0;
        const wi = SIN[k * step] ?? 0;
        const a = start + k;
        const b = a + half;
        const xr = (re[b] ?? 0) * wr - (im[b] ?? 0) * wi;
        const xi = (re[b] ?? 0) * wi + (im[b] ?? 0) * wr;
        re[b] = (re[a] ?? 0) - xr;
        im[b] = (im[a] ?? 0) - xi;
        re[a] = (re[a] ?? 0) + xr;
        im[a] = (im[a] ?? 0) + xi;
      }
    }
  }
}

/** Niveau RMS (dBFS) de chaque tranche de `frame` échantillons. */
function rmsDb(pcm: Int16Array, frame = HOP): Float32Array {
  const count = Math.max(0, Math.floor(pcm.length / frame));
  const out = new Float32Array(count);
  for (let f = 0; f < count; f += 1) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i += 1) {
      const v = (pcm[i] ?? 0) / 32768;
      sum += v * v;
    }
    out[f] = 10 * Math.log10(sum / frame + 1e-12);
  }
  return out;
}

/** Niveau (dBFS) sous lequel un pas est considéré silencieux pour la concordance. */
const AUDIBLE_DB = -55;

function audibleOf(pcm: Int16Array, count: number): Uint8Array {
  const levels = rmsDb(pcm);
  return Uint8Array.from({ length: count }, (_, i) => ((levels[i] ?? -120) > AUDIBLE_DB ? 1 : 0));
}

/** Empreinte spectrale interne d'un PCM mono à RATE Hz : un point tous les HOP échantillons. */
export function spectralFingerprint(pcm: Int16Array): Fingerprint {
  const frames = pcm.length >= FFT_SIZE ? Math.floor((pcm.length - FFT_SIZE) / HOP) + 1 : 0;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const points = new Uint32Array(Math.max(0, frames - 1));
  for (let n = 0; n < frames; n += 1) {
    const offset = n * HOP;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = ((pcm[offset + i] ?? 0) / 32768) * (WINDOW[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    const energy = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b += 1) {
      const from = EDGES[b] ?? 0;
      const to = Math.max(from + 1, EDGES[b + 1] ?? 0);
      let sum = 0;
      for (let k = from; k < to; k += 1) sum += (re[k] ?? 0) * (re[k] ?? 0) + (im[k] ?? 0) * (im[k] ?? 0);
      energy[b] = sum;
    }
    if (n > 0) {
      let peak = 0;
      for (let m = 0; m < BANDS; m += 1) peak = Math.max(peak, energy[m] ?? 0);
      const floor = peak * FLOOR;
      let word = 0;
      for (let m = 0; m < 32; m += 1) {
        const low = energy[m] ?? 0;
        const high = energy[m + 1] ?? 0;
        if (low > floor && low > high) word |= 1 << m;
      }
      points[n - 1] = word >>> 0;
    }
  }
  return { method: 'spectral', points, audible: audibleOf(pcm, points.length) };
}

/** Empreinte Chromaprint native : le PCM passe par ffmpeg (-f chromaprint -fp_format raw), sans second accès réseau. */
export async function chromaprintFingerprint(tools: MediaTools, pcm: Int16Array, timeoutMs = 60_000): Promise<Fingerprint | undefined> {
  const input = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const result = await runProcess(
    tools.ffmpeg,
    ['-nostdin', '-v', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-f', 'chromaprint', '-fp_format', 'raw', 'pipe:1'],
    { timeoutMs, maxStdout: 8 * 1024 * 1024, stdin: input },
  );
  if (result.code !== 0 || result.stdout.length < 8 || result.stdout.length % 4 !== 0) return undefined;
  const copy = new Uint8Array(result.stdout);
  const points = new Uint32Array(copy.buffer);
  return { method: 'chromaprint', points, audible: audibleOf(pcm, points.length) };
}

/** Empreinte d'un PCM : Chromaprint si ffmpeg l'a, sinon (ou en cas d'échec) l'empreinte spectrale interne. */
export async function fingerprintPcm(tools: MediaTools | undefined, pcm: Int16Array): Promise<Fingerprint> {
  if (tools?.chromaprint === true) {
    const native = await chromaprintFingerprint(tools, pcm);
    if (native !== undefined) return native;
  }
  return spectralFingerprint(pcm);
}

// --- Concordance ---

/** Écart de bits maximal (sur 32) pour que deux points concordent, selon la méthode. */
const MAX_BIT_DIFF: Record<FingerprintMethod, number> = { chromaprint: 6, spectral: 8 };
/** Points non concordants consécutifs tolérés à l'intérieur d'une plage. */
const MAX_GAP = 8;
/** Part minimale de points concordants dans une plage : écarte les plages tenues par quelques hasards. */
const MIN_DENSITY = 0.4;

export interface Run {
  /** Premier point de la plage dans chaque empreinte, et nombre de points. */
  aStart: number;
  bStart: number;
  length: number;
}

/**
 * Plus longue plage alignée entre deux empreintes : pour chaque décalage, les points consécutifs dont l'écart de bits
 * est sous le seuil (trous de MAX_GAP tolérés). Les pas silencieux ne concordent jamais.
 */
export function longestRun(a: Fingerprint, b: Fingerprint, minLength = 1): Run | undefined {
  const threshold = MAX_BIT_DIFF[a.method];
  let best: Run | undefined;
  const na = a.points.length;
  const nb = b.points.length;
  for (let shift = -(na - 1); shift < nb; shift += 1) {
    const from = Math.max(0, -shift);
    const to = Math.min(na, nb - shift);
    if (to - from < Math.max(minLength, (best?.length ?? 0) + 1)) continue;
    let runStart = -1;
    let lastHit = -1;
    let hits = 0;
    const keep = (): void => {
      const length = lastHit - runStart + 1;
      if (length >= minLength && length > (best?.length ?? 0) && hits >= length * MIN_DENSITY) {
        best = { aStart: runStart, bStart: runStart + shift, length };
      }
    };
    for (let i = from; i < to; i += 1) {
      const j = i + shift;
      const hit =
        a.audible[i] === 1 && b.audible[j] === 1 && popcount(((a.points[i] ?? 0) ^ (b.points[j] ?? 0)) >>> 0) <= threshold;
      if (hit) {
        if (runStart < 0) {
          runStart = i;
          hits = 0;
        }
        lastHit = i;
        hits += 1;
      } else if (runStart >= 0 && i - lastHit > MAX_GAP) {
        keep();
        runStart = -1;
      }
    }
    if (runStart >= 0) keep();
  }
  return best === undefined ? undefined : trimRun(a, b, best, threshold);
}

/** Largeur (points) de la fenêtre qui juge les bords d'une plage, et nombre minimal de concordances dedans. */
const EDGE_WINDOW = 8;
const EDGE_HITS = 3;

/** Rogne les bords d'une plage tant que leur voisinage immédiat n'est pas franchement concordant (écarte les coups de chance). */
function trimRun(a: Fingerprint, b: Fingerprint, run: Run, threshold: number): Run {
  const hit = (offset: number): boolean => {
    const i = run.aStart + offset;
    const j = run.bStart + offset;
    return a.audible[i] === 1 && b.audible[j] === 1 && popcount(((a.points[i] ?? 0) ^ (b.points[j] ?? 0)) >>> 0) <= threshold;
  };
  const dense = (from: number): boolean => {
    let count = 0;
    for (let k = from; k < from + EDGE_WINDOW; k += 1) if (k >= 0 && k < run.length && hit(k)) count += 1;
    return count >= EDGE_HITS;
  };
  let first = 0;
  let last = run.length - 1;
  while (first < last && !(hit(first) && dense(first))) first += 1;
  while (last > first && !(hit(last) && dense(last - EDGE_WINDOW + 1))) last -= 1;
  return { aStart: run.aStart + first, bStart: run.bStart + first, length: last - first + 1 };
}

// --- Affinage aux silences (équivalent de silencedetect, sur le PCM déjà lu) ---

/** Silence franc : sous -55 dBFS pendant au moins 3 trames de 40 ms (les creux entre notes ou répliques ne comptent pas). */
const SILENCE_DB = -55;
const SILENCE_FRAME = 441;
const MIN_SILENCE_FRAMES = 3;

/**
 * Cale une borne (secondes dans la fenêtre) sur le silence le plus proche à moins de `reach` secondes : milieu de la
 * plage silencieuse (au moins 120 ms). Sans silence proche, la borne reste telle quelle.
 */
export function snapToSilence(pcm: Int16Array, seconds: number, reach = 2): number {
  const levels = rmsDb(pcm, SILENCE_FRAME);
  const frame = SILENCE_FRAME / RATE;
  const lo = Math.max(0, Math.floor((seconds - reach) / frame));
  const hi = Math.min(levels.length - 1, Math.ceil((seconds + reach) / frame));
  let best: number | undefined;
  let runStart = -1;
  const close = (end: number): void => {
    if (runStart < 0 || end - runStart + 1 < MIN_SILENCE_FRAMES) return;
    const middle = ((runStart + end + 1) / 2) * frame;
    if (best === undefined || Math.abs(middle - seconds) < Math.abs(best - seconds)) best = middle;
  };
  for (let i = lo; i <= hi; i += 1) {
    if ((levels[i] ?? 0) < SILENCE_DB) {
      if (runStart < 0) runStart = i;
    } else {
      close(i - 1);
      runStart = -1;
    }
  }
  close(hi);
  return best ?? seconds;
}
