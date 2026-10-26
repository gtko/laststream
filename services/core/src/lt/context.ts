import { createHash } from 'node:crypto';
import type { Ctx } from '../http/app-env.js';
import { platform, runtimeEnv, type KvCache, type OutboundDispatcher } from '../platform/index.js';
import { createRateLimiter } from '../rate-limit.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { withServerServices } from '../config/server-services.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, TtlCache } from '../cache/ttl-cache.js';
import {
  type BodyOptions,
  type BytesResult,
  fetchBytes,
  type FetchFn,
  isRecord,
  SourceError,
  SourceTooLargeError,
  type UrlGuard,
} from '../sources/http.js';
import { UnsafeTargetError, createPublicGuard } from './guard.js';
import { createUrlSigner, type UrlSigner } from './signing.js';
import { memoryQuotaGate, parseDailyBudget, type QuotaGate } from './quota.js';
import type { MetaBlobStore } from './meta.js';

/**
 * Durées de vie du cache. Les métadonnées publiques sont partagées entre tous les utilisateurs (économie de
 * requêtes amont) ; seules les recommandations dépendent de la charge utile de la requête.
 */
export const TTL = {
  tmdb: 6 * 3600e3, // détails et listes
  tmdbFast: 3 * 3600e3, // tendances et populaires
  tmdbImdbId: 30 * 24 * 3600e3, // correspondance TMDB vers IMDb (identifiant définitif, LAST-138)
  tmdbDay: 3600e3, // tendances du jour (Top 10 d'aujourd'hui) : une heure
  tmdbWatch: 12 * 3600e3, // fournisseurs de streaming
  mdb: 24 * 3600e3, // notes MDBList
  tvdb: 12 * 3600e3, // saisons TVDB
  episodes: 12 * 3600e3, // structure saisons et épisodes (TMDB, groupes TMDB, TVDB)
  aiRecommend: 24 * 3600e3, // recommandations partagées par empreinte de goûts (SWR)
  aiRecommendEmpty: 5 * 60e3, // lot de recommandations vide : nouvel essai plus tôt
  aiText: 7 * 24 * 3600e3, // « pourquoi » (par identifiant de titre ou de personne)
  tvChannels: 12 * 3600e3, // catalogue TV (sources amont)
  tvPartial: 15 * 60e3, // catalogue incomplet (une source a échoué) : nouvel essai plus tôt
  tvEpg: 3 * 3600e3, // programmes EPG
  tvStore: 5 * 60e3, // catalogue et EPG lus depuis le stockage (Workers : R2 alimenté par le Cron)
  skip: 7 * 24 * 3600e3, // segments intro/recap/crédits trouvés
  skipEmpty: 6 * 3600e3, // aucun segment trouvé (à revérifier plus tôt)
  fillers: 7 * 24 * 3600e3, // épisodes filler et récap d'un anime (Jikan)
  fillersEmpty: 6 * 3600e3, // aucun filler connu (à revérifier plus tôt)
} as const;


/** Délai par défaut des appels vers les services (ms). */
const SERVICE_TIMEOUT_MS = 12000;

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

export { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, TtlCache } from '../cache/ttl-cache.js';

/** Version de l'API TheTVDB qui accepte une clé : v4 (clé personnelle) ou v3 (clé legacy). */
export type TvdbVersion = 'v4' | 'v3';

/**
 * État par application : cache borné et partagé, sessions TVDB (clé = empreinte de la clé API et du PIN), version
 * TVDB retenue par clé (évite un essai v4 voué à l'échec à chaque requête).
 */
interface LtState {
  cache: TtlCache;
  tvdbSessions: Map<string, { token: string; exp: number }>;
  tvdbVersions: Map<string, { version: TvdbVersion; exp: number }>;
  /** Cache persistant des notes MDBList et disjoncteur de quota (Workers : KV partagé ; Node : mémoire). */
  mdbKv: KvCache;
  /** Fin (ms epoch) du disjoncteur MDBList connue de cette instance : évite de relire le KV pendant la coupure. */
  mdbBreakerUntil: number;
}

/**
 * Contexte des routes lt : état, fetch injectable, garde d'URL (littérale), agent épinglé (DNS contrôlé à la
 * connexion) et signeur des URL du proxy HLS.
 */
export interface LtContext {
  state: LtState;
  fetch: FetchFn;
  guard: UrlGuard;
  dispatcher: OutboundDispatcher | undefined;
  signer: UrlSigner;
  /**
   * Stockage à écriture rare (R2 sous Workers) des valeurs amont gardées longtemps (saisons, TVDB). Absent (Node) : la
   * mémoire de l'isolat seule.
   */
  blobs?: MetaBlobStore;
  /** Limite de débit globale des appels MDBList sortants (true = autorisé). */
  mdbLimiter: () => Promise<boolean>;
  /** Budget quotidien global des appels MDBList (true = appel autorisé, et compté pour le jour UTC). */
  mdbQuota: QuotaGate;
  /** Nombre maximal d'appels MDBList par jour UTC. */
  mdbDailyBudget: number;
}

/** Appels MDBList sortants par minute (par instance sans limiteur partagé). */
const MDBLIST_CALLS_PER_MINUTE = 20;

function mdblistLocalLimiter(): () => Promise<boolean> {
  const limit = createRateLimiter(MDBLIST_CALLS_PER_MINUTE, 60e3);
  return () => Promise.resolve(limit('mdblist').allowed);
}

/** Un contexte par application : `createApp` ne tourne qu'une fois par isolat, donc un seul état partagé en production. */
const contexts = new WeakMap<AppDeps, LtContext>();

/** Contexte partagé des routes lt de l'application `deps` (mêmes caches, sessions et disjoncteurs pour toutes les routes). */
export function createLtContext(deps: AppDeps): LtContext {
  const known = contexts.get(deps);
  if (known !== undefined) return known;
  const ctx = buildLtContext(deps);
  contexts.set(deps, ctx);
  return ctx;
}

function buildLtContext(deps: AppDeps): LtContext {
  return {
    state: {
      cache: new TtlCache(CACHE_MAX_ENTRIES, CACHE_MAX_BYTES),
      tvdbSessions: new Map(),
      tvdbVersions: new Map(),
      mdbKv: platform().createKvCache('mdb'),
      mdbBreakerUntil: 0,
    },
    fetch: deps.fetch ?? globalThis.fetch,
    guard: createPublicGuard(),
    dispatcher: platform().http.pinnedDispatcher(deps.lookupHost),
    signer: createUrlSigner(deps.secret),
    blobs: deps.metaBlobs ?? platform().metaBlobs,
    mdbLimiter: deps.mdblistLimiter ?? mdblistLocalLimiter(),
    mdbQuota: deps.mdblistQuota ?? memoryQuotaGate(),
    mdbDailyBudget: deps.mdblistDailyBudget ?? parseDailyBudget(runtimeEnv().get('MDBLIST_DAILY_BUDGET')),
  };
}

/** Décode la configuration de l'URL. Configuration illisible : 400 invalid_config. */
export function decodeFor(deps: AppDeps, encoded: string): Config {
  try {
    return withServerServices(decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain }));
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
export function bodyOf(c: Ctx): Record<string, unknown> {
  const body = c.get('body');
  return isRecord(body) ? body : {};
}

/** Paramètres de l'URL (dernière valeur gagne), tels que le prototype les transmet. */
export function queryOf(c: Ctx): Record<string, string> {
  return Object.fromEntries(new URL(c.req.url).searchParams);
}
