import type { AutoKind, AutoMethod, SkipSegmentStore } from '../../user/skip-segments.js';
import { CHAPTER_CONFIDENCE, type Found, probeChapters, segmentsFromChapters } from './chapters.js';
import { parseCreditsOutput } from './credits.js';
import {
  type Fingerprint,
  fingerprintPcm,
  ITEM_SECONDS,
  longestRun,
  pointSeconds,
  RATE,
  type Run,
  snapToSilence,
} from './fingerprint.js';
import type { LocalUrlPolicy } from './media-url.js';
import { runProcess } from './proc.js';
import { ByteBudget, JOB_BYTE_BUDGET, openSource, type SourceProxy } from './proxy.js';
import type { MediaTools } from './tools.js';

/** Confiance d'un segment trouvé par empreinte audio, et par noir et silence de fin. */
export const FINGERPRINT_CONFIDENCE = 0.8;
export const FALLBACK_MIN_CONFIDENCE = 0.6;
/** Longueurs retenues (secondes). */
const INTRO_RANGE = { min: 15, max: 120 } as const;
const CREDITS_RANGE = { min: 15, max: 300 } as const;
/** Fenêtres analysées : début d'épisode (25 %, 10 min au plus) et fin (6 min). */
const INTRO_SHARE = 0.25;
const INTRO_WINDOW_MAX = 600;
const CREDITS_WINDOW = 360;
/** Part de l'empreinte de référence qui doit se retrouver dans un nouvel épisode. */
const REFERENCE_SHARE = 0.7;
const MIN_DURATION = 120;
/** Durée maximale d'un job (secondes). */
const JOB_TIMEOUT_MS = 6 * 60_000;
const EXTRACT_TIMEOUT_MS = 120_000;

export type Outcome = 'chapters' | 'fingerprint' | 'fallback' | 'waiting' | 'none' | 'error';

/** Épisode analysé. */
export interface EpisodeRef {
  imdbId: string;
  season: number;
  episode: number;
  /** 0 pour un film. */
  type: 'movie' | 'series';
  url: URL;
  duration: number;
}

export interface AnalyzeDeps {
  tools: MediaTools;
  store: SkipSegmentStore;
  allowLocal: LocalUrlPolicy;
  /** Autres épisodes de la saison dont on connaît le média (les plus proches d'abord). */
  siblings: (job: EpisodeRef) => EpisodeRef[];
  now: () => Date;
  byteBudget?: number;
}

/** Fenêtre audio lue : PCM, empreinte et position (secondes) dans l'épisode. */
interface Window {
  start: number;
  pcm: Int16Array;
  fp: Fingerprint;
}

type Kind = 'intro' | 'credits';

function windowBounds(kind: Kind, duration: number): { start: number; length: number } {
  if (kind === 'intro') return { start: 0, length: Math.min(duration * INTRO_SHARE, INTRO_WINDOW_MAX) };
  const length = Math.min(CREDITS_WINDOW, duration * 0.5);
  return { start: duration - length, length };
}

/** Lit l'audio mono d'une fenêtre (accès réseau borné par -ss / -t, via le relais local). */
async function readPcm(tools: MediaTools, url: string, start: number, length: number, timeoutMs: number): Promise<Int16Array | undefined> {
  const args = [
    '-nostdin', '-v', 'error', '-rw_timeout', '20000000',
    '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', url,
    '-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1',
  ];
  const result = await runProcess(tools.ffmpeg, args, { timeoutMs, maxStdout: Math.ceil((length + 2) * RATE * 2) });
  if (result.killed && result.stdout.length < RATE * 4) return undefined;
  const even = result.stdout.length - (result.stdout.length % 2);
  if (even < RATE * 10 * 2) return undefined;
  const bytes = new Uint8Array(result.stdout.subarray(0, even));
  return new Int16Array(bytes.buffer);
}

/** Plage retenue entre deux fenêtres, en secondes dans chaque épisode. */
interface Matched {
  a: { start: number; end: number };
  b: { start: number; end: number };
  points: Uint32Array;
}

const inRange = (seconds: number, kind: Kind): boolean => {
  const range = kind === 'intro' ? INTRO_RANGE : CREDITS_RANGE;
  return seconds >= range.min && seconds <= range.max;
};

