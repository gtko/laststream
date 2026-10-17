/**
 * Client AllDebrid (API v4 / v4.1), écrit à partir de la documentation officielle de l'API.
 *
 * Règles de sécurité : la clé API ne part que dans l'en-tête Authorization. Aucune erreur
 * ne contient la clé, la configuration ni les URL retournées : seuls des codes génériques sortent.
 *
 * Contrôle « cache » : la documentation ne décrit aucun endpoint de disponibilité instantanée. Le contrôle ajoute
 * donc le magnet au compte (POST /v4/magnet/upload). Seuls les magnets créés par ce contrôle, c'est-à-dire absents
 * de la liste du compte lue juste avant l'envoi, peuvent être supprimés. Un magnet déjà présent (téléchargement de
 * l'utilisateur) ou utilisé par une résolution en cours n'est jamais supprimé.
 */

import { randomBytes } from 'node:crypto';
import { MAX_BODY_BYTES, readBodyLimited } from './http.js';

const API_BASE = 'https://api.alldebrid.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POSITIVE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_NEGATIVE_TTL_MS = 30 * 60 * 1_000;
const BATCH_FAILURE_TTL_MS = 30_000;
const DEFAULT_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;
const CHECK_BATCH_SIZE = 20;
const CHECK_CONCURRENCY = 3;
const DELETE_CONCURRENCY = 3;
const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1_500;
const RESOLVE_TTL_MS = 3_600_000;
const MAX_CACHE_ENTRIES = 5_000;
const MAX_NAME_LENGTH = 512;
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
  /** TTL d'un hash reconnu prêt (défaut 6 h). */
  cacheTtlMs?: number;
  /** TTL d'un hash non prêt (défaut 30 min). */
  negativeCacheTtlMs?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
  /**
   * Appelé quand une résolution porte sur un pack (plusieurs fichiers) : liste aplatie des fichiers, idx = position
   * dans cette liste. Une exception levée par le rappel n'interrompt pas la résolution.
   */
  onFiles?: (infoHash: string, files: DebridFileInfo[]) => void;
}

/** Fichier d'un magnet tel que listé par AllDebrid : position, nom et taille en octets. */
export interface DebridFileInfo {
  idx: number;
  name: string;
  size: number;
}

export interface ApiKeyCheck {
  ok: boolean;
  error?: string;
  premium?: boolean;
}

