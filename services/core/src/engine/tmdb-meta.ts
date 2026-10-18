import { fetchText, isRecord } from '../sources/http.js';
import type { ContentRef } from '../types.js';
import type { ContentMeta } from './types.js';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4000;
const IMDB_ID = /^tt\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FR_AGES: ReadonlySet<number> = new Set([10, 12, 16, 18]);
/** Fenêtre « peut-être déjà en ligne » d'un épisode : ses sources restent visibles jusqu'à 14 jours avant sa diffusion. */
const EPISODE_WINDOW_DAYS = 14;

interface CacheEntry {
  expiresAt: number;
  value: ContentMeta;
}

/** Cache mémoire des métadonnées TMDB, clé « type:imdb:saison:épisode ». */
export type MetaCache = Map<string, CacheEntry>;

const defaultCache: MetaCache = new Map();

export interface TmdbMetaOptions {
  /** Jeton de lecture TMDB (API v4, en-tête Bearer). Absent : aucun appel TMDB. */
  tmdbToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cache?: MetaCache;
  /** Durée Cinemeta en secondes, utilisée si TMDB ne fournit aucune durée. */
  cinemetaRuntimeSeconds?: number;
}

/** Réponse JSON : `absent` (404) est définitif, `error` est transitoire et n'est jamais mis en cache. */
type JsonResult = { kind: 'ok'; json: unknown } | { kind: 'absent' } | { kind: 'error' };

/**
 * Âge minimum FR d'une classification TMDB (« -12 », « 12 », « TP », vide) : 0 pour tous publics,
 * undefined si la valeur n'est pas reconnue.
 */
export function certificationAge(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'TP') return 0;
  const age = Number(trimmed.replace(/^-/, ''));
  return FR_AGES.has(age) ? age : undefined;
}

/** Âge le plus restrictif parmi les classifications reconnues ; undefined si aucune ne l'est. */
function strictestAge(values: readonly unknown[]): number | undefined {
  const ages = values.map(certificationAge).filter((age): age is number => age !== undefined);
  return ages.length > 0 ? Math.max(...ages) : undefined;
}

/** Entrées de `results` pour un pays donné. */
function resultsFor(container: unknown, country: string): Record<string, unknown>[] {
  if (!isRecord(container) || !Array.isArray(container.results)) return [];
  return container.results.filter(isRecord).filter((entry) => entry.iso_3166_1 === country);
}

function movieCertification(json: Record<string, unknown>): number | undefined {
  const values = resultsFor(json.release_dates, 'FR').flatMap((entry) =>
    Array.isArray(entry.release_dates) ? entry.release_dates.filter(isRecord).map((date) => date.certification) : [],
  );
  return strictestAge(values);
}

function seriesCertification(json: Record<string, unknown>): number | undefined {
  return strictestAge(resultsFor(json.content_ratings, 'FR').map((entry) => entry.rating));
}

/** Minutes TMDB vers secondes ; undefined si absent ou nul. */
function minutesToSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 60) : undefined;
}

function isoDate(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;
}

/** Ne garde que les champs renseignés. */
function compact(meta: ContentMeta): ContentMeta {
  const result: ContentMeta = {};
  if (meta.runtimeSeconds !== undefined) result.runtimeSeconds = meta.runtimeSeconds;
  if (meta.certificationFr !== undefined) result.certificationFr = meta.certificationFr;
  if (meta.releaseDate !== undefined) result.releaseDate = meta.releaseDate;
  if (meta.releaseWindowDays !== undefined) result.releaseWindowDays = meta.releaseWindowDays;
  return result;
}

/** Durée Cinemeta de repli, uniquement si elle est exploitable. */
function withCinemetaRuntime(meta: ContentMeta, cinemetaSeconds: number | undefined): ContentMeta {
  if (meta.runtimeSeconds !== undefined) return meta;
  if (cinemetaSeconds === undefined || !Number.isFinite(cinemetaSeconds) || cinemetaSeconds <= 0) return meta;
  return { ...meta, runtimeSeconds: cinemetaSeconds };
}

/** Appel GET JSON authentifié. Ne lève jamais ; le jeton n'apparaît dans aucun résultat ni message. */
async function getJson(url: string, token: string, fetchFn: typeof fetch, timeoutMs: number): Promise<JsonResult> {
  try {
    const response = await fetchText(
      fetchFn,
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      timeoutMs,
    );
    if (response.status === 404) return { kind: 'absent' };
    if (!response.ok) return { kind: 'error' };
    return { kind: 'ok', json: JSON.parse(response.text) as unknown };
  } catch {
    return { kind: 'error' };
  }
}

/** Identifiant TMDB d'un titre à partir de la réponse /find. */
function tmdbIdFrom(found: unknown, type: ContentRef['type']): number | undefined {
  if (!isRecord(found)) return undefined;
  const results = found[type === 'movie' ? 'movie_results' : 'tv_results'];
  if (!Array.isArray(results) || !isRecord(results[0])) return undefined;
  const id = results[0].id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
}

