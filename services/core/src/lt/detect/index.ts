import type { SkipSegmentStore } from '../../user/skip-segments.js';
import type { SkipTarget } from '../skip.js';
import { analyzeEpisode, type AnalyzeDeps, type EpisodeRef, type Outcome } from './analyze.js';
import { defaultLocalPolicy, type LocalUrlPolicy } from './media-url.js';
import { locateTools, type MediaTools } from './tools.js';

export { validateMediaUrl } from './media-url.js';

/** Débit maximal : jobs démarrés par minute. */
export const MAX_JOBS_PER_MINUTE = 2;
/** Appariements d'épisodes tentés par saison au plus (ensuite, seule l'empreinte de référence sert). */
const MAX_PAIRINGS = 2;
/** Durée de vie d'une URL de média rapportée (le lecteur la renouvelle à chaque lecture). */
const MEDIA_TTL_MS = 6 * 3600e3;
const MAX_MEDIA = 500;
const MAX_QUEUE = 20;
/** Délai avant de réanalyser un épisode dont la dernière analyse n'a rien donné. */
const RETRY_AFTER_MS = 6 * 3600e3;
/** Durée plausible d'un épisode ou d'un film rapporté (secondes). */
export const MIN_REPORT_DURATION = 60;
export const MAX_REPORT_DURATION = 86_400;

export interface AutoDetectOptions {
  /** Binaires ffmpeg/ffprobe (tests) ; sinon localisés à la demande. */
  tools?: MediaTools | (() => Promise<MediaTools | undefined>);
  /** URL locales autorisées en plus des adresses publiques (défaut : le serveur de streaming 127.0.0.1:11470). */
  allowLocal?: LocalUrlPolicy;
  now?: () => Date;
  byteBudget?: number;
  /** Désactive la détection (LASTADDON_SKIP_DETECT=0). */
  disabled?: boolean;
}

export interface Report {
  target: SkipTarget;
  url: URL;
  duration: number;
}

export interface ReportResult {
  queued: boolean;
  /** Raison de l'absence de job : disabled, no_ffmpeg, known, retry_later, rate_limited, queue_full. */
  reason?: string;
}

