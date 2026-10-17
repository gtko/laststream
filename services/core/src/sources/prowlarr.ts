import type { ContentRef, RawStream } from '../types.js';
import { defaultIndexerHealth, type IndexerHealth } from './indexer-health.js';
import {
  INDEXER_REQUEST_TIMEOUT_MS,
  describeFailure,
  endpointUrl,
  infoHashFromMagnet,
  isMagnet,
  nonNegativeNumber,
  normalizeInfoHash,
  optionalString,
  parseJson,
  type IndexerInfo,
  type IndexerPrivacy,
  type TitleInfo,
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

/** Source Prowlarr : un point d'entrée qui interroge plusieurs indexeurs torrent. */
export interface ProwlarrSource {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Indexeurs à interroger (identifiants Prowlarr). Vide ou absent : tous les indexeurs torrent activés. */
  indexerIds?: number[];
  /** Catégories Torznab. Par défaut : films 2000, séries 5000. */
  categories?: number[];
}

export interface ProwlarrSearchOptions extends HttpOptions {
  titleInfo?: TitleInfo;
  /** Budget global de la recherche (découverte + requêtes), en millisecondes. */
  budgetMs?: number;
  health?: IndexerHealth;
}

/** Budget global par défaut d'une recherche Prowlarr, en millisecondes. */
export const PROWLARR_BUDGET_MS = 12_000;

const MOVIE_CATEGORIES: readonly number[] = [2000];
const SERIES_CATEGORIES: readonly number[] = [5000];

/** Requête regroupée : indexeurs qui partagent une même capacité de recherche, et paramètres prêts à l'emploi. */
interface PlannedSearch {
  indexers: IndexerInfo[];
  params: URLSearchParams;
}

function headers(apiKey: string): Record<string, string> {
  // Clé dans un en-tête : jamais dans l'URL, donc jamais dans un message d'erreur ou un journal.
  return { Accept: 'application/json', 'X-Api-Key': apiKey };
}

function lowerList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase());
}

function privacyOf(value: unknown): IndexerPrivacy {
  if (value === 'private') return 'private';
  if (value === 'semiPrivate') return 'semiPrivate';
  return 'public';
}

/** Indexeur Prowlarr brut vers IndexerInfo. Seuls les indexeurs torrent activés sont gardés. */
function toIndexerInfo(raw: Record<string, unknown>): IndexerInfo | undefined {
  const id = typeof raw.id === 'number' && Number.isInteger(raw.id) ? raw.id : undefined;
  const name = optionalString(raw.name);
  if (id === undefined || name === undefined) return undefined;
  if (optionalString(raw.protocol)?.toLowerCase() !== 'torrent') return undefined;
  if (raw.enable !== true && raw.enabled !== true) return undefined;
  const caps = isRecord(raw.capabilities) ? raw.capabilities : {};
  const movie = lowerList(caps.movieSearchParams);
  const tv = lowerList(caps.tvSearchParams);
  return {
    id,
    name,
    protocol: 'torrent',
    enabled: true,
    privacy: privacyOf(raw.privacy),
    supportsImdb: movie.includes('imdbid') || tv.includes('imdbid'),
    supportsTvdb: movie.includes('tvdbid') || tv.includes('tvdbid'),
    supportsSeason: tv.includes('season'),
    movieImdb: movie.includes('imdbid'),
    tvImdb: tv.includes('imdbid'),
  };
}

