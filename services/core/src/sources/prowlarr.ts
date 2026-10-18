import { runtimeEnv } from '../platform/index.js';
import { createHash } from 'node:crypto';
import type { ContentRef, RawStream } from '../types.js';
import { defaultIndexerHealth, type IndexerHealth } from './indexer-health.js';
import {
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
import { mergeRequestResults, releaseAliases, type Candidate } from './query-merge.js';
import {
  buildQueries,
  filterByYear,
  idQueryOf,
  stripAccents,
  stripPunctuation,
  variantsFor,
  type TitleVariants,
} from './query-titles.js';

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
  /** Budget dur d'une recherche par indexeur (requêtes comprises), en millisecondes. Défaut : PROWLARR_BUDGET_MS. */
  budgetMs?: number;
  /**
   * Échéance douce, en millisecondes : passé ce délai, la recherche rend ce qui est arrivé et les indexeurs lents
   * continuent en arrière-plan (`pending`, `done`). Absent : on attend tous les indexeurs, dans le budget dur.
   */
  softMs?: number;
  /** Reprend les recherches échouées dans les dernières 60 s au lieu de les relancer (recalcul après un résultat partiel). */
  reuseFailed?: boolean;
  health?: IndexerHealth;
}

/** Résultat d'une recherche à échéance douce : ce qui est arrivé, les indexeurs encore en cours, et la suite. */
export interface ProwlarrOutcome {
  streams: RawStream[];
  /** Noms des indexeurs dont la première réponse n'est pas arrivée (ils continuent en arrière-plan). */
  pending: string[];
  /** Vrai si des recherches (retardataires ou compléments) tournent encore : `done` apportera des flux de plus. */
  busy: boolean;
  /** Se résout quand tous les indexeurs ont répondu ou échoué (budget dur compris) : tous les flux, sans jamais rejeter. */
  done: Promise<RawStream[]>;
}

/** Budget dur par défaut d'une recherche Prowlarr par indexeur (découverte exclue), en millisecondes. */
export const PROWLARR_BUDGET_MS = 25_000;
/** Échéance douce par défaut (réponse partielle), en millisecondes. */
export const PROWLARR_SOFT_MS = 4_000;
/** Délai d'une requête de recherche : un indexeur privé lent (mesuré : 13 s) doit pouvoir répondre. */
export const PROWLARR_REQUEST_TIMEOUT_MS = 20_000;
/** Requêtes de recherche simultanées vers Prowlarr, tous indexeurs confondus. */
export const MAX_PARALLEL_REQUESTS = 10;
/** Requêtes au plus par indexeur dans le cœur, puis dans les compléments. */
const WAVE1_MAX = 3;
const WAVE2_MAX = 3;
/** Un indexeur est « lent » si sa latence moyenne dépasse l'échéance douce, après au moins ce nombre de mesures. */
const SLOW_MIN_SAMPLES = 1;
/** Durée de vie, en mémoire, des résultats d'un indexeur : 5 minutes (comme le cache des résultats). */
export const PROWLARR_TASK_TTL_MS = 5 * 60 * 1_000;
/** Un indexeur en échec n'est pas réinterrogé pendant ce délai pour la même recherche (le recalcul complet le reprendrait). */
const PROWLARR_FAILED_TASK_TTL_MS = 60 * 1_000;
const MAX_TASKS = 500;
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
  taskCache.clear();
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

/** Paramètres communs à une requête : type, indexeur restreint, catégories. */
function baseParams(ref: ContentRef, indexer: IndexerInfo, categories: readonly number[]): URLSearchParams {
  const params = new URLSearchParams();
  params.set('type', ref.type === 'movie' ? 'movie' : 'tvsearch');
  params.append('indexerIds', String(indexer.id));
  for (const category of categories) params.append('categories', String(category));
  return params;
}

/** Titre d'ancrage d'une requête par identifiant, et identifiant TVDB d'une série (si connu). */
interface IdAnchor {
  title: string;
  tvdbId?: number;
}

