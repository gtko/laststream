import { createHash } from 'node:crypto';
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
import {
  MAX_PARALLEL_QUERIES,
  mapBounded,
  mergeRequestResults,
  releaseAliases,
  type Candidate,
} from './query-merge.js';
import { buildQueries, filterByYear, idQueryOf, variantsFor, type TitleVariants } from './query-titles.js';

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
  /** Titres et année : une requête texte par variante (prime sur titleInfo). */
  titles?: TitleVariants;
  /** Numéro absolu de l'épisode (anime, remappage Fribb) : ajoute « Titre 05 » et « Titre - 05 » en requêtes texte. */
  absolute?: number;
  /** Budget global de la recherche (découverte + requêtes), en millisecondes. */
  budgetMs?: number;
  health?: IndexerHealth;
}

/** Budget global par défaut d'une recherche Prowlarr (découverte et requêtes), en millisecondes. */
export const PROWLARR_BUDGET_MS = 14_000;
/** Durée de vie, en mémoire, de la liste des indexeurs d'une source : 10 minutes. */
export const PROWLARR_DISCOVERY_TTL_MS = 10 * 60 * 1_000;

interface DiscoveryEntry {
  expiresAt: number;
  indexers: IndexerInfo[];
}

/** Indexeurs découverts, par source (URL et empreinte SHA-256 de la clé : jamais la clé). Réussites seulement. */
const discoveryCache = new Map<string, DiscoveryEntry>();

/** Vide le cache de découverte (tests, ou indexeurs modifiés à chaud). */
export function clearProwlarrDiscoveryCache(): void {
  discoveryCache.clear();
}

function discoveryKey(source: ProwlarrSource): string {
  return `${source.baseUrl}\u0000${createHash('sha256').update(source.apiKey).digest('hex')}`;
}

/** Indexeurs de la source depuis le cache, sinon découverte puis mise en cache. Un échec n'est jamais mis en cache. */
async function discoverCached(source: ProwlarrSource, fetchFn: FetchFn, timeoutMs: number): Promise<IndexerInfo[]> {
  const key = discoveryKey(source);
  const now = Date.now();
  const hit = discoveryCache.get(key);
  if (hit !== undefined && hit.expiresAt > now) return hit.indexers;
  const indexers = await listIndexers(source, fetchFn, timeoutMs);
  for (const [stored, entry] of discoveryCache) {
    if (entry.expiresAt <= now) discoveryCache.delete(stored);
  }
  discoveryCache.set(key, { expiresAt: now + PROWLARR_DISCOVERY_TTL_MS, indexers });
  return indexers;
}

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

/** Paramètres communs à une requête : type, indexeurs restreints, catégories. */
function baseParams(ref: ContentRef, indexers: IndexerInfo[], categories: readonly number[]): URLSearchParams {
  const params = new URLSearchParams();
  params.set('type', ref.type === 'movie' ? 'movie' : 'tvsearch');
  for (const indexer of indexers) params.append('indexerIds', String(indexer.id));
  for (const category of categories) params.append('categories', String(category));
  return params;
}

/** Titre d'ancrage d'une requête par identifiant, et identifiant TVDB d'une série (si connu). */
interface IdAnchor {
  title: string;
  tvdbId?: number;
}

/**
 * Regroupe les indexeurs par capacité : ceux qui acceptent l'identifiant IMDb reçoivent une requête par id, les
 * autres une requête texte par variante de titre (si des titres sont connus). Un indexeur ne figure que dans un groupe.
 * La requête par id porte aussi le titre (`query`) : mesuré, Prowlarr ignore imdbId/tvdbId seuls et renvoie la liste
 * générale des indexeurs. Sans titre d'ancrage, il n'y a donc pas de requête par id.
 */
function planSearches(
  indexers: IndexerInfo[],
  ref: ContentRef,
  categories: readonly number[],
  queries: readonly string[],
  anchor: IdAnchor | undefined,
): PlannedSearch[] {
  const byId = indexers.filter((indexer) => idCapable(indexer, ref));
  const byText = indexers.filter((indexer) => !idCapable(indexer, ref));
  const plans: PlannedSearch[] = [];

  if (byId.length > 0 && anchor !== undefined) {
    const params = baseParams(ref, byId, categories);
    params.set('query', anchor.title);
    params.set('imdbId', ref.imdbId.replace(/^tt/i, ''));
    if (ref.type === 'series') {
      if (anchor.tvdbId !== undefined) params.set('tvdbId', String(anchor.tvdbId));
      if (ref.season !== undefined) params.set('season', String(ref.season));
      if (ref.episode !== undefined) params.set('episode', String(ref.episode));
    }
    plans.push({ indexers: byId, params });
  }
  // Requêtes texte : packs et intégrale vont à tous les indexeurs (rapides partout, y compris chez ceux qui acceptent
  // l'id). La requête d'épisode exact « Titre SxxEyy », lente chez certains indexeurs (2 à 4 s), reste réservée aux
  // indexeurs sans id : la requête par id porte déjà la saison et l'épisode.
  const episodeTag = ref.type === 'series' && ref.season !== undefined && ref.episode !== undefined ? episodeTagOf(ref) : undefined;
  for (const query of queries) {
    const isEpisode = episodeTag !== undefined && query.toUpperCase().endsWith(episodeTag);
    const targets = isEpisode ? byText : indexers;
    if (targets.length === 0) continue;
    const params = baseParams(ref, targets, categories);
    params.set('query', query);
    plans.push({ indexers: targets, params });
  }
  return plans;
}

