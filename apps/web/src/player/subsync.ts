import type { Cue } from './subs';

/* Synchronisation des sous-titres : calage décalage + vitesse, suggestion PAL (25 / 23,976 i/s), recherche automatique
 * du décalage par corrélation avec l'activité de parole de la piste audio. Fonctions pures, testées. */

/** Heure de la vidéo (s) → heure du fichier de sous-titres, avec décalage manuel et rapport de vitesse. */
export function subtitleTime(videoTime: number, offset: number, rate: number): number {
  return (videoTime - offset) / (rate > 0 ? rate : 1);
}

/** Heure de la vidéo où une cue du fichier de sous-titres doit apparaître. */
export function videoTimeOfCue(cueTime: number, offset: number, rate: number): number {
  return cueTime * (rate > 0 ? rate : 1) + offset;
}

/**
 * Heure de la vidéo (lecture) pour un instant du fichier d'origine : les fichiers dont le premier paquet est à
 * `fileStart` secondes (MKV, TS) sont lus par le navigateur à partir de 0, alors que les sous-titres extraits par le serveur
 * gardent l'heure du fichier. Les flux HLS WebVTT sont, eux, recalés par hls.js (carte de temps du premier fragment).
 */
export function fileTimeToPlayback(fileTime: number, fileStart: number): number {
  return fileTime - fileStart;
}

export interface RateChoice {
  id: 'none' | 'pal-down' | 'pal-up';
  /** Rapport appliqué : heure vidéo = heure sous-titre × ratio. */
  ratio: number;
  label: string;
}

const FILM = 24000 / 1001; // 23,976 i/s
export const RATE_CHOICES: readonly RateChoice[] = [
  { id: 'none', ratio: 1, label: 'Aucune' },
  { id: 'pal-down', ratio: 25 / FILM, label: '25 → 23,976 i/s' },
  { id: 'pal-up', ratio: FILM / 25, label: '23,976 → 25 i/s' },
];

export function rateChoice(id: string): RateChoice {
  return RATE_CHOICES.find((r) => r.id === id) ?? RATE_CHOICES[0];
}

/**
 * Suggestion de correction de vitesse d'après la dernière cue et la durée de la vidéo : des sous-titres plus longs que la
 * vidéo trahissent un calage sur 23,976 i/s alors que le fichier est en 25 i/s (et l'inverse). Renvoie `none` si les
 * durées concordent à 1,5 % près ou si aucune correction ne rend la fin des sous-titres plausible.
 */
export function suggestRate(lastCueEnd: number, duration: number): RateChoice {
  if (!(lastCueEnd > 0) || !(duration > 0)) return RATE_CHOICES[0];
  const ratio = lastCueEnd / duration;
  // Sous-titres qui finissent après la fin du film : trop longs, il faut les comprimer.
  if (ratio > 1.015) {
    const r = RATE_CHOICES[2];
    return lastCueEnd * r.ratio <= duration + 1 ? r : RATE_CHOICES[0];
  }
  return RATE_CHOICES[0];
}

// ---------- Synchronisation automatique ----------

export interface LevelSample {
  /** Heure de la vidéo (s). */
  t: number;
  /** Niveau sonore dans la bande de la voix (0 à 1). */
  v: number;
}

export interface SyncResult {
  offset: number;
  rate: number;
  /** Écart d'activité sonore entre l'intérieur et l'extérieur des cues (0 à 1). */
  score: number;
  /** Écart avec la médiane des autres hypothèses : plus il est grand, plus le résultat est sûr. */
  confidence: number;
}

export interface SyncOptions {
  maxShift?: number;
  step?: number;
  rates?: readonly number[];
  gridStep?: number;
}

/** Ramène des mesures irrégulières sur une grille régulière (valeur la plus forte par case) et binarise la parole. */
export function speechGrid(samples: readonly LevelSample[], step: number): { t0: number; active: Uint8Array } {
  if (!samples.length) return { t0: 0, active: new Uint8Array(0) };
  const t0 = Math.floor(Math.min(...samples.map((s) => s.t)) / step) * step;
  const t1 = Math.max(...samples.map((s) => s.t));
  const n = Math.max(1, Math.ceil((t1 - t0) / step) + 1);
  const level = new Float32Array(n).fill(-1);
  for (const s of samples) {
    const i = Math.round((s.t - t0) / step);
    if (i >= 0 && i < n && s.v > level[i]) level[i] = s.v;
  }
  const seen = Array.from(level).filter((x) => x >= 0).sort((a, b) => a - b);
  if (!seen.length) return { t0, active: new Uint8Array(n) };
  // Seuil adaptatif : au-dessus du bruit de fond (25e centile) d'une marge qui suit la dynamique du signal.
  const lo = seen[Math.floor(seen.length * 0.25)];
  const hi = seen[Math.floor(seen.length * 0.9)];
  const thr = lo + (hi - lo) * 0.35;
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) active[i] = level[i] >= 0 ? (level[i] > thr ? 1 : 0) : 2; // 2 : pas de mesure
  return { t0, active };
}

/**
 * Cherche le décalage (et le rapport de vitesse) qui font coïncider les cues avec la parole : on maximise, sur les instants
 * mesurés, la part d'activité sonore dans les cues moins celle hors des cues.
 */
export function findSync(samples: readonly LevelSample[], cues: readonly Pick<Cue, 'start' | 'end'>[], opts: SyncOptions = {}): SyncResult | null {
  const maxShift = opts.maxShift ?? 30;
  const step = opts.step ?? 0.1;
  const gridStep = opts.gridStep ?? 0.1;
  const rates = opts.rates ?? [1];
  const { t0, active } = speechGrid(samples, gridStep);
  const points: Array<{ t: number; a: number }> = [];
  for (let i = 0; i < active.length; i++) if (active[i] !== 2) points.push({ t: t0 + i * gridStep, a: active[i] });
  if (points.length < 200 || !cues.length) return null;
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const starts = sorted.map((c) => c.start);
  let maxEnd = 0;
  const prefixEnd = sorted.map((c) => (maxEnd = Math.max(maxEnd, c.end)));
  const inCue = (x: number): boolean => {
    let lo = 0;
    let hi = starts.length - 1;
    let best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] <= x) { best = m; lo = m + 1; } else hi = m - 1;
    }
    return best >= 0 && prefixEnd[best] > x;
  };
  const results: SyncResult[] = [];
  for (const rate of rates) {
    for (let off = -maxShift; off <= maxShift + 1e-9; off += step) {
      let inA = 0;
      let inN = 0;
      let outA = 0;
      let outN = 0;
      for (const p of points) {
        if (inCue((p.t - off) / rate)) { inN++; inA += p.a; } else { outN++; outA += p.a; }
      }
      if (inN < 20 || outN < 20) continue;
      results.push({ offset: Math.round(off * 100) / 100, rate, score: inA / inN - outA / outN, confidence: 0 });
    }
  }
  if (!results.length) return null;
  const best = results.reduce((a, b) => (b.score > a.score ? b : a));
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  return { ...best, confidence: best.score - median };
}

/** Résultat assez net pour être appliqué sans demander ? */
export function syncTrusted(r: SyncResult | null): r is SyncResult {
  return !!r && r.score >= 0.12 && r.confidence >= 0.12;
}