/** Requêtes texte d'une recherche, triées par rôle. */
interface QuerySets {
  /** Requêtes de numéro absolu (anime) : rapides, envoyées partout. */
  absolute: string[];
  /** Packs de saison (« Titre S04 », « Titre Saison 4 ») ou, pour un film, titre sans puis avec année. */
  primary: string[];
  /** Épisode exact « Titre S04E04 » : seulement pour les indexeurs sans id. */
  episode: string[];
  /** Intégrale (« Intégrale », « complete ») : indexeurs sans id, ou en seconde vague si l'id n'a rien rendu. */
  integrale: string[];
  /** Autres formes (accents, ponctuation retirés) : dernier recours. */
  folds: string[];
}

const INTEGRALE_TAIL = /\b(?:int[eé]grale|complete)$/i;

/** Clé de déduplication : deux requêtes qui ne diffèrent que par la casse, les accents ou la ponctuation sont identiques. */
function normalizedQuery(query: string): string {
  return stripPunctuation(stripAccents(query)).toLowerCase();
}

/**
 * Classe les requêtes. Une requête identique à une précédente (casse près) est ignorée ; celle qui n'en diffère que par
 * les accents ou la ponctuation va en dernier recours. Les requêtes de numéro absolu viennent en tête.
 */
function classifyQueries(queries: readonly string[], absolute: readonly string[], ref: ContentRef): QuerySets {
  const sets: QuerySets = { absolute: [...absolute], primary: [], episode: [], integrale: [], folds: [] };
  const seen = new Set<string>(absolute.map(normalizedQuery));
  const exact = new Set<string>(absolute.map((query) => query.toLowerCase()));
  const episodeTag = ref.type === 'series' && ref.season !== undefined && ref.episode !== undefined ? episodeTagOf(ref) : undefined;
  for (const query of queries) {
    if (exact.has(query.toLowerCase())) continue;
    exact.add(query.toLowerCase());
    const key = normalizedQuery(query);
    if (seen.has(key)) {
      sets.folds.push(query);
      continue;
    }
    seen.add(key);
    if (episodeTag !== undefined && query.toUpperCase().endsWith(episodeTag)) sets.episode.push(query);
    else if (ref.type === 'series' && INTEGRALE_TAIL.test(query)) sets.integrale.push(query);
    else sets.primary.push(query);
  }
  return sets;
}

/** Condition d'envoi d'une requête de la seconde vague. */
type WaveCondition = 'always' | 'unlessId' | 'ifEmpty';

interface ExtraRequest {
  params: URLSearchParams;
  when: WaveCondition;
}

/**
 * Requêtes d'un indexeur. Première vague (« cœur », en parallèle) : l'essentiel, de quoi répondre vite. Seconde vague
 * (« compléments »), après le cœur : variantes qui élargissent le résultat sans retarder la réponse. Mesuré : Prowlarr
 * espace d'environ 2 s les requêtes successives d'un même indexeur, chaque requête de plus coûte donc ce temps.
 */
interface IndexerPlan {
  indexer: IndexerInfo;
  /** Vrai si la première requête du cœur est la requête par id. */
  byId: boolean;
  core: URLSearchParams[];
  extras: ExtraRequest[];
}

/**
 * Plan d'un indexeur. Ceux qui acceptent l'identifiant IMDb reçoivent une requête par id (ancrée sur le titre : mesuré,
 * Prowlarr ignore imdbId/tvdbId seuls) ; les autres, une requête texte.
 * Film : cœur = la requête par id, ou le titre ; compléments (si le cœur n'a rien rendu) = autres titres et formes.
 * Série : cœur = id (si accepté) + pack « Titre SNN », ou pack + épisode exact « Titre SNNENN » sans id ; compléments =
 * « Saison N » toujours, intégrale sauf si l'id a déjà répondu, puis (si rien n'est venu) « complete » et les formes
 * sans accents. L'épisode exact n'est jamais tenté chez un indexeur avec id : la requête par id porte déjà l'épisode.
 */