/**
 * Requêtes d'un épisode d'anime par numéro absolu : « Titre 05 » et « Titre - 05 » (releases étiquetées ainsi). Sans
 * numéro absolu, sans titre ou pour un film : aucune. En tête des requêtes : elles sont rapides.
 */
function absoluteQueriesOf(ref: ContentRef, title: string | undefined, absolute: number | undefined): string[] {
  if (ref.type !== 'series' || title === undefined || absolute === undefined || !(absolute >= 1)) return [];
  const number = String(absolute).padStart(2, '0');
  return [`${title} ${number}`, `${title} - ${number}`];
}

/** Marque d'épisode exact d'une série, « S04E04 » (deux chiffres par défaut, comme les requêtes de query-titles). */
function episodeTagOf(ref: ContentRef): string {
  const pad = (value: number | undefined): string => String(value ?? 0).padStart(2, '0');
  return `S${pad(ref.season)}E${pad(ref.episode)}`;
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

/** URL http(s) valide, sinon undefined. La valeur n'est jamais recopiée dans un message d'erreur. */
function httpUrlOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Base32 ou hex accepté. Un release retient son infoHash ou son magnet. Sans l'un ni l'autre, un lien .torrent
 * HTTP(S) (downloadUrl) et son guid sont gardés en mémoire seulement, pour lecture par torrent/enrich.ts.
 * Sinon le release est ignoré.
 */
function toRawStream(raw: Record<string, unknown>, indexerName: string): RawStream | undefined {
  const protocol = optionalString(raw.protocol);
  if (protocol !== undefined && protocol.toLowerCase() !== 'torrent') return undefined;

  // downloadUrl magnet : retenu comme magnet. Un lien .torrent HTTP porte souvent la clé de l'indexeur : voir plus bas.
  const downloadUrl = optionalString(raw.downloadUrl);
  const magnet = [optionalString(raw.magnetUrl), downloadUrl].find(isMagnet);
  const infoHash = normalizeInfoHash(raw.infoHash) ?? infoHashFromMagnet(magnet);
  const torrentUrl = infoHash === undefined && magnet === undefined ? httpUrlOf(downloadUrl) : undefined;
  if (infoHash === undefined && magnet === undefined && torrentUrl === undefined) return undefined;

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
  if (torrentUrl !== undefined) {
    // Secret (passkey possible) : en mémoire seulement, jamais dans une réponse. Voir RawStream.downloadUrl.
    stream.downloadUrl = torrentUrl;
    const guid = optionalString(raw.guid);
    if (guid !== undefined) stream.guid = guid;
  }
  return stream;
}

/** Nom de l'indexeur d'un release : champ `indexer`, à défaut le nom connu pour son identifiant. */
function indexerNameOf(raw: Record<string, unknown>, names: ReadonlyMap<string, string>, fallback: string): string {
  return optionalString(raw.indexer) ?? names.get(String(raw.indexerId)) ?? fallback;
}

/**
 * Recherche Prowlarr (GET /api/v1/search) sur les indexeurs torrent retenus.
 * Les indexeurs sont regroupés par capacité (id IMDb ou texte) ; chaque groupe est une requête, et chaque variante de
 * titre ajoute une requête texte. Au plus MAX_PARALLEL_QUERIES requêtes à la fois. Un groupe en échec n'empêche pas les
 * autres (santé mise à jour par indexeur). Budget global : chaque requête ne dépasse pas le temps restant, et une
 * requête qui n'a pas pu partir avant l'échéance est écartée sans pénalité. La liste des indexeurs vient du cache
 * (10 min). Lève une SourceError sûre seulement si la découverte échoue ou si tous les groupes échouent.
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
    const discovered = await discoverCached(source, fetchFn, timeLeft());
    const variants = variantsFor(opts);
    const title = variants === undefined ? undefined : idQueryOf(variants);
    const absoluteQueries = absoluteQueriesOf(ref, title, opts.absolute);
    const queries = variants === undefined ? [] : [...absoluteQueries, ...buildQueries(variants, ref)];
    const anchor: IdAnchor | undefined =
      title === undefined ? undefined : { title, tvdbId: ref.type === 'series' ? variants?.tvdbId : undefined };
    const plans = planSearches(
      selectIndexers(discovered, source.indexerIds),
      ref,
      categoriesFor(source, ref),
      queries,
      anchor,
    );
    if (plans.length === 0) return [];

    const names = new Map(discovered.map((indexer) => [String(indexer.id), indexer.name]));
    const run = async (plan: PlannedSearch): Promise<Candidate[]> => {
      // Budget épuisé avant l'envoi : la requête n'part pas, et l'indexeur n'est pas pénalisé dans la santé.
      if (deadline <= Date.now()) throw new SourceError(`délai dépassé (${budgetMs} ms)`);
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
          return stream === undefined ? [] : [{ stream, aliases: releaseAliases(stream.guid, stream.downloadUrl) }];
        });
      } catch (err) {
        const error = describeFailure(err, source.apiKey);
        const latencyMs = Date.now() - started;
        for (const indexer of plan.indexers) health.record(source.name, indexer.id, { ok: false, latencyMs, error });
        throw err;
      }
    };

    // Requêtes en parallèle, au plus MAX_PARALLEL_QUERIES à la fois (mesuré : au-delà, chaque requête ralentit
    // nettement côté Prowlarr) ; résultats fusionnés sans doublon, filtrés sur l'année.
    const settled = await mapBounded(plans, MAX_PARALLEL_QUERIES, run);
    const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (rejected.length === settled.length) throw rejected[0]?.reason;
    const batches = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    return filterByYear(mergeRequestResults(batches), ref, variants);
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}