function toMatched(run: Run, a: Window, b: Window, kind: Kind): Matched | undefined {
  if (!inRange(run.length * ITEM_SECONDS, kind)) return undefined;
  return {
    a: { start: a.start + pointSeconds(a.fp.method, run.aStart), end: a.start + pointSeconds(a.fp.method, run.aStart + run.length, 'end') },
    b: { start: b.start + pointSeconds(b.fp.method, run.bStart), end: b.start + pointSeconds(b.fp.method, run.bStart + run.length, 'end') },
    points: a.fp.points.slice(run.aStart, run.aStart + run.length),
  };
}

/** Segment final : bornes calées sur le silence le plus proche, générique prolongé jusqu'à la fin si elle est proche. */
function finish(kind: Kind, span: { start: number; end: number }, window: Window, duration: number): Found {
  const snap = (seconds: number): number => window.start + snapToSilence(window.pcm, seconds - window.start);
  let start = Math.max(0, snap(span.start));
  let end = Math.min(duration, snap(span.end));
  if (kind === 'credits' && duration - end < 12) end = duration;
  if (end <= start) {
    start = span.start;
    end = span.end;
  }
  return { kind, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
}

/** Un épisode passé au job : fenêtres lues à la demande. */
class EpisodeReader {
  private readonly windows = new Map<Kind, Window | null>();
  constructor(
    private readonly deps: AnalyzeDeps,
    private readonly job: EpisodeRef,
    private readonly url: string,
    private readonly deadline: () => number,
  ) {}

  async window(kind: Kind): Promise<Window | undefined> {
    const cached = this.windows.get(kind);
    if (cached !== undefined) return cached ?? undefined;
    const { start, length } = windowBounds(kind, this.job.duration);
    const budgetMs = Math.min(EXTRACT_TIMEOUT_MS, this.deadline());
    const pcm = budgetMs > 5000 ? await readPcm(this.deps.tools, this.url, start, length, budgetMs) : undefined;
    const window = pcm === undefined ? null : { start, pcm, fp: await fingerprintPcm(this.deps.tools, pcm) };
    this.windows.set(kind, window);
    return window ?? undefined;
  }
}

/** Recherche de la référence (intro ou générique de la saison) dans une fenêtre. */
function matchReference(points: Uint32Array, window: Window, kind: Kind, duration: number): Found | undefined {
  const reference: Fingerprint = {
    method: window.fp.method,
    points,
    audible: new Uint8Array(points.length).fill(1),
  };
  const run = longestRun(reference, window.fp, Math.ceil(points.length * REFERENCE_SHARE));
  if (run === undefined) return undefined;
  const first = run.bStart - run.aStart;
  const start = window.start + pointSeconds(window.fp.method, Math.max(0, first));
  const end = Math.min(duration, window.start + pointSeconds(window.fp.method, first + points.length, 'end'));
  if (!inRange(end - start, kind) && !inRange(run.length * ITEM_SECONDS, kind)) return undefined;
  return finish(kind, { start, end }, window, duration);
}

/** Sortie de blackdetect et silencedetect sur la fin : début du générique si une longue zone noire va jusqu'à la fin. */
async function creditsFallback(
  tools: MediaTools,
  url: string,
  duration: number,
  timeoutMs: number,
): Promise<{ start: number; confidence: number } | undefined> {
  const length = Math.min(CREDITS_WINDOW, duration * 0.5);
  const from = duration - length;
  const result = await runProcess(
    tools.ffmpeg,
    [
      '-nostdin', '-nostats', '-v', 'info', '-rw_timeout', '20000000',
      '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', url,
      '-vf', 'blackdetect=d=2:pic_th=0.9:pix_th=0.15', '-af', 'silencedetect=n=-45dB:d=1', '-f', 'null', '-',
    ],
    { timeoutMs, maxStdout: 1024 * 1024 },
  );
  if (result.code !== 0) return undefined;
  const found = parseCreditsOutput(result.stderr, length);
  if (found === undefined || found.confidence < FALLBACK_MIN_CONFIDENCE) return undefined;
  const start = from + found.start;
  return start >= duration * 0.5 ? { start, confidence: found.confidence } : undefined;
}

/**
 * Analyse d'un épisode : chapitres, puis empreinte audio (référence de la saison, sinon appariement avec un épisode
 * voisin), puis noir et silence de fin. Le total d'octets lus est plafonné (relais compteur) ; ffmpeg est tué au délai.
 */
export async function analyzeEpisode(deps: AnalyzeDeps, job: EpisodeRef): Promise<Outcome> {
  const started = Date.now();
  const deadline = (): number => JOB_TIMEOUT_MS - (Date.now() - started);
  const budget = new ByteBudget(deps.byteBudget ?? JOB_BYTE_BUDGET);
  const proxies: SourceProxy[] = [];
  const open = async (url: URL): Promise<string> => {
    const proxy = await openSource(url, budget, deps.allowLocal);
    proxies.push(proxy);
    return proxy.url;
  };
  const nowIso = (): string => deps.now().toISOString();
  const save = (episode: EpisodeRef, found: Found, confidence: number, method: AutoMethod): boolean =>
    deps.store.saveAuto(
      episode.imdbId,
      episode.season,
      episode.episode,
      episode.duration,
      { kind: found.kind, start: found.start, end: found.end, confidence, method },
      nowIso(),
    );
  try {
    const ownUrl = await open(job.url);
    const chapters = segmentsFromChapters(await probeChapters(deps.tools, ownUrl), job.duration);
    for (const found of chapters) save(job, found, CHAPTER_CONFIDENCE, 'chapters');
    if (chapters.some((found) => found.kind === 'intro' || found.kind === 'credits')) return 'chapters';
    if (job.duration < MIN_DURATION) return 'none';

    const reader = new EpisodeReader(deps, job, ownUrl, deadline);
    const have = new Set<Kind>();
    let outcome: Outcome = 'none';
    if (job.type === 'series') {
      const method = deps.tools.chromaprint ? 'chromaprint' : 'spectral';
      const references = deps.store.fingerprintsFor(job.imdbId, job.season, method);
      const referenced = new Set<Kind>(references.map((reference) => reference.kind));
      // Référence de saison : un seul épisode a suffi à l'établir.
      for (const reference of references) {
        const window = await reader.window(reference.kind);
        if (window === undefined) continue;
        const found = matchReference(reference.points, window, reference.kind, job.duration);
        if (found !== undefined && save(job, found, FINGERPRINT_CONFIDENCE, 'fingerprint')) {
          have.add(reference.kind);
          outcome = 'fingerprint';
        }
      }
      // Appariement avec un épisode voisin pour les types sans référence.
      const todo = (['intro', 'credits'] as const).filter((kind) => !referenced.has(kind));
      if (todo.length > 0) {
        const siblings = deps.siblings(job).slice(0, 2);
        if (siblings.length === 0 && have.size === 0) outcome = 'waiting';
        for (const sibling of siblings) {
          const siblingReader = new EpisodeReader(deps, sibling, await open(sibling.url), deadline);
          for (const kind of todo) {
            if (have.has(kind)) continue;
            const mine = await reader.window(kind);
            const theirs = await siblingReader.window(kind);
            if (mine === undefined || theirs === undefined) continue;
            const run = longestRun(mine.fp, theirs.fp, Math.ceil((kind === 'intro' ? INTRO_RANGE : CREDITS_RANGE).min / ITEM_SECONDS));
            const matched = run === undefined ? undefined : toMatched(run, mine, theirs, kind);
            if (matched === undefined) continue;
            save(job, finish(kind, matched.a, mine, job.duration), FINGERPRINT_CONFIDENCE, 'fingerprint');
            save(sibling, finish(kind, matched.b, theirs, sibling.duration), FINGERPRINT_CONFIDENCE, 'fingerprint');
            deps.store.saveFingerprint(job.imdbId, job.season, { kind, method, points: matched.points }, nowIso());
            have.add(kind);
            outcome = 'fingerprint';
          }
          if (have.size === todo.length) break;
        }
      }
    }
    if (!have.has('credits') && deadline() > 20_000) {
      const fallback = await creditsFallback(deps.tools, ownUrl, job.duration, Math.min(EXTRACT_TIMEOUT_MS, deadline()));
      if (fallback !== undefined) {
        const kind: AutoKind = 'credits';
        const saved = save(job, { kind, start: Math.round(fallback.start * 10) / 10, end: job.duration }, fallback.confidence, 'blackdetect');
        if (saved && outcome !== 'fingerprint') outcome = 'fallback';
      }
    }
    return outcome;
  } catch {
    return 'error';
  } finally {
    await Promise.all(proxies.map((proxy) => proxy.close()));
  }
}