function planIndexer(
  indexer: IndexerInfo,
  ref: ContentRef,
  categories: readonly number[],
  sets: QuerySets,
  anchor: IdAnchor | undefined,
): IndexerPlan {
  const byId = idCapable(indexer, ref) && anchor !== undefined;
  const text = (query: string): URLSearchParams => {
    const params = baseParams(ref, indexer, categories);
    params.set('query', query);
    return params;
  };
  const core: URLSearchParams[] = [];
  if (byId && anchor !== undefined) {
    const params = baseParams(ref, indexer, categories);
    params.set('query', anchor.title);
    params.set('imdbId', ref.imdbId.replace(/^tt/i, ''));
    if (ref.type === 'series') {
      if (anchor.tvdbId !== undefined) params.set('tvdbId', String(anchor.tvdbId));
      if (ref.season !== undefined) params.set('season', String(ref.season));
      if (ref.episode !== undefined) params.set('episode', String(ref.episode));
    }
    core.push(params);
  }
  const coreQueries: string[] = sets.absolute.slice(0, 1);
  const extras: ExtraRequest[] = sets.absolute.slice(1).map((query) => ({ params: text(query), when: 'always' }));
  if (ref.type === 'movie') {
    if (!byId) coreQueries.push(...sets.primary.slice(0, 1));
    const rest = [...sets.primary.slice(byId ? 0 : 1), ...sets.folds];
    extras.push(...rest.map((query): ExtraRequest => ({ params: text(query), when: 'ifEmpty' })));
  } else {
    coreQueries.push(...sets.primary.slice(0, 1));
    if (!byId) coreQueries.push(...sets.episode.slice(0, 1));
    extras.push(...sets.primary.slice(1).map((query): ExtraRequest => ({ params: text(query), when: 'always' })));
    extras.push(...sets.integrale.slice(0, 1).map((query): ExtraRequest => ({ params: text(query), when: 'unlessId' })));
    extras.push(
      ...[...sets.integrale.slice(1), ...sets.folds].map((query): ExtraRequest => ({ params: text(query), when: 'ifEmpty' })),
    );
  }
  core.push(...coreQueries.map(text));
  return { indexer, byId, core: core.slice(0, WAVE1_MAX), extras };
}

/** Plan allégé d'un indexeur lent : chaque requête lui coûte plusieurs secondes, on n'en garde que l'essentiel. */
function slimPlan(plan: IndexerPlan): IndexerPlan {
  return { ...plan, core: plan.core.slice(0, 1), extras: plan.extras.slice(0, 1) };
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

/** Limiteur de requêtes simultanées (file FIFO) : les indexeurs lents, démarrés en premier, passent avant les autres. */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    }
  }
}

const requestLimiter = new Limiter(MAX_PARALLEL_REQUESTS);

/** Recherche d'un indexeur, en cours ou terminée : partagée entre les appels (dédoublonnage et cache de 5 minutes). */
interface IndexerTask {
  indexer: IndexerInfo;
  /** Résultat de chaque requête (cœur puis compléments), à son rang ; rempli au fil de l'eau. */
  slots: (Candidate[] | undefined)[];
  /** Vrai quand le cœur (première vague) est terminé. */
  coreSettled: boolean;
  /** Vrai quand tout est terminé (compléments compris). */
  settled: boolean;
  expiresAt: number;
  /** Erreur si le cœur a échoué en entier. */
  error?: unknown;
  /** Se résout (jamais ne rejette) quand le cœur est terminé. */
  core: Promise<void>;
  /** Se résout (jamais ne rejette) quand tout est terminé. */
  done: Promise<void>;
}

/** Recherches par indexeur, clé = source, indexeur et requêtes : un second appel réutilise la recherche en cours. */
const taskCache = new Map<string, IndexerTask>();

function taskKey(source: ProwlarrSource, plan: IndexerPlan): string {
  const requests = [...plan.core, ...plan.extras.map((extra) => extra.params)].map((params) => params.toString()).join('\n');
  return `${discoveryKey(source)}\u0000${plan.indexer.id}\u0000${createHash('sha256').update(requests).digest('hex')}`;
}

function pruneTasks(now: number): void {
  for (const [key, task] of taskCache) {
    if (task.settled && task.expiresAt <= now) taskCache.delete(key);
  }
  while (taskCache.size > MAX_TASKS) {
    const oldest = taskCache.keys().next().value;
    if (oldest === undefined) return;
    taskCache.delete(oldest);
  }
}

