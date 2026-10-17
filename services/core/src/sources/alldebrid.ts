/**
 * Client AllDebrid (API v4 / v4.1), écrit à partir de la documentation officielle de l'API.
 *
 * Règles de sécurité : la clé API ne part que dans l'en-tête Authorization. Aucune erreur
 * ne contient la clé, la configuration ni les URL retournées : seuls des codes génériques sortent.
 */

const API_BASE = 'https://api.alldebrid.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 600_000;
const CHECK_BATCH_SIZE = 20;
const CHECK_CONCURRENCY = 3;
const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1_500;
const RESOLVE_TTL_MS = 3_600_000;
const MAX_CACHE_ENTRIES = 5_000;
const MAGNET_STATUS_READY = 4;
const MAGNET_STATUS_ERROR_FROM = 5;
const HASH_PATTERN = /^[0-9a-f]{40}$/;
const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'mov', 'm4v', 'ts', 'webm']);

/** Erreur du client. `code` est un identifiant générique (ex. not_ready, rate_limited, AUTH_BAD_APIKEY). */
export class AllDebridError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'AllDebridError';
    this.code = code;
  }
}

export interface AllDebridClientOptions {
  /** fetch injecté (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
  /** Délai maximal par requête HTTP. */
  timeoutMs?: number;
  /** TTL du cache de disponibilité ; le TTL négatif vaut un dixième de cette valeur. */
  cacheTtlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
}

export interface ApiKeyCheck {
  ok: boolean;
  error?: string;
  premium?: boolean;
}

export interface ResolveOptions {
  season?: number;
  episode?: number;
  /** Délai entre deux interrogations de statut (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedLink {
  url: string;
  filename: string;
  size: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface FlatFile {
  name: string;
  size: number;
  link: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function normalizeHash(value: string): string | null {
  const hash = value.trim().toLowerCase();
  return HASH_PATTERN.test(hash) ? hash : null;
}

function apiErrorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : 'unknown';
}

function errorCodeOf(err: unknown): string {
  return err instanceof AllDebridError ? err.code : 'unknown';
}

function isTimeoutError(err: unknown): boolean {
  return isRecord(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function idToString(id: unknown): string | null {
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return String(id);
  if (typeof id === 'string' && /^\d{1,20}$/.test(id)) return id;
  return null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Exécute `task` sur chaque élément avec au plus `limit` tâches en parallèle. */
async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function pruneExpired<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Aplatit l'arborescence des fichiers (ordre d'apparition, parcours en profondeur). */
function flattenFiles(nodes: readonly unknown[], out: FlatFile[] = []): FlatFile[] {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (Array.isArray(node.e)) {
      flattenFiles(node.e, out);
      continue;
    }
    if (typeof node.n === 'string' && typeof node.l === 'string') {
      out.push({ name: node.n, size: typeof node.s === 'number' ? node.s : 0, link: node.l });
    }
  }
  return out;
}

