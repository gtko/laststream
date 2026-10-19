import { createHash } from 'node:crypto';
import { platform, sharedKvCache } from '../platform/index.js';
import type { KvCache } from '../platform/types.js';

/** Plafond du cache : nombre d'entrées, et taille totale approchée (octets). */
export const CACHE_MAX_ENTRIES = 10_000;
export const CACHE_MAX_BYTES = 100 * 1024 * 1024;
/** Durée du cache négatif : une 404 amont est mémorisée brièvement ; aucune autre erreur n'est mise en cache. */
export const NEGATIVE_TTL_MS = 60e3;
/** Taille comptée pour une entrée négative (erreur mémorisée). */
const NEGATIVE_BYTES = 256;
/** Échec d'un rafraîchissement SWR : pas de nouvel essai pendant ce délai, la valeur périmée reste servie entre-temps. */
export const REFRESH_RETRY_MS = 60e3;

/**
 * Fournisseurs dont les réponses publiques passent aussi par le niveau 2 (KV partagé), un espace de noms par
 * fournisseur. Sans fournisseur, l'entrée reste en mémoire.
 */
export type CacheProvider = 'tmdb' | 'tvdb' | 'openrouter' | 'cinemeta';

/**
 * Événements pour les compteurs : `l1hit` (mémoire), `l2hit` (KV), `miss` (appel amont), `stale` (valeur périmée servie
 * pendant un rafraîchissement), `coalesced` (requête jointe à un appel déjà en vol). `provider` est absent pour une
 * entrée sans niveau 2.
 */
export type CacheEvent = 'l1hit' | 'l2hit' | 'miss' | 'stale' | 'coalesced';
export type CacheListener = (event: CacheEvent, provider: CacheProvider | undefined) => void;

/** Options d'une lecture : niveau 2 et stale-while-revalidate. */
export interface CacheGetOptions {
  /** Niveau 2 : espace KV du fournisseur. La valeur doit être sérialisable en JSON (les `Map` sont admises). */
  provider?: CacheProvider;
  /**
   * Stale-while-revalidate : une fois la fraîcheur passée, la valeur reste servie tout de suite pendant une durée égale
   * au TTL, et un rafraîchissement part en arrière-plan (un seul à la fois par clé).
   */
  swr?: boolean;
}

/** Réglages d'une instance. Tous facultatifs : par défaut, mémoire seule et plateforme de l'hôte. */
export interface TtlCacheOptions {
  /** Erreurs mémorisées brièvement. Défaut : une erreur portant `code: 'upstream_404'`. */
  negative?: (err: unknown) => boolean;
  /** Niveau 2 par fournisseur. Défaut : KV partagé de la plateforme (Workers) ; absent ailleurs. */
  kv?: (provider: CacheProvider) => KvCache | undefined;
  /** Travail en arrière-plan (`waitUntil` sous Workers). Défaut : celui de la plateforme, sinon sans suivi. */
  background?: (work: Promise<unknown>) => void;
  /** Écouteur des compteurs de cette instance. Défaut : l'écouteur global (`setCacheListener`). */
  onEvent?: CacheListener;
}

interface Entry {
  /** Fin de fraîcheur (ms epoch). */
  exp: number;
  /** Fin du service périmé (ms epoch) : égale à `exp` sans stale-while-revalidate. */
  stale: number;
  bytes: number;
  value?: unknown;
  failure?: unknown;
}

/** Enregistrement KV : `e` fin de fraîcheur, `s` fin du service périmé, `h` empreinte de la valeur, `v` la valeur. */
interface StoredRecord {
  e: number;
  s: number;
  h: string;
  v: unknown;
}

interface ReadRecord extends StoredRecord {
  /** Taille approchée de l'enregistrement lu (octets). */
  bytes: number;
}

const MAP_TAG = '__map';