/** Contexte d'exécution partagé par les requêtes d'une recherche. */
interface RunContext {
  source: ProwlarrSource;
  fetchFn: FetchFn;
  health: IndexerHealth;
  names: ReadonlyMap<string, string>;
  requestTimeoutMs: number;
  budgetMs: number;
  /** Reprend les recherches échouées récemment au lieu de les relancer (recalcul en arrière-plan). */
  reuseFailed: boolean;
}

/** Une requête de recherche vers un indexeur ; la santé de l'indexeur est mise à jour, la clé n'est jamais journalisée. */
async function requestOnce(
  run: RunContext,
  indexer: IndexerInfo,
  params: URLSearchParams,
  deadline: number,
): Promise<Candidate[]> {
  const { source, health } = run;
  return requestLimiter.run(async () => {
    const remaining = deadline - Date.now();
    // Budget épuisé avant l'envoi : la requête n'part pas, et l'indexeur n'est pas pénalisé dans la santé.
    if (remaining <= 0) throw new SourceError(`délai dépassé (${run.budgetMs} ms)`);
    const timeoutMs = Math.min(run.requestTimeoutMs, Math.ceil(remaining));
    const started = Date.now();
    try {
      const url = endpointUrl(source.baseUrl, '/api/v1/search', params);
      const res = await fetchText(run.fetchFn, url, { headers: headers(source.apiKey) }, timeoutMs);
      if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
      const body = parseJson(res.text);
      if (!Array.isArray(body)) throw new SourceError('réponse inattendue (liste de résultats attendue)');
      health.record(source.name, indexer.id, { ok: true, latencyMs: Date.now() - started });
      if (runtimeEnv().get('LASTADDON_DEBUG') === '1') {
        console.debug(`[prowlarr] ${indexer.name} ${Date.now() - started} ms n=${body.length} q=${params.get('query') ?? ''}${params.has('imdbId') ? ' (id)' : ''}`);
      }
      return body.filter(isRecord).flatMap((raw) => {
        const stream = toRawStream(raw, indexerNameOf(raw, run.names, source.name));
        return stream === undefined ? [] : [{ stream, aliases: releaseAliases(stream.guid, stream.downloadUrl) }];
      });
    } catch (err) {
      const error = describeFailure(err, source.apiKey);
      health.record(source.name, indexer.id, { ok: false, latencyMs: Date.now() - started, error });
      throw err;
    }
  });
}

/** Requêtes envoyées en parallèle ; chaque résultat est rangé à son rang dès qu'il arrive. Renvoie les échecs. */
async function sendAll(
  run: RunContext,
  task: IndexerTask,
  requests: readonly { params: URLSearchParams; slot: number }[],
  deadline: number,
): Promise<PromiseRejectedResult[]> {
  const settled = await Promise.allSettled(
    requests.map(async ({ params, slot }) => {
      task.slots[slot] = await requestOnce(run, task.indexer, params, deadline);
    }),
  );
  return settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
}

const hasResults = (task: IndexerTask, from = 0, to = task.slots.length): boolean =>
  task.slots.slice(from, to).some((batch) => batch !== undefined && batch.length > 0);

/** Recherche d'un indexeur : le cœur, puis les compléments (selon leur condition). Lève si tout le cœur a échoué. */
async function searchIndexer(run: RunContext, plan: IndexerPlan, task: IndexerTask, coreDone: () => void): Promise<void> {
  const deadline = Date.now() + run.budgetMs;
  const coreCount = plan.core.length;
  const failures = await sendAll(run, task, plan.core.map((params, slot) => ({ params, slot })), deadline);
  coreDone();
  if (failures.length === coreCount) throw failures[0]?.reason;

  const idAnswered = plan.byId && hasResults(task, 0, 1);
  const anyResult = hasResults(task);
  const wanted = plan.extras
    .map((extra, index) => ({ extra, slot: coreCount + index }))
    .filter(({ extra }) => extra.when === 'always' || (extra.when === 'unlessId' ? !idAnswered : !anyResult))
    .slice(0, WAVE2_MAX);
  if (wanted.length === 0) return;
  // Les compléments sont facultatifs : leur échec ne retire rien au cœur.
  await sendAll(run, task, wanted.map(({ extra, slot }) => ({ params: extra.params, slot })), deadline);
}