async function listIndexers(source: ProwlarrSource, fetchFn: FetchFn, timeoutMs: number): Promise<IndexerInfo[]> {
  const res = await fetchText(
    fetchFn,
    endpointUrl(source.baseUrl, '/api/v1/indexer'),
    { headers: headers(source.apiKey) },
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
 * Indexeurs Prowlarr torrent et activés (GET /api/v1/indexer, en-tête X-Api-Key).
 * Lève une SourceError sûre (sans URL ni clé) en cas d'erreur HTTP, de JSON invalide ou de délai dépassé.
 */
export async function discoverProwlarrIndexers(source: ProwlarrSource, opts: HttpOptions = {}): Promise<IndexerInfo[]> {
  const { fetchFn, timeoutMs } = resolveOptions(opts);
  try {
    return await listIndexers(source, fetchFn, timeoutMs);
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}

function idCapable(indexer: IndexerInfo, ref: ContentRef): boolean {
  return ref.type === 'movie' ? indexer.movieImdb : indexer.tvImdb && indexer.supportsSeason;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Requête texte de repli : « Titre Année » pour un film, « Titre S01E02 » pour un épisode. */
function textQuery(ref: ContentRef, info: TitleInfo): string | undefined {
  const title = info.title.trim().slice(0, 200);
  if (title === '') return undefined;
  if (ref.type === 'movie') return info.year !== undefined ? `${title} ${info.year}` : title;
  if (ref.season === undefined || ref.episode === undefined) return title;
  return `${title} S${pad2(ref.season)}E${pad2(ref.episode)}`;
}

/** Paramètres communs à une requête : type, indexeurs restreints, catégories. */
function baseParams(ref: ContentRef, indexers: IndexerInfo[], categories: readonly number[]): URLSearchParams {
  const params = new URLSearchParams();
  params.set('type', ref.type === 'movie' ? 'movie' : 'tvsearch');
  for (const indexer of indexers) params.append('indexerIds', String(indexer.id));
  for (const category of categories) params.append('categories', String(category));
  return params;
}

/**
 * Regroupe les indexeurs par capacité : ceux qui acceptent l'identifiant IMDb reçoivent une requête par id,
 * les autres une requête texte (si un titre est connu). Un indexeur ne figure que dans un groupe.
 */
function planSearches(
  indexers: IndexerInfo[],
  ref: ContentRef,
  categories: readonly number[],
  titleInfo: TitleInfo | undefined,
): PlannedSearch[] {
  const byId = indexers.filter((indexer) => idCapable(indexer, ref));
  const byText = indexers.filter((indexer) => !idCapable(indexer, ref));
  const query = titleInfo === undefined ? undefined : textQuery(ref, titleInfo);
  const plans: PlannedSearch[] = [];

  if (byId.length > 0) {
    const params = baseParams(ref, byId, categories);
    params.set('imdbId', ref.imdbId.replace(/^tt/i, ''));
    if (ref.type === 'series') {
      if (ref.season !== undefined) params.set('season', String(ref.season));
      if (ref.episode !== undefined) params.set('episode', String(ref.episode));
    }
    plans.push({ indexers: byId, params });
  }
  if (byText.length > 0 && query !== undefined) {
    const params = baseParams(ref, byText, categories);
    params.set('query', query);
    plans.push({ indexers: byText, params });
  }
  return plans;
}

function selectIndexers(indexers: IndexerInfo[], ids: readonly number[] | undefined): IndexerInfo[] {
  if (ids === undefined || ids.length === 0) return indexers;
  const wanted = new Set(ids.map(String));
  return indexers.filter((indexer) => wanted.has(String(indexer.id)));
}

function categoriesFor(source: ProwlarrSource, ref: ContentRef): readonly number[] {
  if (source.categories !== undefined && source.categories.length > 0) return source.categories;
  return ref.type === 'movie' ? MOVIE_CATEGORIES : SERIES_CATEGORIES;
}

/** Base32 ou hex accepté ; magnet ou infoHash obligatoire, sinon le release est ignoré. */
function toRawStream(raw: Record<string, unknown>, indexerName: string): RawStream | undefined {
  const protocol = optionalString(raw.protocol);
  if (protocol !== undefined && protocol.toLowerCase() !== 'torrent') return undefined;

  // downloadUrl n'est retenu que s'il est un magnet : un lien .torrent passe par Prowlarr et porte sa clé.
  const magnet = [optionalString(raw.magnetUrl), optionalString(raw.downloadUrl)].find(isMagnet);
  const infoHash = normalizeInfoHash(raw.infoHash) ?? infoHashFromMagnet(magnet);
  if (infoHash === undefined && magnet === undefined) return undefined;

  const stream: RawStream = { sourceName: indexerName, sourceKind: 'torznab', name: indexerName, indexers: [indexerName] };
  const title = optionalString(raw.title);
  if (title !== undefined) {
    stream.title = title;
    stream.filename = title;
  }
  const size = nonNegativeNumber(raw.size);
  if (size !== undefined) stream.sizeBytes = Math.floor(size);
  const seeders = nonNegativeNumber(raw.seeders);
  if (seeders !== undefined) stream.seeders = Math.floor(seeders);
  if (infoHash !== undefined) stream.infoHash = infoHash;
  if (magnet !== undefined) stream.magnet = magnet;
  return stream;
}

/** Nom de l'indexeur d'un release : champ `indexer`, à défaut le nom connu pour son identifiant. */
function indexerNameOf(raw: Record<string, unknown>, names: ReadonlyMap<string, string>, fallback: string): string {
  return optionalString(raw.indexer) ?? names.get(String(raw.indexerId)) ?? fallback;
}

/**
 * Recherche Prowlarr (GET /api/v1/search) sur les indexeurs torrent retenus.
 * Les indexeurs sont regroupés par capacité (id IMDb ou texte) ; chaque groupe est une requête. Un groupe en échec
 * n'empêche pas les autres (santé mise à jour par indexeur). Budget global : chaque requête ne dépasse pas le temps
 * restant. Lève une SourceError sûre seulement si la découverte échoue ou si tous les groupes échouent.
 */
export async function searchProwlarr(
  source: ProwlarrSource,
  ref: ContentRef,
  opts: ProwlarrSearchOptions = {},
): Promise<RawStream[]> {
  const { fetchFn } = resolveOptions(opts);
  const budgetMs = opts.budgetMs ?? PROWLARR_BUDGET_MS;
  const perRequestMs = opts.timeoutMs ?? INDEXER_REQUEST_TIMEOUT_MS;
  const health = opts.health ?? defaultIndexerHealth;
  const deadline = Date.now() + budgetMs;
  const timeLeft = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new SourceError(`délai dépassé (${budgetMs} ms)`);
    return Math.min(perRequestMs, Math.ceil(left));
  };

  try {
    const discovered = await listIndexers(source, fetchFn, timeLeft());
    const plans = planSearches(
      selectIndexers(discovered, source.indexerIds),
      ref,
      categoriesFor(source, ref),
      opts.titleInfo,
    );
    if (plans.length === 0) return [];

    const names = new Map(discovered.map((indexer) => [String(indexer.id), indexer.name]));
    const run = async (plan: PlannedSearch): Promise<RawStream[]> => {
      const started = Date.now();
      try {
        const url = endpointUrl(source.baseUrl, '/api/v1/search', plan.params);
        const res = await fetchText(fetchFn, url, { headers: headers(source.apiKey) }, timeLeft());
        if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
        const body = parseJson(res.text);
        if (!Array.isArray(body)) throw new SourceError('réponse inattendue (liste de résultats attendue)');
        const latencyMs = Date.now() - started;
        for (const indexer of plan.indexers) health.record(source.name, indexer.id, { ok: true, latencyMs });
        return body.filter(isRecord).flatMap((raw) => {
          const stream = toRawStream(raw, indexerNameOf(raw, names, source.name));
          return stream === undefined ? [] : [stream];
        });
      } catch (err) {
        const error = describeFailure(err, source.apiKey);
        const latencyMs = Date.now() - started;
        for (const indexer of plan.indexers) health.record(source.name, indexer.id, { ok: false, latencyMs, error });
        throw err;
      }
    };

    const settled = await Promise.allSettled(plans.map(run));
    const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (rejected.length === settled.length) throw rejected[0]?.reason;
    return settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}