/** `Map` sérialisées en `{ "__map": [[k, v], …] }` : le niveau 2 les restitue telles quelles. */
function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const tagged = (value as Record<string, unknown>)[MAP_TAG];
    if (keys.length === 1 && Array.isArray(tagged)) return new Map(tagged as [unknown, unknown][]);
  }
  return value;
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.e === 'number' && typeof rec.s === 'number' && typeof rec.h === 'string' && 'v' in rec;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Lit l'enregistrement d'une clé du niveau 2. Erreur ou enregistrement illisible : absent (jamais de levée). */
async function readRecord(kv: KvCache, key: string): Promise<ReadRecord | undefined> {
  try {
    const raw = await kv.get(key);
    if (raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(raw, reviver);
    return isStoredRecord(parsed) ? { ...parsed, bytes: Buffer.byteLength(raw, 'utf8') } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Écrit une valeur chargée dans le niveau 2. Pas de relecture : `resolve` vient de lire la clé et n'a trouvé ni
 * enregistrement frais ni valeur à garder, donc une relecture ici ne coûtait qu'une lecture KV de plus.
 */
async function persist(kv: KvCache, key: string, json: string, exp: number, stale: number): Promise<void> {
  try {
    const ttlSeconds = Math.max(1, Math.ceil((stale - Date.now()) / 1000));
    await kv.set(key, `{"e":${exp},"s":${stale},"h":"${sha256(json)}","v":${json}}`, ttlSeconds);
  } catch {
    /* niveau 2 indisponible : le niveau 1 suffit */
  }
}

function defaultNegative(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'upstream_404';
}

function defaultKv(provider: CacheProvider): KvCache | undefined {
  try {
    return sharedKvCache(provider);
  } catch {
    return undefined; // plateforme non installée (outils, tests unitaires)
  }
}

function defaultBackground(work: Promise<unknown>): void {
  try {
    platform().scheduler.background(work);
  } catch {
    /* sans plateforme : le travail suit son cours seul (la promesse ne rejette jamais) */
  }
}

let globalListener: CacheListener | undefined;

/** Écouteur global des compteurs de cache (lot de métriques). `undefined` le retire. */
export function setCacheListener(listener: CacheListener | undefined): void {
  globalListener = listener;
}

/**
 * Cache à deux niveaux, borné en entrées et en octets.
 * - Niveau 1 : mémoire de l'instance, LRU (une lecture déplace l'entrée en fin de file ; les périmées partent d'abord).
 * - Niveau 2 : KV partagé entre isolats, pour les fournisseurs (`provider`). Une valeur y est écrite seulement si elle
 *   manque, a changé ou n'est plus fraîche.
 * Stale-while-revalidate (`swr`) : une valeur périmée est servie tout de suite et rafraîchie en arrière-plan ; un échec
 * du rafraîchissement n'est pas relancé avant REFRESH_RETRY_MS. Requêtes identiques en vol : dédoublonnées (un seul
 * appel amont). Les erreurs ne sont pas mises en cache, sauf une
 * 404 amont (cache négatif de NEGATIVE_TTL_MS). Un TTL nul ou négatif ne garde rien. Une valeur plus grosse que le
 * plafond total n'est pas gardée.
 */
export class TtlCache {
  private readonly values = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly refreshing = new Set<string>();
  /** Instant du dernier échec de rafraîchissement, par clé (délai REFRESH_RETRY_MS avant un nouvel essai). */
  private readonly refreshFailures = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly options: TtlCacheOptions;
  private totalBytes = 0;

  constructor(maxEntries = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES, options: TtlCacheOptions = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.options = options;
  }

  get size(): number {
    return this.values.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Vide le niveau 1 de cette instance ; le niveau 2 (KV) n'est pas touché. */
  clearMemory(): void {
    this.values.clear();
    this.totalBytes = 0;
  }

  /** Durée de fraîcheur fixe, ou fonction de la valeur chargée (ex. plus courte pour un résultat vide). */
  get<T>(key: string, ttlMs: number | ((value: T) => number), load: () => Promise<T>, options: CacheGetOptions = {}): Promise<T> {
    const hit = this.values.get(key);
    if (hit !== undefined) {
      const now = Date.now();
      const fresh = hit.exp > now;
      const servable = !fresh && options.swr === true && hit.failure === undefined && hit.stale > now;
      if (fresh || servable) {
        this.touch(key, hit);
        if (fresh) {
          this.emit('l1hit', options.provider);
          return hit.failure !== undefined ? Promise.reject(hit.failure) : Promise.resolve(hit.value as T);
        }
        this.emit('stale', options.provider);
        this.refreshInBackground(key, ttlMs, load, options);
        return Promise.resolve(hit.value as T);
      }
      this.remove(key);
    }
    const inflight = this.pending.get(key);
    if (inflight !== undefined) {
      this.emit('coalesced', options.provider);
      return inflight as Promise<T>;
    }
    const promise = this.resolve(key, ttlMs, load, options, 'read').finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  /** Niveau 2 puis appel amont. `refresh` : jamais de valeur périmée servie (c'est déjà le rafraîchissement). */
  private async resolve<T>(
    key: string,
    ttlMs: number | ((value: T) => number),
    load: () => Promise<T>,
    options: CacheGetOptions,
    mode: 'read' | 'refresh',
  ): Promise<T> {
    const kv = this.kvFor(options.provider);
    const stored = kv === undefined ? undefined : await readRecord(kv, key);
    if (stored !== undefined) {
      const now = Date.now();
      if (stored.e > now) {
        this.storeMemory(key, { value: stored.v }, stored.bytes, stored.e, stored.s);
        this.emit('l2hit', options.provider);
        return stored.v as T;
      }
      if (mode === 'read' && options.swr === true && stored.s > now) {
        this.storeMemory(key, { value: stored.v }, stored.bytes, stored.e, stored.s);
        this.emit('stale', options.provider);
        this.refreshInBackground(key, ttlMs, load, options);
        return stored.v as T;
      }
    }

    this.emit('miss', options.provider);
    let value: T;
    try {
      value = await load();
    } catch (err) {
      if (this.isNegative(err)) {
        const until = Date.now() + NEGATIVE_TTL_MS;
        this.storeMemory(key, { failure: err }, NEGATIVE_BYTES, until, until);
      }
      throw err;
    }
    const ms = typeof ttlMs === 'number' ? ttlMs : ttlMs(value);
    if (ms <= 0) return value;
    const json = JSON.stringify(value, replacer) as string | undefined;
    const bytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
    const exp = Date.now() + ms;
    const stale = options.swr === true ? exp + ms : exp;
    this.storeMemory(key, { value }, bytes, exp, stale);
    if (kv !== undefined && json !== undefined) await persist(kv, key, json, exp, stale);
    return value;
  }

  /**
   * Rafraîchit une clé périmée en arrière-plan ; un seul rafraîchissement à la fois. Échec : la valeur périmée reste, et
   * aucun nouvel essai pendant REFRESH_RETRY_MS (sinon chaque lecture relancerait un amont en panne).
   */
  private refreshInBackground<T>(key: string, ttlMs: number | ((value: T) => number), load: () => Promise<T>, options: CacheGetOptions): void {
    if (this.refreshing.has(key)) return;
    const failedAt = this.refreshFailures.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < REFRESH_RETRY_MS) return;
    this.refreshing.add(key);
    const work = this.resolve(key, ttlMs, load, options, 'refresh')
      .then(
        () => {
          this.refreshFailures.delete(key);
        },
        () => {
          this.noteRefreshFailure(key);
        },
      )
      .finally(() => this.refreshing.delete(key));
    (this.options.background ?? defaultBackground)(work);
  }

  private noteRefreshFailure(key: string): void {
    const now = Date.now();
    if (this.refreshFailures.size >= this.maxEntries) {
      for (const [existing, at] of this.refreshFailures) {
        if (now - at >= REFRESH_RETRY_MS) this.refreshFailures.delete(existing);
      }
    }
    this.refreshFailures.set(key, now);
  }

  private kvFor(provider: CacheProvider | undefined): KvCache | undefined {
    if (provider === undefined) return undefined;
    return this.options.kv !== undefined ? this.options.kv(provider) : defaultKv(provider);
  }

  private isNegative(err: unknown): boolean {
    return (this.options.negative ?? defaultNegative)(err);
  }

  private emit(event: CacheEvent, provider: CacheProvider | undefined): void {
    try {
      (this.options.onEvent ?? globalListener)?.(event, provider);
    } catch {
      /* un compteur défaillant ne doit jamais casser une lecture */
    }
  }

  private touch(key: string, entry: Entry): void {
    this.values.delete(key);
    this.values.set(key, entry);
  }

  private storeMemory(key: string, payload: { value?: unknown; failure?: unknown }, bytes: number, exp: number, stale: number): void {
    this.remove(key);
    if (bytes > this.maxBytes) return;
    this.values.set(key, { ...payload, exp, stale, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  private evict(): void {
    if (this.values.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
    const now = Date.now();
    for (const [key, entry] of this.values) {
      if (entry.stale <= now) this.remove(key);
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

let shared: TtlCache | undefined;

/**
 * Cache partagé de l'isolat, pour les modules du moteur (Cinemeta, TMDB) qui n'ont pas de contexte de requête.
 * Une seule instance : les requêtes identiques en vol sont dédoublonnées entre tous les appelants.
 */
export function sharedCache(): TtlCache {
  shared ??= new TtlCache();
  return shared;
}
