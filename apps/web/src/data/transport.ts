import { appFetch } from './crossFetch';
import { LastAddonError } from './errors';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Le serveur répond `private, max-age=300` : un cache client plus court ne ferait que refetcher. */
export const MIN_TTL_MS = 5 * 60 * 1000;
/** Le serveur limite les GET /lt/* à 120/min/IP : peu de requêtes en vol, les autres attendent leur tour. */
export const MAX_IN_FLIGHT = 6;
/** Délai maximal d'une tentative, créneau compris : une réponse qui ne vient jamais ne doit pas garder son créneau. */
export const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_PREFIX = 'laststream.cache:';
const SESSION_MAX_CHARS = 150_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const memory = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

function readSession(key: string): CacheEntry | undefined {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_PREFIX + key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as CacheEntry | null;
    return typeof entry?.expiresAt === 'number' ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeSession(key: string, entry: CacheEntry): void {
  try {
    const text = JSON.stringify(entry);
    if (text.length <= SESSION_MAX_CHARS) globalThis.sessionStorage?.setItem(SESSION_PREFIX + key, text);
  } catch {
    // Quota dépassé ou stockage désactivé : le cache mémoire suffit.
  }
}

/**
 * Valeur en cache si elle n'a pas expiré (mémoire puis sessionStorage), sinon exécute `load`.
 * Les requêtes identiques en vol sont partagées. Les erreurs ne sont jamais mises en cache.
 */
/** Les playlists HLS en direct changent à chaque seconde : jamais mises en cache ni partagées. */
export const isUncacheable = (key: string): boolean => /\/lt\/tv\/hls(\?|$)/.test(key);

export function cachedRequest<T>(key: string, load: () => Promise<T>, ttlMs: number = DEFAULT_TTL_MS): Promise<T> {
  if (isUncacheable(key)) return new Promise<T>((resolve) => resolve(load()));
  const entry = memory.get(key) ?? readSession(key);
  if (entry && entry.expiresAt > Date.now()) {
    memory.set(key, entry);
    return Promise.resolve(entry.value as T);
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const lifetime = Math.max(ttlMs, MIN_TTL_MS);
  const request = new Promise<T>((resolve) => resolve(load()))
    .then((value) => {
      const fresh: CacheEntry = { value, expiresAt: Date.now() + lifetime };
      memory.set(key, fresh);
      writeSession(key, fresh);
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

export function clearCache(): void {
  memory.clear();
  inflight.clear();
  void clearFicheStore();
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return;
    for (let i = storage.length - 1; i >= 0; i -= 1) {
      const k = storage.key(i);
      if (k?.startsWith(SESSION_PREFIX)) storage.removeItem(k);
    }
  } catch {
    // Stockage indisponible.
  }
}

let active = 0;
const waiting: Array<() => void> = [];

/** Nombre de requêtes actuellement en vol (pour les tests). */
export const inFlightCount = (): number => active;

function acquire(): Promise<void> {
  if (active < MAX_IN_FLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // le créneau passe directement au suivant
  else active -= 1;
}

/** Exécute `task` dès qu'un des MAX_IN_FLIGHT créneaux est libre. */
export async function limited<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readErrorBody(response: Response): Promise<{ code?: string; issues?: string[] }> {
  try {
    const body = (await response.json()) as { error?: unknown; issues?: unknown } | null;
    return {
      code: typeof body?.error === 'string' ? body.error : undefined,
      issues: Array.isArray(body?.issues) ? body.issues.filter((i): i is string => typeof i === 'string') : undefined,
    };
  } catch {
    return {};
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Délai maximal d'une tentative (ms), créneau compris. Défaut : REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Envoie la requête à concurrence bornée. Une réponse 429 est retentée (jusqu'à 3 fois) après une courte pause. */
async function send(url: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  /** Une tentative, lancée dès l'obtention du créneau : le délai court jusqu'à la réponse (en-têtes) ou l'échéance. */
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    // Rejet même si le fetch sous-jacent ignore le signal : le créneau doit toujours se libérer.
    const gone = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('Requête annulée'), { name: 'AbortError' })), { once: true });
    });
    const timer = setTimeout(abort, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      return await Promise.race([appFetch(url, { method, headers, body, signal: controller.signal }), gone]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  };

  const once = async (): Promise<Response> => {
    try {
      return await limited(attempt);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LastAddonError('network', 'lastAddon est injoignable.');
    }
  };

  let response = await once();
  for (let attempt = 0; response.status === 429 && attempt < 3; attempt += 1) {
    // Trop de requêtes : on attend le délai annoncé (ou 1,5 s, 3 s, 6 s) puis on réessaie.
    const retry = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 10) * 1000 : 1500 * 2 ** attempt);
    response = await once();
  }
  return response;
}