/** Démarre (ou reprend) la recherche d'un indexeur. */
function taskFor(run: RunContext, plan: IndexerPlan, slow: boolean): IndexerTask {
  const key = taskKey(run.source, plan);
  const now = Date.now();
  const existing = taskCache.get(key);
  if (existing !== undefined && (!existing.settled || (existing.expiresAt > now && (existing.error === undefined || run.reuseFailed)))) {
    return existing;
  }
  pruneTasks(now);
  let coreDone: () => void = () => undefined;
  const core = new Promise<void>((resolve) => {
    coreDone = resolve;
  });
  const task: IndexerTask = {
    indexer: plan.indexer,
    slots: [],
    coreSettled: false,
    settled: false,
    expiresAt: 0,
    core,
    done: Promise.resolve(),
  };
  const markCore = (): void => {
    task.coreSettled = true;
    coreDone();
  };
  task.done = searchIndexer(run, slow ? slimPlan(plan) : plan, task, markCore).then(
    () => {
      task.expiresAt = Date.now() + PROWLARR_TASK_TTL_MS;
      task.settled = true;
      markCore();
    },
    (error: unknown) => {
      task.error = error;
      task.expiresAt = Date.now() + PROWLARR_FAILED_TASK_TTL_MS;
      task.settled = true;
      markCore();
    },
  );
  taskCache.set(key, task);
  return task;
}