interface FetchOutcome {
  meta: ContentMeta;
  /** Faux si un appel a échoué de façon transitoire : le résultat n'est alors pas mis en cache. */
  complete: boolean;
}

/** Métadonnées d'un film ou d'un épisode, via TMDB. */
async function fetchTmdbMeta(
  ref: ContentRef,
  token: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const findUrl = `${TMDB_API_URL}/find/${ref.imdbId}?external_source=imdb_id`;
  const found = await getJson(findUrl, token, fetchFn, timeoutMs);
  if (found.kind === 'error') return { meta: {}, complete: false };
  if (found.kind === 'absent') return { meta: {}, complete: true };

  const id = tmdbIdFrom(found.json, ref.type);
  if (id === undefined) return { meta: {}, complete: true };

  if (ref.type === 'movie') {
    const movieUrl = `${TMDB_API_URL}/movie/${id}?append_to_response=release_dates`;
    const movie = await getJson(movieUrl, token, fetchFn, timeoutMs);
    if (movie.kind === 'error') return { meta: {}, complete: false };
    const json = movie.kind === 'ok' && isRecord(movie.json) ? movie.json : undefined;
    if (json === undefined) return { meta: {}, complete: true };
    return {
      meta: compact({
        runtimeSeconds: minutesToSeconds(json.runtime),
        certificationFr: movieCertification(json),
        releaseDate: isoDate(json.release_date),
      }),
      complete: true,
    };
  }

  const hasEpisode = Number.isInteger(ref.season) && Number.isInteger(ref.episode);
  const [show, episode] = await Promise.all([
    getJson(`${TMDB_API_URL}/tv/${id}?append_to_response=content_ratings`, token, fetchFn, timeoutMs),
    hasEpisode
      ? getJson(`${TMDB_API_URL}/tv/${id}/season/${ref.season}/episode/${ref.episode}`, token, fetchFn, timeoutMs)
      : Promise.resolve<JsonResult>({ kind: 'absent' }),
  ]);
  const complete = show.kind !== 'error' && episode.kind !== 'error';
  const meta: ContentMeta = {};
  if (show.kind === 'ok' && isRecord(show.json)) {
    const certificationFr = seriesCertification(show.json);
    if (certificationFr !== undefined) meta.certificationFr = certificationFr;
  }
  if (episode.kind === 'ok' && isRecord(episode.json)) {
    const runtimeSeconds = minutesToSeconds(episode.json.runtime);
    const releaseDate = isoDate(episode.json.air_date);
    if (runtimeSeconds !== undefined) meta.runtimeSeconds = runtimeSeconds;
    if (releaseDate !== undefined) {
      meta.releaseDate = releaseDate;
      meta.releaseWindowDays = EPISODE_WINDOW_DAYS;
    }
  }
  return { meta: compact(meta), complete };
}

function cacheKey(ref: ContentRef): string {
  return `${ref.type}:${ref.imdbId}:${ref.season ?? '-'}:${ref.episode ?? '-'}`;
}

function readCache(cache: MetaCache, key: string): ContentMeta | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function storeEntry(cache: MetaCache, key: string, value: ContentMeta): void {
  const now = Date.now();
  for (const [existingKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existingKey);
  }
  cache.set(key, { expiresAt: now + TTL_MS, value });
}

/**
 * Métadonnées d'un film ou d'un épisode : durée réelle, certification FR et date de sortie, via TMDB (API v4,
 * jeton Bearer). Sans jeton, aucun appel n'est fait. La durée Cinemeta sert de repli si TMDB n'en donne pas.
 * Ne lève jamais : en cas d'erreur, renvoie ce qui est connu (au pire `{}`). Seuls les résultats complets sont
 * mis en cache (6 h, en mémoire).
 */
export async function getContentMeta(ref: ContentRef, opts: TmdbMetaOptions = {}): Promise<ContentMeta> {
  const cinemetaSeconds = opts.cinemetaRuntimeSeconds;
  try {
    const token = opts.tmdbToken?.trim();
    if (token === undefined || token === '') return withCinemetaRuntime({}, cinemetaSeconds);
    if (ref.type !== 'movie' && ref.type !== 'series') return withCinemetaRuntime({}, cinemetaSeconds);
    if (!IMDB_ID.test(ref.imdbId)) return withCinemetaRuntime({}, cinemetaSeconds);

    const cache = opts.cache ?? defaultCache;
    const key = cacheKey(ref);
    const cached = readCache(cache, key);
    if (cached !== undefined) return withCinemetaRuntime(cached, cinemetaSeconds);

    const outcome = await fetchTmdbMeta(ref, token, opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (outcome.complete) storeEntry(cache, key, outcome.meta);
    return withCinemetaRuntime(outcome.meta, cinemetaSeconds);
  } catch {
    return withCinemetaRuntime({}, cinemetaSeconds);
  }
}
