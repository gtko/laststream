import { fetchText } from '../sources/http.js';
import type { TitleInfo } from '../sources/indexers.js';
import type { ContentRef } from '../types.js';
import { sharedCache, type TtlCache } from '../cache/ttl-cache.js';

const CINEMETA_META_URL = 'https://v3-cinemeta.strem.io/meta';
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
const IMDB_ID = /^tt\d+$/;

interface MetaRuntimes {
  runtimeSeconds: number | undefined;
  /** Durée par épisode, clé « saison:épisode », uniquement si Cinemeta la fournit. */
  episodes: Map<string, number>;
  /** Nombre d'épisodes par saison (saison 1 et suivantes), d'après la liste des vidéos. */
  seasonCounts: Map<number, number>;
  /** Titre et année de sortie (ou de début), si Cinemeta les fournit : repli de recherche sans jeton TMDB. */
  title?: string;
  year?: number;
}

export interface CinemetaOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Cache partagé (par défaut : celui de l'isolat). */
  cache?: TtlCache;
}

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
  const seasonCounts = new Map<number, number>();
  if (Array.isArray(meta.videos)) {
    for (const video of meta.videos) {
      if (!isRecord(video) || typeof video.season !== 'number' || typeof video.episode !== 'number') continue;
      if (video.season > 0) seasonCounts.set(video.season, (seasonCounts.get(video.season) ?? 0) + 1);
      const seconds = parseRuntimeSeconds(video.runtime);
      if (seconds !== undefined) episodes.set(episodeKey(video.season, video.episode), seconds);
    }
  }
  const out: MetaRuntimes = { runtimeSeconds: parseRuntimeSeconds(meta.runtime), episodes, seasonCounts };
  if (typeof meta.name === 'string' && meta.name.trim() !== '') out.title = meta.name.trim();
  const year = typeof meta.releaseInfo === 'string' ? /^\s*(\d{4})/.exec(meta.releaseInfo) : null;
  if (year !== null) out.year = Number(year[1]);
  return out;
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

/**
 * Durée en secondes pour un film ou un épisode, via Cinemeta. Pour une série, la durée de l'épisode
 * est utilisée si elle est fournie, sinon la durée de la série. Ne lève jamais : erreur ⇒ undefined.
 */
/** Fiche Cinemeta résumée (cache 24 h, une requête partagée par identifiant). Undefined si inconnue ou en erreur. */
async function loadMeta(ref: ContentRef, opts: CinemetaOptions): Promise<MetaRuntimes | undefined> {
  if (ref.type !== 'movie' && ref.type !== 'series') return undefined;
  if (!IMDB_ID.test(ref.imdbId)) return undefined;

  // Une seule requête par titre, même pour des appels simultanés (cache partagé, requêtes en vol dédoublonnées).
  return (opts.cache ?? sharedCache()).get<MetaRuntimes | undefined>(
    `${ref.type}:${ref.imdbId}`,
    (runtimes) => (runtimes === undefined ? 0 : TTL_MS),
    async () => summarize(await fetchMeta(ref, opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    { provider: 'cinemeta', swr: true },
  );
}

/**
 * Durée en secondes pour un film ou un épisode, via Cinemeta. Pour une série, la durée de l'épisode
 * est utilisée si elle est fournie, sinon la durée de la série. Ne lève jamais : erreur ⇒ undefined.
 */
export async function getRuntimeSeconds(ref: ContentRef, opts: CinemetaOptions = {}): Promise<number | undefined> {
  try {
    const runtimes = await loadMeta(ref, opts);
    if (runtimes === undefined) return undefined;
    if (ref.type === 'series' && ref.season !== undefined && ref.episode !== undefined) {
      const episodeSeconds = runtimes.episodes.get(episodeKey(ref.season, ref.episode));
      if (episodeSeconds !== undefined) return episodeSeconds;
    }
    return runtimes.runtimeSeconds;
  } catch {
    return undefined;
  }
}

/**
 * Titre et année d'un film ou d'une série via Cinemeta (même requête et même cache que la durée). Sert de repli
 * de recherche quand TMDB ne donne aucun titre (jeton absent ou en panne). Ne lève jamais : erreur ⇒ undefined.
 */
export async function getCinemetaTitle(ref: ContentRef, opts: CinemetaOptions = {}): Promise<TitleInfo | undefined> {
  try {
    const runtimes = await loadMeta(ref, opts);
    if (runtimes?.title === undefined) return undefined;
    return runtimes.year === undefined ? { title: runtimes.title } : { title: runtimes.title, year: runtimes.year };
  } catch {
    return undefined;
  }
}

/**
 * Nombre d'épisodes par saison d'une série (Cinemeta, même requête et même cache que la durée). Sert à estimer la taille
 * par épisode d'un pack. Film, erreur ou fiche sans vidéos : table vide. Ne lève jamais.
 */
export async function getSeasonEpisodeCounts(ref: ContentRef, opts: CinemetaOptions = {}): Promise<Map<number, number>> {
  if (ref.type !== 'series') return new Map();
  try {
    return (await loadMeta(ref, opts))?.seasonCounts ?? new Map();
  } catch {
    return new Map();
  }
}