function isVideo(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Reconnaît SxxExx (S01E02, S1E2) et NxNN (1x02), sans faux positif sur S11E02 pour S01E02. */
function matchesEpisode(name: string, season: number, episode: number): boolean {
  const patterns = [
    new RegExp(`(?<![0-9a-z])s0*${season}e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`(?<![0-9a-z])0*${season}x0*${episode}(?![0-9])`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(name));
}

function largest(files: readonly FlatFile[]): FlatFile {
  return files.reduce((best, file) => (file.size > best.size ? file : best));
}

function pickFile(files: readonly FlatFile[], fileIdx: number | undefined, season?: number, episode?: number): FlatFile {
  if (files.length === 0) throw new AllDebridError('no_file', 'aucun fichier');
  if (fileIdx !== undefined && Number.isSafeInteger(fileIdx) && fileIdx >= 0 && fileIdx < files.length) {
    return files[fileIdx];
  }
  const videos = files.filter((file) => isVideo(file.name));
  if (videos.length === 0) throw new AllDebridError('no_file', 'aucun fichier vidéo');
  if (season !== undefined && episode !== undefined) {
    const matches = videos.filter((file) => matchesEpisode(file.name, season, episode));
    if (matches.length > 0) return largest(matches);
  }
  return largest(videos);
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Entrée d'une liste de magnets : l'objet correspondant à l'id demandé, sinon le premier. */
function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const list = Array.isArray(value) ? value : [value];
  return list.find(isRecord);
}

export class AllDebridClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly checkCache = new Map<string, CacheEntry<boolean>>();
  private readonly resolveCache = new Map<string, CacheEntry<ResolvedLink>>();

  constructor(apiKey: string, opts: AllDebridClientOptions = {}) {
    if (apiKey.length === 0) {
      throw new Error('Clé AllDebrid manquante');
    }
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.positiveTtlMs = cacheTtlMs;
    this.negativeTtlMs = Math.floor(cacheTtlMs / 10);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Vérifie la clé via GET /v4/user. Ne lève jamais : renvoie ok=false avec un code générique. */
  async checkApiKey(): Promise<ApiKeyCheck> {
    try {
      const data = await this.request('GET', '/v4/user');
      if (!isRecord(data.user)) return { ok: false, error: 'invalid_response' };
      return { ok: true, premium: data.user.isPremium === true };
    } catch (err) {
      return { ok: false, error: errorCodeOf(err) };
    }
  }

  /**
   * Indique pour chaque hash s'il est déjà en cache AllDebrid (ready).
   * Les hashes d'un lot en erreur sont absents de la Map (inconnu). Ne lève jamais.
   * Les clés de la Map sont les hashes en minuscules.
   */
  async checkCached(hashes: readonly string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const unique = [...new Set(hashes.map(normalizeHash).filter((hash): hash is string => hash !== null))];
    const now = this.now();
    const missing: string[] = [];
    for (const hash of unique) {
      const entry = this.checkCache.get(hash);
      if (entry !== undefined && entry.expiresAt > now) {
        result.set(hash, entry.value);
      } else {
        missing.push(hash);
      }
    }

    await runLimited(chunk(missing, CHECK_BATCH_SIZE), CHECK_CONCURRENCY, async (batch) => {
      const found = await this.checkBatch(batch);
      const at = this.now();
      for (const [hash, cached] of found) {
        pruneExpired(this.checkCache, at);
        this.checkCache.set(hash, { value: cached, expiresAt: at + (cached ? this.positiveTtlMs : this.negativeTtlMs) });
        result.set(hash, cached);
      }
    });
    return result;
  }

  /**
   * Résout un hash en lien de téléchargement direct.
   * Lève AllDebridError : `not_ready` si le magnet n'est pas prêt après les interrogations,
   * `no_file` si aucun fichier vidéo, `magnet_failed` en cas d'erreur côté AllDebrid.
   */
  async resolve(infoHash: string, fileIdx?: number, opts: ResolveOptions = {}): Promise<ResolvedLink> {
    const hash = normalizeHash(infoHash);
    if (hash === null) throw new AllDebridError('invalid_hash', 'hash invalide');
    const season = Number.isSafeInteger(opts.season) && (opts.season ?? -1) >= 0 ? opts.season : undefined;
    const episode = Number.isSafeInteger(opts.episode) && (opts.episode ?? -1) >= 0 ? opts.episode : undefined;

    const key =
      fileIdx !== undefined ? `${hash}#${fileIdx}` : `${hash}#${season ?? '-'}x${episode ?? '-'}`;
    const now = this.now();
    const cached = this.resolveCache.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.value;

    const value = await this.resolveUncached(hash, fileIdx, season, episode, opts.sleep ?? defaultSleep);
    pruneExpired(this.resolveCache, now);
    this.resolveCache.set(key, { value, expiresAt: now + RESOLVE_TTL_MS });
    return value;
  }

  private async resolveUncached(
    hash: string,
    fileIdx: number | undefined,
    season: number | undefined,
    episode: number | undefined,
    sleep: (ms: number) => Promise<void>,
  ): Promise<ResolvedLink> {
    const magnet = await this.uploadMagnet(hash);
    if (!magnet.ready) await this.waitReady(magnet.id, sleep);
    const files = await this.listFiles(magnet.id);
    const file = pickFile(files, fileIdx, season, episode);

    const data = await this.request('POST', '/v4/link/unlock', new URLSearchParams([['link', file.link]]));
    // Lien différé : pas encore disponible côté AllDebrid, on demande un nouvel essai.
    if (hasValue(data.delayed)) throw new AllDebridError('not_ready', 'not_ready');
    if (typeof data.link !== 'string' || !isHttpUrl(data.link)) {
      throw new AllDebridError('invalid_response', 'AllDebrid : lien invalide');
    }
    return {
      url: data.link,
      filename: typeof data.filename === 'string' ? data.filename : file.name,
      size: typeof data.filesize === 'number' ? data.filesize : file.size,
    };
  }

  private async request(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw isTimeoutError(err)
        ? new AllDebridError('timeout', 'AllDebrid : délai dépassé')
        : new AllDebridError('network', 'AllDebrid : réseau indisponible');
    }
    if (res.status === 429 || res.status === 503) {
      throw new AllDebridError('rate_limited', 'rate limited');
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    }
    if (isRecord(body) && body.status === 'error') {
      throw new AllDebridError(apiErrorCode(body.error), `AllDebrid : ${apiErrorCode(body.error)}`);
    }
    if (!res.ok || !isRecord(body) || body.status !== 'success' || !isRecord(body.data)) {
      throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    }
    return body.data;
  }

  /** Lot de hashes : POST /v4/magnet/upload, suppression des magnets non prêts. Ne lève jamais. */
  private async checkBatch(batch: readonly string[]): Promise<Map<string, boolean>> {
    const found = new Map<string, boolean>();
    let entries: unknown[];
    try {
      const form = new URLSearchParams(batch.map((hash): [string, string] => ['magnets[]', hash]));
      const data = await this.request('POST', '/v4/magnet/upload', form);
      entries = Array.isArray(data.magnets) ? data.magnets : [];
    } catch {
      return found;
    }

    for (const entry of entries) {
      if (!isRecord(entry) || hasValue(entry.error)) continue;
      const hash = typeof entry.hash === 'string' ? entry.hash.toLowerCase() : '';
      if (!batch.includes(hash) || typeof entry.ready !== 'boolean') continue;
      found.set(hash, entry.ready);
      if (!entry.ready) await this.removeMagnet(entry.id);
    }
    return found;
  }

  /** Suppression best effort d'un magnet ajouté pour un simple contrôle. */
  private async removeMagnet(id: unknown): Promise<void> {
    const magnetId = idToString(id);
    if (magnetId === null) return;
    try {
      await this.request('POST', '/v4/magnet/delete', new URLSearchParams([['id', magnetId]]));
    } catch {
      // Sans effet sur le résultat du contrôle.
    }
  }

  private async uploadMagnet(hash: string): Promise<{ id: string; ready: boolean }> {
    const data = await this.request('POST', '/v4/magnet/upload', new URLSearchParams([['magnets[]', hash]]));
    const entries = Array.isArray(data.magnets) ? data.magnets : [];
    const entry = entries.find(isRecord);
    if (entry === undefined) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    if (hasValue(entry.error)) throw new AllDebridError(apiErrorCode(entry.error), 'AllDebrid : magnet refusé');
    const id = idToString(entry.id);
    if (id === null) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    return { id, ready: entry.ready === true };
  }

  private async waitReady(id: string, sleep: (ms: number) => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
      const data = await this.request('POST', '/v4.1/magnet/status', new URLSearchParams([['id', id]]));
      const entry = firstRecord(data.magnets);
      const statusCode = entry !== undefined && typeof entry.statusCode === 'number' ? entry.statusCode : undefined;
      if (statusCode === MAGNET_STATUS_READY) return;
      if (statusCode !== undefined && statusCode >= MAGNET_STATUS_ERROR_FROM) {
        throw new AllDebridError('magnet_failed', 'AllDebrid : magnet en erreur');
      }
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
    }
    throw new AllDebridError('not_ready', 'not_ready');
  }

  private async listFiles(id: string): Promise<FlatFile[]> {
    const data = await this.request('POST', '/v4/magnet/files', new URLSearchParams([['id[]', id]]));
    const entries = Array.isArray(data.magnets) ? data.magnets : [];
    const entry = entries.find(isRecord);
    if (entry === undefined) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    if (hasValue(entry.error)) throw new AllDebridError(apiErrorCode(entry.error), 'AllDebrid : fichiers indisponibles');
    if (!Array.isArray(entry.files)) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    return flattenFiles(entry.files);
  }
}
