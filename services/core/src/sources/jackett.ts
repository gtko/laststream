import type { ContentRef, RawStream } from '../types.js';
import { defaultIndexerHealth, type IndexerHealth } from './indexer-health.js';
import {
  INDEXER_REQUEST_TIMEOUT_MS,
  describeFailure,
  endpointUrl,
  optionalString,
  parseJson,
  type IndexerInfo,
  type IndexerPrivacy,
} from './indexers.js';
import {
  SourceError,
  fetchText,
  isRecord,
  resolveOptions,
  sourceFailure,
  type FetchFn,
  type HttpOptions,
} from './http.js';
import { searchTorznab } from './torznab.js';

/** Source Jackett : résultats Torznab de tous les indexeurs (`all`) ou d'une liste d'indexeurs. */
export interface JackettSource {
  name: string;
  baseUrl: string;
  apiKey: string;
  indexers: 'all' | string[];
}

export interface JackettSearchOptions extends HttpOptions {
  health?: IndexerHealth;
}

const ALL = 'all';

/** Point d'entrée Torznab d'un indexeur Jackett (`all` pour l'agrégation). Le parseur Torznab est réutilisé. */
function torznabUrl(baseUrl: string, target: string): string {
  return endpointUrl(baseUrl, `/api/v2.0/indexers/${encodeURIComponent(target)}/results/torznab`);
}

function privacyOf(value: unknown): IndexerPrivacy {
  if (value === 'private') return 'private';
  if (value === 'semi-private') return 'semiPrivate';
  return 'public';
}

/** Capacités déclarées par Jackett pour une famille de recherche (liste supportedParams en minuscules). */
function supportedParams(node: unknown): Set<string> {
  if (!isRecord(node) || node.available === false || !Array.isArray(node.supportedParams)) return new Set();
  return new Set(
    node.supportedParams.filter((param): param is string => typeof param === 'string').map((param) => param.toLowerCase()),
  );
}

/** Indexeur Jackett brut (GET /api/v2.0/indexers?configured=true) vers IndexerInfo. Jackett est torrent uniquement. */
function toIndexerInfo(raw: Record<string, unknown>): IndexerInfo | undefined {
  const id = optionalString(raw.id);
  if (id === undefined) return undefined;
  const name = optionalString(raw.title) ?? optionalString(raw.name) ?? id;
  const searching = isRecord(raw.searching) ? raw.searching : {};
  const movie = supportedParams(searching['movie-search']);
  const tv = supportedParams(searching['tv-search']);
  return {
    id,
    name,
    protocol: 'torrent',
    enabled: true,
    privacy: privacyOf(raw.type),
    supportsImdb: movie.has('imdbid') || tv.has('imdbid'),
    supportsTvdb: movie.has('tvdbid') || tv.has('tvdbid'),
    supportsSeason: tv.has('season'),
    movieImdb: movie.has('imdbid'),
    tvImdb: tv.has('imdbid'),
  };
}

async function listIndexers(source: JackettSource, fetchFn: FetchFn, timeoutMs: number): Promise<IndexerInfo[]> {
  const params = new URLSearchParams({ configured: 'true', apikey: source.apiKey });
  const res = await fetchText(
    fetchFn,
    endpointUrl(source.baseUrl, '/api/v2.0/indexers', params),
    { headers: { Accept: 'application/json' } },
    timeoutMs,
  );
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  const body = parseJson(res.text);
  if (!Array.isArray(body)) throw new SourceError('réponse inattendue (liste d’indexeurs attendue)');
  return body.filter(isRecord).flatMap((raw) => {
    const info = toIndexerInfo(raw);
    return info === undefined ? [] : [info];
  });
}

/**
 * Indexeurs Jackett configurés (GET /api/v2.0/indexers?configured=true).
 * Lève une SourceError sûre (sans URL ni clé) en cas d'erreur HTTP, de JSON invalide ou de délai dépassé.
 */
export async function discoverJackettIndexers(source: JackettSource, opts: HttpOptions = {}): Promise<IndexerInfo[]> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    return await listIndexers(source, fetchFn, timeoutMs);
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}

/**
 * Recherche Jackett : une requête Torznab par cible (`all`, ou chaque identifiant de la liste). Une cible en échec
 * n'empêche pas les autres. Lève une SourceError seulement si toutes les cibles échouent.
 */
export async function searchJackett(
  source: JackettSource,
  ref: ContentRef,
  opts: JackettSearchOptions = {},
): Promise<RawStream[]> {
  const { fetchFn } = resolveOptions(opts);
  const timeoutMs = opts.timeoutMs ?? INDEXER_REQUEST_TIMEOUT_MS;
  const health = opts.health ?? defaultIndexerHealth;
  const targets = source.indexers === ALL ? [ALL] : [...new Set(source.indexers)];
  if (targets.length === 0) return [];

  const run = async (target: string): Promise<RawStream[]> => {
    const started = Date.now();
    try {
      const streams = await searchTorznab(
        { name: source.name, baseUrl: torznabUrl(source.baseUrl, target), apiKey: source.apiKey },
        ref,
        { fetch: fetchFn, timeoutMs, tagIndexers: true },
      );
      health.record(source.name, target, { ok: true, latencyMs: Date.now() - started });
      return streams;
    } catch (err) {
      const error = describeFailure(err, source.apiKey);
      health.record(source.name, target, { ok: false, latencyMs: Date.now() - started, error });
      throw err;
    }
  };

  const settled = await Promise.allSettled(targets.map(run));
  const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (rejected.length === settled.length) {
    const reason: unknown = rejected[0]?.reason;
    // searchTorznab a déjà préfixé l'erreur par le nom de la source.
    throw reason instanceof SourceError ? reason : sourceFailure(source.name, reason);
  }
  return settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
}
