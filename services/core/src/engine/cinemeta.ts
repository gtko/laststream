import { fetchText } from '../sources/http.js';
import type { ContentRef } from '../types.js';

const CINEMETA_META_URL = 'https://v3-cinemeta.strem.io/meta';
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
const IMDB_ID = /^tt\d+$/;

interface MetaRuntimes {
  runtimeSeconds: number | undefined;
  /** Durée par épisode, clé « saison:épisode », uniquement si Cinemeta la fournit. */
  episodes: Map<string, number>;
}

interface CacheEntry {
  expiresAt: number;
  value: MetaRuntimes;
}

export type RuntimeCache = Map<string, CacheEntry>;

export interface CinemetaOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  cache?: RuntimeCache;
}

const defaultCache: RuntimeCache = new Map();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const episodeKey = (season: number, episode: number): string => `${season}:${episode}`;

/**
 * Convertit une durée Cinemeta en secondes : « 142 min », « 1h 22min », « 2h ».
 * Un nombre seul est lu comme des minutes. Renvoie undefined si rien n'est reconnu.
 */
export function parseRuntimeSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value * 60) : undefined;
  if (typeof value !== 'string') return undefined;
  const hours = /(\d+)\s*h/i.exec(value);
  const minutes = /(\d+)\s*(?:min|m)\b/i.exec(value);
  const bare = /^\s*(\d+)\s*$/.exec(value);
  let total = 0;
  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (hours === null && minutes === null && bare) total = Number(bare[1]) * 60;
  return total > 0 ? total : undefined;
}

function summarize(json: unknown): MetaRuntimes | undefined {
  if (!isRecord(json) || !isRecord(json.meta)) return undefined;
  const meta = json.meta;
  const episodes = new Map<string, number>();
  if (Array.isArray(meta.videos)) {
    for (const video of meta.videos) {
      if (!isRecord(video) || typeof video.season !== 'number' || typeof video.episode !== 'number') continue;
      const seconds = parseRuntimeSeconds(video.runtime);
      if (seconds !== undefined) episodes.set(episodeKey(video.season, video.episode), seconds);
    }
  }
  return { runtimeSeconds: parseRuntimeSeconds(meta.runtime), episodes };
}

async function fetchMeta(ref: ContentRef, fetchFn: typeof fetch, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // La course garantit le délai ; fetchText applique aussi son propre délai (AbortController).
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  const request = (async (): Promise<unknown> => {
    const url = `${CINEMETA_META_URL}/${ref.type}/${encodeURIComponent(ref.imdbId)}.json`;
    // Passe par fetchText : redirections revalidées et corps borné (2 Mo).
    const response = await fetchText(fetchFn, url, {}, timeoutMs);
    if (!response.ok) return undefined;
    return JSON.parse(response.text);
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function storeEntry(cache: RuntimeCache, key: string, value: MetaRuntimes): void {
  const now = Date.now();
  for (const [existingKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existingKey);
  }
  cache.set(key, { expiresAt: now + TTL_MS, value });
}

/**
 * Durée en secondes pour un film ou un épisode, via Cinemeta. Pour une série, la durée de l'épisode
 * est utilisée si elle est fournie, sinon la durée de la série. Ne lève jamais : erreur ⇒ undefined.
 */
export async function getRuntimeSeconds(ref: ContentRef, opts: CinemetaOptions = {}): Promise<number | undefined> {
  try {
    if (ref.type !== 'movie' && ref.type !== 'series') return undefined;
    if (!IMDB_ID.test(ref.imdbId)) return undefined;

    const cache = opts.cache ?? defaultCache;
    const key = `${ref.type}:${ref.imdbId}`;
    let runtimes: MetaRuntimes | undefined;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      runtimes = cached.value;
    } else {
      const json = await fetchMeta(ref, opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      runtimes = summarize(json);
      if (runtimes === undefined) return undefined;
      storeEntry(cache, key, runtimes);
    }

    if (ref.type === 'series' && ref.season !== undefined && ref.episode !== undefined) {
      const episodeSeconds = runtimes.episodes.get(episodeKey(ref.season, ref.episode));
      if (episodeSeconds !== undefined) return episodeSeconds;
    }
    return runtimes.runtimeSeconds;
  } catch {
    return undefined;
  }
}