/** Attend `promise` au plus `ms` millisecondes (le minuteur est toujours libéré). */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  try {
    await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function streamsOf(tasks: readonly IndexerTask[], ref: ContentRef, variants: TitleVariants | undefined): RawStream[] {
  const batches = tasks.flatMap((task) => task.slots.filter((batch): batch is Candidate[] => batch !== undefined));
  return filterByYear(mergeRequestResults(batches), ref, variants);
}

/**
 * Recherche Prowlarr (GET /api/v1/search) sur les indexeurs torrent retenus, une requête par indexeur
 * (`indexerIds=<id>`) : tous les indexeurs partent en parallèle, les plus lents (latence moyenne au-dessus de
 * l'échéance douce) en premier et avec moins de requêtes. Chaque indexeur fait d'abord son « cœur » (une ou deux
 * requêtes), puis des compléments (variantes de titre, « Saison N », intégrale) qui n'ajoutent rien à l'attente.
 * Au plus MAX_PARALLEL_REQUESTS requêtes à la fois.
 *
 * Échéance douce (`softMs`) : la recherche rend ce qui est arrivé dès que le cœur des indexeurs rapides est terminé,
 * ou à l'échéance. `pending` nomme les indexeurs dont le cœur n'est pas terminé ; ils continuent en arrière-plan, avec
 * les compléments, et leurs résultats restent en mémoire 5 minutes (`done`, et reprise de la même recherche). Si rien
 * n'est arrivé, l'attente se prolonge jusqu'au premier résultat (au plus une échéance de plus). Les indexeurs lents ne
 * retardent pas la réponse. Sans `softMs`, la recherche attend tout, dans le budget dur (`budgetMs`).
 *
 * Lève une SourceError sûre seulement si la découverte échoue ou si tous les indexeurs échouent.
 */
export async function searchProwlarrDetailed(
  source: ProwlarrSource,
  ref: ContentRef,
  opts: ProwlarrSearchOptions = {},
): Promise<ProwlarrOutcome> {
  const { fetchFn } = resolveOptions(opts);
  const budgetMs = opts.budgetMs ?? PROWLARR_BUDGET_MS;
  const health = opts.health ?? defaultIndexerHealth;

  try {
    const discovered = await discoverCached(source, fetchFn, Math.min(opts.timeoutMs ?? PROWLARR_REQUEST_TIMEOUT_MS, budgetMs));
    const variants = variantsFor(opts);
    const title = variants === undefined ? undefined : idQueryOf(variants);
    const absoluteQueries = absoluteQueriesOf(ref, title, opts.absolute);
    const queries = variants === undefined ? [] : buildQueries(variants, ref);
    const anchor: IdAnchor | undefined =
      title === undefined ? undefined : { title, tvdbId: ref.type === 'series' ? variants?.tvdbId : undefined };
    const sets = classifyQueries(queries, absoluteQueries, ref);
    const categories = categoriesFor(source, ref);
    const plans = selectIndexers(discovered, source.indexerIds)
      .map((indexer) => planIndexer(indexer, ref, categories, sets, anchor))
      .filter((plan) => plan.core.length > 0);
    if (plans.length === 0) return { streams: [], pending: [], busy: false, done: Promise.resolve([]) };

    const softMs = opts.softMs;
    const run: RunContext = {
      source,
      fetchFn,
      health,
      names: new Map(discovered.map((indexer) => [String(indexer.id), indexer.name])),
      requestTimeoutMs: opts.timeoutMs ?? PROWLARR_REQUEST_TIMEOUT_MS,
      budgetMs,
      reuseFailed: opts.reuseFailed === true,
    };
    // Lents d'abord (ils prennent les premiers créneaux et démarrent tôt) ; l'ordre des résultats reste celui des plans.
    const slowThreshold = softMs ?? PROWLARR_SOFT_MS;
    const ewmaOf = (plan: IndexerPlan): number | undefined => health.ewma(source.name, plan.indexer.id);
    const isSlow = (plan: IndexerPlan): boolean => {
      const ewma = ewmaOf(plan);
      return ewma !== undefined && ewma > slowThreshold && (health.get(source.name, plan.indexer.id)?.count ?? 0) >= SLOW_MIN_SAMPLES;
    };
    const slowFlags = new Map(plans.map((plan) => [plan, isSlow(plan)]));
    const startOrder = [...plans].sort(
      (a, b) => Number(slowFlags.get(b)) - Number(slowFlags.get(a)) || (ewmaOf(b) ?? 0) - (ewmaOf(a) ?? 0),
    );
    const started = new Map(startOrder.map((plan) => [plan, taskFor(run, plan, slowFlags.get(plan) === true)]));
    const tasks = plans.map((plan) => started.get(plan)).filter((task): task is IndexerTask => task !== undefined);
    const fastTasks = plans
      .filter((plan) => slowFlags.get(plan) !== true)
      .map((plan) => started.get(plan))
      .filter((task): task is IndexerTask => task !== undefined);

    const allDone = Promise.all(tasks.map((task) => task.done));
    const done = allDone.then(() => streamsOf(tasks, ref, variants));
    const pendingCores = (): IndexerTask[] => tasks.filter((task) => !task.coreSettled);
    const hasStreams = (): boolean => tasks.some((task) => task.slots.some((batch) => batch !== undefined && batch.length > 0));

    if (softMs === undefined) {
      await allDone;
    } else {
      const begun = Date.now();
      await waitAtMost(Promise.all(fastTasks.map((task) => task.core)), softMs);
      // Rien d'arrivé : attendre le premier résultat plutôt que de répondre vide (au plus une échéance de plus).
      const graceEnd = begun + 2 * softMs;
      while (!hasStreams() && pendingCores().length > 0 && Date.now() < graceEnd) {
        await waitAtMost(Promise.race(pendingCores().map((task) => task.core)), graceEnd - Date.now());
      }
    }

    const pending = pendingCores();
    const busy = tasks.some((task) => !task.settled);
    if (!busy && tasks.every((task) => task.error !== undefined)) throw tasks[0]?.error;
    return { streams: streamsOf(tasks, ref, variants), pending: pending.map((task) => task.indexer.name), busy, done };
  } catch (err) {
    throw sourceFailure(source.name, err);
  }
}

/** Recherche Prowlarr qui attend tous les indexeurs (ou le budget dur) : voir searchProwlarrDetailed. */
export async function searchProwlarr(
  source: ProwlarrSource,
  ref: ContentRef,
  opts: ProwlarrSearchOptions = {},
): Promise<RawStream[]> {
  return (await searchProwlarrDetailed(source, ref, opts)).streams;
}