async function httpError(response: Response): Promise<LastAddonError> {
  const { code, issues } = await readErrorBody(response);
  return new LastAddonError('http', `lastAddon a répondu HTTP ${response.status}.`, { status: response.status, code, issues });
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new LastAddonError('invalid_response', 'Réponse lastAddon illisible.');
  }
}

/** Requête JSON sans cache, à concurrence bornée. Une réponse 429 est retentée une fois après une courte pause. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(url, options);
  if (!response.ok) throw await httpError(response);
  return parseJson<T>(response);
}

// ---------- Fiches : corps + ETag ----------

/** Routes dont la réponse est une fiche (TMDB, MDBList, TVDB) : leur corps et leur ETag sont gardés pour revalider. */
export const isFicheUrl = (url: string): boolean => /\/lt\/(tmdb|mdblist|tvdb)\//.test(url);

const FICHE_DB = 'laststream.fiches';
const FICHE_STORE = 'entries';
/** Plafond du repli mémoire (IndexedDB indisponible) : au-delà, les entrées les plus anciennes partent. */
const FICHE_MEMORY_MAX = 200;

interface FicheEntry {
  etag: string;
  body: unknown;
}

const ficheMemory = new Map<string, FicheEntry>();
let ficheDb: Promise<IDBDatabase | null> | null = null;

/** Ouvre la base une seule fois ; null si IndexedDB est absente, bloquée ou refusée (repli mémoire). */
function openFicheDb(): Promise<IDBDatabase | null> {
  if (!ficheDb) {
    ficheDb = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const factory = globalThis.indexedDB;
        if (!factory) {
          resolve(null);
          return;
        }
        const req = factory.open(FICHE_DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(FICHE_STORE)) req.result.createObjectStore(FICHE_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return ficheDb;
}

/** Une opération sur le magasin des fiches ; rejette si IndexedDB est indisponible. */
async function ficheStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openFicheDb();
  if (!db) throw new Error('indexeddb-indisponible');
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(FICHE_STORE, mode).objectStore(FICHE_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readFiche(url: string): Promise<FicheEntry | undefined> {
  try {
    const stored = await ficheStore<FicheEntry | undefined>('readonly', (s) => s.get(url));
    if (stored) return stored;
  } catch {
    // IndexedDB indisponible : repli mémoire ci-dessous.
  }
  return ficheMemory.get(url);
}

async function writeFiche(url: string, entry: FicheEntry): Promise<void> {
  try {
    await ficheStore('readwrite', (s) => s.put(entry, url));
  } catch {
    ficheMemory.delete(url);
    ficheMemory.set(url, entry);
    const oldest = ficheMemory.keys().next().value;
    if (ficheMemory.size > FICHE_MEMORY_MAX && oldest !== undefined) ficheMemory.delete(oldest);
  }
}

async function clearFicheStore(): Promise<void> {
  ficheMemory.clear();
  try {
    await ficheStore('readwrite', (s) => s.clear());
  } catch {
    // Rien à effacer si IndexedDB est indisponible.
  }
}

/**
 * Fiche avec ETag : si une entrée existe, envoie `If-None-Match`. Une réponse 304 renvoie le corps gardé sans le
 * retélécharger ; une réponse 200 avec un ETag remplace l'entrée. Sans ETag côté serveur, rien n'est gardé.
 */
export async function requestFiche<T>(url: string): Promise<T> {
  const stored = await readFiche(url);
  const response = await send(url, stored ? { headers: { 'if-none-match': stored.etag } } : {});
  if (response.status === 304 && stored) return stored.body as T;
  if (!response.ok) throw await httpError(response);
  const body = await parseJson<T>(response);
  const etag = response.headers.get('etag');
  if (etag) void writeFiche(url, { etag, body });
  return body;
}
