import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
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

/** Durées de vie du cache, identiques au prototype. */
export const TTL = {
  tmdb: 10 * 60e3,
  mdb: 30 * 60e3,
  tvdb: 60 * 60e3,
  ai: 30 * 60e3,
  tv: 6 * 3600e3,
} as const;

/** Délai par défaut des appels vers les services (ms). */
export const SERVICE_TIMEOUT_MS = 12000;
const CACHE_PRUNE_SIZE = 5000;

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

/** Cache mémoire à durée fixe ; les requêtes identiques en cours sont dédoublonnées (comme le prototype). */
export class TtlCache {
  private readonly values = new Map<string, { exp: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit !== undefined && hit.exp > Date.now()) return Promise.resolve(hit.value as T);
    const inflight = this.pending.get(key);
    if (inflight !== undefined) return inflight as Promise<T>;
    const promise = load()
      .then((value) => {
        if (this.values.size >= CACHE_PRUNE_SIZE) this.prune();
        this.values.set(key, { exp: Date.now() + ttlMs, value });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.values) {
      if (entry.exp <= now) this.values.delete(key);
    }
  }
}

/** Empreinte SHA-256 (hex) d'une valeur JSON : sert de clé de cache, jamais de clé secrète en clair. */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

/** État par application : cache, sessions TVDB (clé = empreinte de la clé API), hôtes HLS autorisés. */
export interface LtState {
  cache: TtlCache;
  tvdbSessions: Map<string, { token: string; exp: number }>;
  tvHosts: Set<string>;
}

/** Contexte des routes lt : état, fetch injectable et garde d'URL. */
export interface LtContext {
  state: LtState;
  fetch: FetchFn;
  guard: UrlGuard;
}

export function createLtContext(deps: AppDeps): LtContext {
  return {
    state: { cache: new TtlCache(), tvdbSessions: new Map(), tvHosts: new Set() },
    fetch: deps.fetch ?? globalThis.fetch,
    guard: createPublicGuard(deps.lookupHost),
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

/** Requête sortante via le helper HTTP commun (délai, plafond de corps, redirections contrôlées). */
export async function ltRequest(
  ctx: LtContext,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = SERVICE_TIMEOUT_MS,
  body: BodyOptions = {},
): Promise<BytesResult> {
  try {
    return await fetchBytes(ctx.fetch, url, init, timeoutMs, body);
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
): Promise<unknown> {
  const bytes = await ltDownload(ctx, url, init, timeoutMs);
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
