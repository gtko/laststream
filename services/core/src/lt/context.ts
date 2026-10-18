import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Dispatcher } from 'undici';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import {
  type BodyOptions,
  type BytesResult,
  createPinnedAgent,
  fetchBytes,
  type FetchFn,
  isRecord,
  SourceError,
  SourceTooLargeError,
  type UrlGuard,
} from '../sources/http.js';
import { UnsafeTargetError, createPublicGuard } from './guard.js';
import { createUrlSigner, type UrlSigner } from './signing.js';

/**
 * Durées de vie du cache. Les métadonnées publiques sont partagées entre tous les utilisateurs (économie de
 * requêtes amont) ; seules les recommandations dépendent de la charge utile de la requête.
 */
export const TTL = {
  tmdb: 6 * 3600e3, // détails et listes
  tmdbFast: 3 * 3600e3, // tendances et populaires
  tmdbWatch: 12 * 3600e3, // fournisseurs de streaming
  mdb: 24 * 3600e3, // notes MDBList
  tvdb: 12 * 3600e3, // saisons TVDB
  episodes: 12 * 3600e3, // structure saisons et épisodes (TMDB, groupes TMDB, TVDB)
  aiRecommend: 30 * 60e3, // recommandations (par charge utile)
  aiText: 7 * 24 * 3600e3, // « pourquoi » (par identifiant de titre ou de personne)
  tvChannels: 12 * 3600e3, // catalogue TV (sources amont)
  tvPartial: 15 * 60e3, // catalogue incomplet (une source a échoué) : nouvel essai plus tôt
  tvEpg: 3 * 3600e3, // programmes EPG
  skip: 7 * 24 * 3600e3, // segments intro/recap/crédits trouvés
  skipEmpty: 6 * 3600e3, // aucun segment trouvé (à revérifier plus tôt)
} as const;

/** Délai de cache négatif : une 404 amont est mémorisée brièvement ; aucune autre erreur n'est mise en cache. */
export const NEGATIVE_TTL_MS = 60e3;

/** Délai par défaut des appels vers les services (ms). */
export const SERVICE_TIMEOUT_MS = 12000;
/** Plafond du cache : nombre d'entrées, et taille totale approchée (octets). */
export const CACHE_MAX_ENTRIES = 10_000;
export const CACHE_MAX_BYTES = 100 * 1024 * 1024;
/** Taille comptée pour une entrée négative (erreur mémorisée). */
const NEGATIVE_BYTES = 256;

/** Erreur HTTP de la couche lt : statut, code stable, et service concerné si pertinent. Jamais de clé. */
export class LtError extends Error {
  readonly status: number;
  readonly code: string;
  readonly service: string | undefined;

  constructor(status: number, code: string, service?: string) {
    super(code);
    this.name = 'LtError';
    this.status = status;
    this.code = code;
    this.service = service;
  }
}

/** Empreinte SHA-256 (hex) d'une valeur JSON : sert de clé de cache, jamais de clé secrète en clair. */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Empreinte courte d'une clé API. Ne sert jamais aux clés de cache (partagées) : seulement à indexer les sessions
 * d'authentification TVDB, qui sont propres à une clé.
 */
export function keyDigest(key: string): string {
  return digest(key).slice(0, 16);
}

/** Taille approchée d'une valeur de cache en octets (JSON ; les Map sont sérialisées comme des objets). */
function approximateBytes(value: unknown): number {
  const json = JSON.stringify(value, (_key, item: unknown) => (item instanceof Map ? Object.fromEntries(item) : item)) as
    | string
    | undefined;
  return Buffer.byteLength(json ?? '', 'utf8');
}

/** Erreur amont 404 : la seule erreur mise en cache, brièvement (cache négatif). */
function isNegative(err: unknown): boolean {
  return err instanceof LtError && err.code === 'upstream_404';
}

interface CacheEntry {
  exp: number;
  bytes: number;
  value?: unknown;
  failure?: unknown;
}

/**
 * Cache mémoire à durée fixe, borné en entrées et en octets. Éviction LRU : une lecture déplace l'entrée en fin de
 * file, les plus anciennes partent les premières (les expirées d'abord). Les requêtes identiques en cours sont
 * dédoublonnées. Les erreurs ne sont pas mises en cache, sauf une 404 amont (cache négatif de NEGATIVE_TTL_MS).
 * Une valeur plus grosse que le plafond total n'est pas gardée.
 */