export interface ResolveOptions {
  season?: number;
  episode?: number;
  /** Nom de fichier attendu (behaviorHints.filename de Stremio). */
  filename?: string;
  /** Taille attendue du fichier vidéo, en octets (behaviorHints.videoSize de Stremio). */
  size?: number;
  /** Délai entre deux interrogations de statut (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedLink {
  url: string;
  filename: string;
  size: number;
}

/** Critères de choix du fichier. L'index Stremio n'est utilisé qu'avec une taille concordante. */
interface Selection {
  fileIdx?: number;
  filename?: string;
  size?: number;
  season?: number;
  episode?: number;
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

function safeIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH ? trimmed : undefined;
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

function liveValue<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const entry = cache.get(key);
  return entry !== undefined && entry.expiresAt > now ? entry.value : undefined;
}

/** Délai de recul après HTTP 429/503 : Retry-After (secondes ou date HTTP), sinon 30 s ; plafonné. */
function backoffMs(retryAfter: string | null, now: number): number {
  const value = retryAfter?.trim() ?? '';
  let ms = DEFAULT_BACKOFF_MS;
  if (/^\d{1,7}$/.test(value)) {
    ms = Number(value) * 1_000;
  } else {
    const date = Date.parse(value);
    if (!Number.isNaN(date)) ms = date - now;
  }
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
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

/** Nom sans dossier, en minuscules, sans extension vidéo : sert à comparer un nom attendu à un fichier. */
function stemOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).trim().toLowerCase();
  return isVideo(base) ? base.slice(0, base.lastIndexOf('.')) : base;
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

/**
 * Choisit le fichier vidéo. Ordre : nom attendu, taille attendue, épisode demandé, index Stremio
 * (seulement si sa taille correspond à la taille attendue), puis le plus gros fichier vidéo.
 * L'index Stremio ne désigne pas forcément le même fichier dans la liste aplatie d'AllDebrid.
 */
function pickFile(files: readonly FlatFile[], sel: Selection): FlatFile {
  if (files.length === 0) throw new AllDebridError('no_file', 'aucun fichier');
  const videos = files.filter((file) => isVideo(file.name));
  if (videos.length === 0) throw new AllDebridError('no_file', 'aucun fichier vidéo');
  const { fileIdx, filename, size, season, episode } = sel;

  if (filename !== undefined) {
    const wanted = stemOf(filename);
    const named = videos.filter((file) => stemOf(file.name) === wanted);
    if (named.length > 0) return largest(named);
  }

  let candidates = videos;
  if (size !== undefined) {
    const sized = videos.filter((file) => file.size === size);
    if (sized.length === 1) return sized[0];
    if (sized.length > 1) candidates = sized;
  }

  if (season !== undefined && episode !== undefined) {
    const matches = candidates.filter((file) => matchesEpisode(file.name, season, episode));
    if (matches.length > 0) return largest(matches);
  }

  if (fileIdx !== undefined && size !== undefined && fileIdx < files.length) {
    const indexed = files[fileIdx];
    if (isVideo(indexed.name) && indexed.size === size) return indexed;
  }
  return largest(candidates);
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

function selectionKey(hash: string, sel: Selection): string {
  return JSON.stringify([hash, sel.fileIdx ?? null, sel.filename ?? null, sel.size ?? null, sel.season ?? null, sel.episode ?? null]);
}

/** Nom d'envoi d'un fichier .torrent quand l'appelant n'en fournit pas (le nom réel vient du .torrent). */
const TORRENT_UPLOAD_NAME = 'lastaddon.torrent';
const MAX_FILENAME_LENGTH = 255;

/** Corps multipart/form-data déjà encodé, avec son Content-Type (boundary comprise). */
interface MultipartBody {
  body: Buffer;
  contentType: string;
}

/** Origine d'une préparation : le magnet du hash (défaut) ou le fichier .torrent (torrent privé, octets fournis). */
type PrepareSource = { kind: 'magnet' } | { kind: 'file'; bytes: Buffer };
const MAGNET_SOURCE: PrepareSource = { kind: 'magnet' };

/**
 * Corps multipart/form-data écrit à la main pour un seul champ fichier `files[]`. Boundary aléatoire (128 bits) ;
 * le nom est assaini (guillemets, antislash et sauts de ligne remplacés) pour rester dans l'en-tête Content-Disposition.
 */
function multipartFile(filename: string, bytes: Buffer): MultipartBody {
  const boundary = `----lastaddon${randomBytes(16).toString('hex')}`;
  const safeName = filename.replace(/["\\\r\n]/g, '_').slice(0, MAX_FILENAME_LENGTH) || TORRENT_UPLOAD_NAME;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${safeName}"\r\n` +
      'Content-Type: application/x-bittorrent\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Corps d'une requête : formulaire urlencodé, ou multipart déjà encodé avec son Content-Type. */
function bodyOf(form: URLSearchParams | MultipartBody | undefined): {
  body: URLSearchParams | Buffer | undefined;
  contentType: string | undefined;
} {
  if (form === undefined || form instanceof URLSearchParams) return { body: form, contentType: undefined };
  return { body: form.body, contentType: form.contentType };
}

export class AllDebridClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly onFiles: ((infoHash: string, files: DebridFileInfo[]) => void) | undefined;
  /** Résultats de contrôle par hash (true = prêt, false = non prêt). */
  private readonly checkCache = new Map<string, CacheEntry<boolean>>();
  /** Hashes d'un lot en erreur ou absents de la réponse : inconnus pendant BATCH_FAILURE_TTL_MS. */
  private readonly failCache = new Map<string, CacheEntry<boolean>>();
  private readonly resolveCache = new Map<string, CacheEntry<ResolvedLink>>();
  /** Contrôle en cours par hash : une résolution attend sa fin avant d'envoyer le même magnet. */
  private readonly checking = new Map<string, Promise<void>>();
  /** Préparation partagée par hash (upload, attente, liste des fichiers). */
  private readonly preparing = new Map<string, Promise<FlatFile[]>>();
  /** Résolutions en cours, par clé de sélection. */
  private readonly resolving = new Map<string, Promise<ResolvedLink>>();
  /** Résolutions en cours par hash : tant que le compteur est positif, rien n'est supprimé pour ce hash. */
  private readonly activeResolves = new Map<string, number>();
  /** Fin du délai de recul après HTTP 429 ou 503. */
  private backoffUntil = 0;

  constructor(apiKey: string, opts: AllDebridClientOptions = {}) {
    if (apiKey.length === 0) {
      throw new Error('Clé AllDebrid manquante');
    }
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.positiveTtlMs = opts.cacheTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
    this.negativeTtlMs = opts.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onFiles = opts.onFiles;
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
   * Indique pour chaque hash s'il est prêt chez AllDebrid. Absent de la Map = inconnu (lot en erreur,
   * hash en cours de résolution, délai de recul après 429/503). Ne lève jamais.
   * Les clés de la Map sont les hashes en minuscules.
   */
  async checkCached(hashes: readonly string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    const unique = [...new Set(hashes.map(normalizeHash).filter((hash): hash is string => hash !== null))];
    const now = this.now();
    const missing: string[] = [];
    const waited: string[] = [];
    const waits: Promise<void>[] = [];
    for (const hash of unique) {
      // Magnet utilisé par une résolution en cours : aucun contrôle pour ce hash.
      if (this.activeResolves.has(hash)) continue;
      const known = liveValue(this.checkCache, hash, now);
      if (known !== undefined) {
        result.set(hash, known);
      } else if (liveValue(this.failCache, hash, now) === undefined) {
        const inFlight = this.checking.get(hash);
        if (inFlight !== undefined) {
          waited.push(hash);
          waits.push(inFlight);
        } else {
          missing.push(hash);
        }
      }
    }

    // Les contrôles sont enregistrés avant tout await : un appel concurrent attend au lieu de relancer l'upload.
    const finish = new Map<string, () => void>();
    for (const hash of missing) {
      this.checking.set(
        hash,
        new Promise<void>((resolve) => {
          finish.set(hash, () => resolve());
        }),
      );
    }

    await runLimited(chunk(missing, CHECK_BATCH_SIZE), CHECK_CONCURRENCY, async (batch) => {
      try {
        const found = await this.checkBatch(batch);
        const at = this.now();
        for (const hash of batch) {
          const cached = found.get(hash);
          if (cached === undefined) {
            pruneExpired(this.failCache, at);
            this.failCache.set(hash, { value: true, expiresAt: at + BATCH_FAILURE_TTL_MS });
            continue;
          }
          pruneExpired(this.checkCache, at);
          this.checkCache.set(hash, { value: cached, expiresAt: at + (cached ? this.positiveTtlMs : this.negativeTtlMs) });
          result.set(hash, cached);
        }
      } finally {
        for (const hash of batch) {
          this.checking.delete(hash);
          finish.get(hash)?.();
        }
      }
    });

    await Promise.all(waits);
    const later = this.now();
    for (const hash of waited) {
      const value = liveValue(this.checkCache, hash, later);
      if (value !== undefined) result.set(hash, value);
    }
    return result;
  }

  /**
   * Résout un hash en lien de téléchargement direct. Les résolutions concurrentes d'un même hash partagent
   * l'upload et l'attente ; chaque appel choisit ensuite son fichier.
   * Lève AllDebridError : `not_ready` si le magnet n'est pas prêt après les interrogations,
   * `no_file` si aucun fichier vidéo, `magnet_failed` en cas d'erreur côté AllDebrid.
   */
  async resolve(infoHash: string, fileIdx?: number, opts: ResolveOptions = {}): Promise<ResolvedLink> {
    const hash = normalizeHash(infoHash);
    if (hash === null) throw new AllDebridError('invalid_hash', 'hash invalide');
    return this.resolveSelected(hash, fileIdx, opts, MAGNET_SOURCE);
  }

  /**
   * Comme resolve(), pour un torrent privé dont on fournit le fichier .torrent (octets) : le fichier est envoyé à
   * AllDebrid au lieu du magnet, qui n'a pas la passkey. Choix du fichier, déblocage et cache sont ceux de resolve()
   * (cache et dédoublonnage séparés du magnet). Lève les mêmes erreurs, plus invalid_torrent si les octets sont vides.
   */
  async resolveTorrentFile(
    bytes: Buffer,
    infoHash: string,
    fileIdx?: number,
    opts: ResolveOptions = {},
  ): Promise<ResolvedLink> {
    const hash = normalizeHash(infoHash);
    if (hash === null) throw new AllDebridError('invalid_hash', 'hash invalide');
    if (bytes.byteLength === 0) throw new AllDebridError('invalid_torrent', 'torrent vide');
    return this.resolveSelected(hash, fileIdx, opts, { kind: 'file', bytes: Buffer.from(bytes) });
  }

  private async resolveSelected(
    hash: string,
    fileIdx: number | undefined,
    opts: ResolveOptions,
    source: PrepareSource,
  ): Promise<ResolvedLink> {
    const sel: Selection = {
      fileIdx: safeIndex(fileIdx),
      filename: cleanName(opts.filename),
      size: positiveSize(opts.size),
      season: safeIndex(opts.season),
      episode: safeIndex(opts.episode),
    };
    const key = `${source.kind === 'file' ? 'file:' : ''}${selectionKey(hash, sel)}`;
    const cached = this.resolveCache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.value;
    const pending = this.resolving.get(key);
    if (pending !== undefined) return pending;

    const sleep = opts.sleep ?? defaultSleep;
    this.markActive(hash, 1);
    const run = (async (): Promise<ResolvedLink> => {
      try {
        const value = await this.resolveUncached(hash, sel, sleep, source);
        const at = this.now();
        pruneExpired(this.resolveCache, at);
        this.resolveCache.set(key, { value, expiresAt: at + RESOLVE_TTL_MS });
        return value;
      } finally {
        this.resolving.delete(key);
        this.markActive(hash, -1);
      }
    })();
    this.resolving.set(key, run);
    return run;
  }

  private markActive(hash: string, delta: 1 | -1): void {
    const count = (this.activeResolves.get(hash) ?? 0) + delta;
    if (count > 0) this.activeResolves.set(hash, count);
    else this.activeResolves.delete(hash);
  }

  private async resolveUncached(
    hash: string,
    sel: Selection,
    sleep: (ms: number) => Promise<void>,
    source: PrepareSource,
  ): Promise<ResolvedLink> {
    const files = await this.prepareFiles(hash, sleep, source);
    if (files.length > 1) this.notifyFiles(hash, files);
    const file = pickFile(files, sel);

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

  /** Transmet la liste d'un pack au rappel onFiles. Une erreur du rappel est ignorée : elle ne doit pas casser la résolution. */
  private notifyFiles(hash: string, files: readonly FlatFile[]): void {
    if (this.onFiles === undefined) return;
    try {
      this.onFiles(
        hash,
        files.map((file, idx) => ({ idx, name: file.name, size: file.size })),
      );
    } catch {
      // Sans effet sur la résolution.
    }
  }

  /** Upload, attente éventuelle et liste des fichiers, partagés par les résolutions concurrentes du hash. */
  private prepareFiles(
    hash: string,
    sleep: (ms: number) => Promise<void>,
    source: PrepareSource = MAGNET_SOURCE,
  ): Promise<FlatFile[]> {
    // Clé distincte pour le fichier .torrent : un upload de fichier ne partage pas la préparation du magnet.
    const slot = source.kind === 'file' ? `file:${hash}` : hash;
    const pending = this.preparing.get(slot);
    if (pending !== undefined) return pending;
    const run = (async (): Promise<FlatFile[]> => {
      await this.checking.get(hash);
      const added = source.kind === 'file' ? await this.uploadTorrentFile(source.bytes) : await this.uploadMagnet(hash);
      if (!added.ready) await this.waitReady(added.id, sleep);
      return this.listFiles(added.id);
    })();
    this.preparing.set(slot, run);
    const forget = (): void => {
      this.preparing.delete(slot);
    };
    run.then(forget, forget);
    return run;
  }

  /**
   * Appel brut de l'API (chemin /v4/…) avec les mêmes erreurs, le même recul 429/503 et la même clé que les autres appels.
   * Réservé aux modules compagnons (hébergeurs) : même sécurité que request().
   */
  call(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
    return this.request(method, path, form);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams | MultipartBody,
  ): Promise<Record<string, unknown>> {
    if (this.now() < this.backoffUntil) throw new AllDebridError('rate_limited', 'rate limited');
    const payload = bodyOf(form);
    let res: Response;
    try {
      // Pas de redirection suivie (une 3xx arrive en réponse invalide) ; corps borné à MAX_BODY_BYTES.
      res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(payload.contentType === undefined ? {} : { 'Content-Type': payload.contentType }),
        },
        body: payload.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw isTimeoutError(err)
        ? new AllDebridError('timeout', 'AllDebrid : délai dépassé')
        : new AllDebridError('network', 'AllDebrid : réseau indisponible');
    }
    if (res.status === 429 || res.status === 503) {
      // Recul global : aucune nouvelle requête avant la fin du délai, sans boucle de nouvel essai.
      this.backoffUntil = this.now() + backoffMs(res.headers.get('retry-after'), this.now());
      throw new AllDebridError('rate_limited', 'rate limited');
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBodyLimited(res, MAX_BODY_BYTES));
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

  /**
   * Lot de hashes : liste des magnets du compte, puis upload, puis suppression des seuls magnets créés
   * par cet upload qui ne sont pas prêts. Renvoie une Map vide en cas d'échec. Ne lève jamais.
   */
  private async checkBatch(batch: readonly string[]): Promise<Map<string, boolean>> {
    const found = new Map<string, boolean>();
    let existing: Set<string>;
    try {
      existing = await this.listMagnetIds();
    } catch {
      // Sans liste de référence, rien n'est envoyé : un magnet déjà présent ne peut pas être distingué.
      return found;
    }

    let entries: unknown[];
    try {
      const form = new URLSearchParams(batch.map((hash): [string, string] => ['magnets[]', hash]));
      const data = await this.request('POST', '/v4/magnet/upload', form);
      entries = Array.isArray(data.magnets) ? data.magnets : [];
    } catch {
      return found;
    }

    const removable: { hash: string; id: string }[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || hasValue(entry.error)) continue;
      const hash = typeof entry.hash === 'string' ? entry.hash.toLowerCase() : '';
      if (!batch.includes(hash) || typeof entry.ready !== 'boolean') continue;
      found.set(hash, entry.ready);
      // L'upload renvoie l'id existant si le magnet est déjà dans le compte : seul un id absent de la liste est à nous.
      const id = idToString(entry.id);
      if (!entry.ready && id !== null && !existing.has(id)) removable.push({ hash, id });
    }

    await runLimited(removable, DELETE_CONCURRENCY, async ({ hash, id }) => {
      if (this.activeResolves.has(hash)) return;
      await this.removeMagnet(id);
    });
    return found;
  }

  /** Identifiants des magnets déjà présents dans le compte (POST /v4.1/magnet/status sans id). Lève si la liste est invalide. */
  private async listMagnetIds(): Promise<Set<string>> {
    const data = await this.request('POST', '/v4.1/magnet/status');
    if (!Array.isArray(data.magnets)) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    const ids = new Set<string>();
    for (const entry of data.magnets) {
      const id = isRecord(entry) ? idToString(entry.id) : null;
      if (id === null) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
      ids.add(id);
    }
    return ids;
  }

  /** Suppression best effort d'un magnet ajouté pour un simple contrôle. */
  private async removeMagnet(magnetId: string): Promise<void> {
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

  /**
   * Ajoute un fichier .torrent au compte (POST /v4/magnet/upload/file, multipart, champ `files[]`). Sert aux torrents
   * privés, dont le fichier porte la passkey. Renvoie l'id, l'état prêt et le hash du magnet créé ou déjà présent.
   * Lève AllDebridError ; le message ne contient ni les octets ni la clé.
   */
  async uploadTorrentFile(bytes: Buffer, filename?: string): Promise<{ id: string; ready: boolean; hash: string }> {
    const data = await this.request('POST', '/v4/magnet/upload/file', multipartFile(filename ?? TORRENT_UPLOAD_NAME, bytes));
    const entries = Array.isArray(data.magnets) ? data.magnets : [];
    const entry = entries.find(isRecord);
    if (entry === undefined) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    if (hasValue(entry.error)) throw new AllDebridError(apiErrorCode(entry.error), 'AllDebrid : torrent refusé');
    const id = idToString(entry.id);
    const hash = typeof entry.hash === 'string' ? normalizeHash(entry.hash) : null;
    if (id === null || hash === null) throw new AllDebridError('invalid_response', 'AllDebrid : réponse invalide');
    return { id, ready: entry.ready === true, hash };
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