export interface AutoDetector {
  report(report: Report): Promise<ReportResult>;
  /** Vrai si un job de cet épisode est en attente ou en cours. */
  analyzing(target: SkipTarget): boolean;
  /** Origine des binaires utilisés (diagnostic), si localisés. */
  toolsOrigin(): string | undefined;
  /** Attend la fin des jobs en cours (tests, arrêt). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

interface Known {
  url: URL;
  duration: number;
  at: number;
}

interface Attempt {
  at: number;
  outcome: Outcome;
}

const keyOf = (imdbId: string, season: number, episode: number): string => `${imdbId}:${season}:${episode}`;
const seasonOf = (imdbId: string, season: number): string => `${imdbId}:${season}`;

/**
 * File d'analyse en arrière-plan : un job à la fois, au plus MAX_JOBS_PER_MINUTE démarrages par minute. Les URL de
 * média rapportées restent en mémoire seulement (jamais en base, jamais dans les journaux).
 */
export function createAutoDetector(openStore: () => SkipSegmentStore, options: AutoDetectOptions = {}): AutoDetector {
  const now = options.now ?? (() => new Date());
  const allowLocal = options.allowLocal ?? defaultLocalPolicy;
  const media = new Map<string, Known>();
  const attempts = new Map<string, Attempt>();
  const pending: EpisodeRef[] = [];
  const active = new Set<string>();
  const startTimes: number[] = [];
  const pairings = new Map<string, number>();
  let tools: MediaTools | undefined;
  let toolsLoaded = false;
  let running: Promise<void> = Promise.resolve();
  let draining = false;
  let closed = false;

  const loadTools = async (): Promise<MediaTools | undefined> => {
    if (toolsLoaded) return tools;
    const source = options.tools;
    tools = typeof source === 'function' ? await source() : (source ?? (await locateTools()));
    toolsLoaded = true;
    return tools;
  };

  const remember = (imdbId: string, season: number, episode: number, known: Known): void => {
    const key = keyOf(imdbId, season, episode);
    media.delete(key);
    media.set(key, known);
    while (media.size > MAX_MEDIA) {
      const oldest = media.keys().next().value;
      if (oldest === undefined) break;
      media.delete(oldest);
    }
  };

  const siblingsOf = (job: EpisodeRef): EpisodeRef[] => {
    const prefix = seasonOf(job.imdbId, job.season) + ':';
    const cutoff = now().getTime() - MEDIA_TTL_MS;
    const found: EpisodeRef[] = [];
    for (const [key, known] of media) {
      if (!key.startsWith(prefix) || known.at < cutoff) continue;
      const episode = Number(key.slice(prefix.length));
      if (episode === job.episode) continue;
      found.push({ imdbId: job.imdbId, season: job.season, episode, type: 'series', url: known.url, duration: known.duration });
    }
    return found.sort((a, b) => Math.abs(a.episode - job.episode) - Math.abs(b.episode - job.episode) || a.episode - b.episode);
  };

  const complete = (store: SkipSegmentStore, job: Report): boolean => {
    const { imdbId, season, episode } = job.target;
    const saved = store.autoSegmentsFor(imdbId, season, episode);
    if (saved.some((segment) => segment.method === 'chapters' && (segment.kind === 'intro' || segment.kind === 'credits'))) return true;
    const has = (kind: string): boolean => saved.some((segment) => segment.kind === kind && segment.method === 'fingerprint');
    return has('intro') && has('credits');
  };

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const job = pending.shift();
        if (job === undefined || closed) break;
        const key = keyOf(job.imdbId, job.season, job.episode);
        const available = await loadTools();
        let outcome: Outcome = 'error';
        if (available !== undefined) {
          const deps: AnalyzeDeps = {
            tools: available,
            store: openStore(),
            allowLocal,
            siblings: siblingsOf,
            canPair: (episode) => (pairings.get(seasonOf(episode.imdbId, episode.season)) ?? 0) < MAX_PAIRINGS,
            pairTried: (episode) => {
              const key = seasonOf(episode.imdbId, episode.season);
              pairings.set(key, (pairings.get(key) ?? 0) + 1);
            },
            now,
            ...(options.byteBudget === undefined ? {} : { byteBudget: options.byteBudget }),
          };
          outcome = await analyzeEpisode(deps, job);
        }
        attempts.set(key, { at: now().getTime(), outcome });
        active.delete(key);
      }
    } finally {
      draining = false;
    }
  }

  const schedule = (): void => {
    running = running.then(drain, drain);
  };

  async function report(input: Report): Promise<ReportResult> {
    if (options.disabled === true || closed) return { queued: false, reason: 'disabled' };
    const { imdbId, season, episode, type } = input.target;
    const key = keyOf(imdbId, season, episode);
    const time = now().getTime();
    remember(imdbId, season, episode, { url: input.url, duration: input.duration, at: time });
    if ((await loadTools()) === undefined) return { queued: false, reason: 'no_ffmpeg' };
    if (active.has(key)) return { queued: true };
    if (complete(openStore(), input)) return { queued: false, reason: 'known' };
    const last = attempts.get(key);
    const job: EpisodeRef = { imdbId, season, episode, type, url: input.url, duration: input.duration };
    if (last !== undefined) {
      // « waiting » : relancé dès qu'un épisode voisin est connu ; les autres issues attendent le délai de reprise.
      const retry = last.outcome === 'waiting' ? siblingsOf(job).length > 0 : time - last.at > RETRY_AFTER_MS;
      if (!retry) return { queued: false, reason: 'retry_later' };
    }
    while (startTimes.length > 0 && (startTimes[0] ?? 0) <= time - 60_000) startTimes.shift();
    if (startTimes.length >= MAX_JOBS_PER_MINUTE) return { queued: false, reason: 'rate_limited' };
    if (pending.length >= MAX_QUEUE) return { queued: false, reason: 'queue_full' };
    startTimes.push(time);
    active.add(key);
    pending.push(job);
    schedule();
    return { queued: true };
  }

  return {
    report,
    analyzing: (target) => active.has(keyOf(target.imdbId, target.season, target.episode)),
    toolsOrigin: () => tools?.origin,
    idle: () => running,
    close: async () => {
      closed = true;
      pending.length = 0;
      await running;
    },
  };
}