export class TtlCache {
  private readonly values = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(maxEntries = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.values.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Durée fixe, ou fonction de la valeur chargée (ex. plus courte pour un résultat vide). */
  get<T>(key: string, ttlMs: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit !== undefined && hit.exp > Date.now()) {
      this.values.delete(key);
      this.values.set(key, hit); // LRU : la dernière consultation passe en fin de file
      return hit.failure !== undefined ? Promise.reject(hit.failure) : Promise.resolve(hit.value as T);
    }
    if (hit !== undefined) this.remove(key);
    const inflight = this.pending.get(key);
    if (inflight !== undefined) return inflight as Promise<T>;
    const promise = load()
      .then(
        (value) => {
          this.store(key, { value }, approximateBytes(value), typeof ttlMs === 'number' ? ttlMs : ttlMs(value));
          return value;
        },
        (err: unknown) => {
          if (isNegative(err)) this.store(key, { failure: err }, NEGATIVE_BYTES, NEGATIVE_TTL_MS);
          throw err;
        },
      )
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private store(key: string, payload: { value?: unknown; failure?: unknown }, bytes: number, ttlMs: number): void {
    this.remove(key);
    if (bytes > this.maxBytes) return;
    this.values.set(key, { ...payload, exp: Date.now() + ttlMs, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  private evict(): void {
    if (this.values.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
    const now = Date.now();
    for (const [key, entry] of this.values) {
      if (entry.exp <= now) this.remove(key);
    }
    while (this.values.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
  }

  private remove(key: string): void {
    const entry = this.values.get(key);
    if (entry === undefined) return;
    this.values.delete(key);
    this.totalBytes -= entry.bytes;
  }
}

/** Services de données et champ de configuration correspondant. */
export type ServiceName = 'tmdb' | 'mdblist' | 'tvdb' | 'openrouter' | 'fanart';

const SERVICE_FIELD = {
  tmdb: 'tmdbToken',
  mdblist: 'mdblistApiKey',
  tvdb: 'tvdbApiKey',
  openrouter: 'openrouterApiKey',
  fanart: 'fanartApiKey',
} as const satisfies Record<ServiceName, keyof Config['services']>;

/** Clé d'un service. Absente : 404 service_not_configured (avec le nom du service, jamais la valeur). */
export function serviceKey(config: Config, name: ServiceName): string {
  const value = config.services[SERVICE_FIELD[name]];
  if (value === undefined) throw new LtError(404, 'service_not_configured', name);
  return value;
}

/** Version de l'API TheTVDB qui accepte une clé : v4 (clé personnelle) ou v3 (clé legacy). */
export type TvdbVersion = 'v4' | 'v3';

/**
 * État par application : cache borné et partagé, sessions TVDB (clé = empreinte de la clé API et du PIN), version
 * TVDB retenue par clé (évite un essai v4 voué à l'échec à chaque requête).
 */
export interface LtState {
  cache: TtlCache;
  tvdbSessions: Map<string, { token: string; exp: number }>;
  tvdbVersions: Map<string, { version: TvdbVersion; exp: number }>;
}

/**
 * Contexte des routes lt : état, fetch injectable, garde d'URL (littérale), agent épinglé (DNS contrôlé à la
 * connexion) et signeur des URL du proxy HLS.
 */
export interface LtContext {
  state: LtState;
  fetch: FetchFn;
  guard: UrlGuard;
  dispatcher: Dispatcher;
  signer: UrlSigner;
}

export function createLtContext(deps: AppDeps): LtContext {
  return {
    state: { cache: new TtlCache(), tvdbSessions: new Map(), tvdbVersions: new Map() },
    fetch: deps.fetch ?? globalThis.fetch,
    guard: createPublicGuard(),
    dispatcher: createPinnedAgent(deps.lookupHost),
    signer: createUrlSigner(deps.secret),
  };
}

/** Décode la configuration de l'URL. Configuration illisible : 400 invalid_config. */
export function decodeFor(deps: AppDeps, encoded: string): Config {
  try {
    return decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
  } catch (err) {
    if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) {
      throw new LtError(400, 'invalid_config');
    }
    throw err;
  }
}

/** Traduit une erreur de transport en LtError, sans URL ni contenu. Les erreurs inconnues sont relancées. */
function transportFailure(err: unknown): unknown {
  if (err instanceof SourceTooLargeError) return new LtError(413, 'payload_too_large');
  if (err instanceof UnsafeTargetError) return new LtError(403, 'host_not_allowed');
  if (err instanceof SourceError) return new LtError(504, 'upstream_unreachable');
  return err;
}

/** Requête sortante via le helper HTTP commun (délai, plafond de corps, redirections contrôlées, DNS épinglé). */
export async function ltRequest(
  ctx: LtContext,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = SERVICE_TIMEOUT_MS,
  body: BodyOptions = {},
): Promise<BytesResult> {
  try {
    return await fetchBytes(ctx.fetch, url, init, timeoutMs, { dispatcher: ctx.dispatcher, ...body });
  } catch (err) {
    throw transportFailure(err);
  }
}

/** Requête qui doit aboutir (2xx) : sinon 502 upstream_<statut>. Renvoie le corps en octets. */
export async function ltDownload(
  ctx: LtContext,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = SERVICE_TIMEOUT_MS,
  body: BodyOptions = {},
): Promise<Buffer> {
  const res = await ltRequest(ctx, url, init, timeoutMs, body);
  if (!res.ok) throw new LtError(502, `upstream_${res.status}`);
  return Buffer.from(res.bytes);
}

/** Requête JSON amont : statut non 2xx → 502 upstream_<statut>, JSON invalide → 502 upstream_bad_json. */
export async function getJson(
  ctx: LtContext,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = SERVICE_TIMEOUT_MS,
  body: BodyOptions = {},
): Promise<unknown> {
  const bytes = await ltDownload(ctx, url, init, timeoutMs, body);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new LtError(502, 'upstream_bad_json');
  }
}

/** Lit une clé du objet JSON, ou un objet vide si la structure n'est pas celle attendue. */
export function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return {};
    current = current[key];
  }
  return isRecord(current) ? current : {};
}

/** Corps JSON d'une requête : objet simple, sinon objet vide. */
export function bodyOf(req: Request): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

/** Paramètres de l'URL (dernière valeur gagne), tels que le prototype les transmet. */
export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.originalUrl, 'http://localhost').searchParams);
}
