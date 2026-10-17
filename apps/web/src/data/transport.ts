import { LastAddonError } from './errors';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Le serveur répond `private, max-age=300` : un cache client plus court ne ferait que refetcher. */
export const MIN_TTL_MS = 5 * 60 * 1000;
/** Le serveur limite les GET /lt/* à 120/min/IP : peu de requêtes en vol, les autres attendent leur tour. */
export const MAX_IN_FLIGHT = 6;
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
}

/** Requête JSON sans cache, à concurrence bornée. Une réponse 429 est retentée une fois après une courte pause. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const send = async (): Promise<Response> => {
    try {
      return await limited(() => fetch(url, { method, headers, body, signal: options.signal }));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LastAddonError('network', 'lastAddon est injoignable.');
    }
  };

  let response = await send();
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 10) * 1000 : 1500);
    response = await send();
  }

  if (!response.ok) {
    const { code, issues } = await readErrorBody(response);
    throw new LastAddonError('http', `lastAddon a répondu HTTP ${response.status}.`, { status: response.status, code, issues });
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new LastAddonError('invalid_response', 'Réponse lastAddon illisible.');
  }
}
