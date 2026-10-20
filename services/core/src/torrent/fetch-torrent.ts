import type { KvCache } from '../platform/types.js';
import { infoHashFromMagnet, isMagnet } from '../sources/indexers.js';
import {
  type BytesResult,
  type FetchFn,
  SourceError,
  fetchBytes,
  resolveOptions,
} from '../sources/http.js';
import { MAX_TORRENT_BYTES, TorrentFormatError, parseTorrent, type TorrentFile } from './bencode.js';

/**
 * Lecture d'un .torrent distant (lien proxifié par Prowlarr, trackers privés avec passkey).
 *
 * Secrets : l'URL de téléchargement peut porter une passkey ou une clé API. Elle n'est jamais journalisée ni
 * renvoyée dans un message d'erreur : chaque erreur passe par scrubUrl. Un magnet obtenu par redirection peut
 * contenir une passkey dans ses trackers : il est renvoyé à l'appelant, qui ne doit ni le journaliser ni l'exposer.
 */

/** Délai par défaut (réponse et lecture complète du corps), en millisecondes. */
export const TORRENT_FETCH_TIMEOUT_MS = 10_000;
/** Durée de vie d'une entrée du cache, en millisecondes (6 h). */
const TORRENT_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
/** Nombre maximal d'entrées du cache mémoire. */
const TORRENT_CACHE_MAX_ENTRIES = 200;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Résultat d'une lecture. `torrent` : fichier .torrent lu (octets gardés seulement s'il est privé).
 * `magnet` : Prowlarr a redirigé vers un magnet ; aucun octet, seulement l'infoHash et le magnet.
 */
export type FetchedTorrent =
  | { kind: 'torrent'; infoHash: string; files: TorrentFile[]; private: boolean; bytes?: Buffer }
  | { kind: 'magnet'; infoHash: string; magnet: string };

export interface FetchTorrentOptions {
  /** fetch injecté (tests). Par défaut : fetch global. */
  fetch?: FetchFn;
  /** Délai couvrant la réponse et la lecture du corps (défaut 10 s). */
  timeoutMs?: number;
  /** Cache à utiliser (défaut : cache partagé du module). Ignoré sans guid. */
  cache?: TorrentCache;
  /** Identifiant du release (guid Torznab) : clé de cache. Sans guid, rien n'est mis en cache. */
  guid?: string;
}

export interface TorrentCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
  /**
   * Cache persistant partagé entre instances (Workers). `load` y lit en cas d'absence en mémoire, `save` y écrit : un
   * .torrent privé lu à l'affichage des flux par une instance reste lisible par /play servi par une autre.
   */
  kv?: KvCache;
}

interface CacheEntry {
  value: FetchedTorrent;
  expiresAt: number;
}

/**
 * Cache mémoire par guid : TTL de 6 h, au plus 200 entrées (la plus ancienne part en premier).
 * Les octets d'un torrent public ne sont jamais gardés ; ceux d'un torrent privé le sont, pour être rejoués à la lecture.
 */
export class TorrentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly kv: KvCache | undefined;

  constructor(opts: TorrentCacheOptions = {}) {
    this.kv = opts.kv;
    this.ttlMs = opts.ttlMs ?? TORRENT_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? TORRENT_CACHE_MAX_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
  }

  get(key: string): FetchedTorrent | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: FetchedTorrent): void {
    const kept = withoutPublicBytes(value);
    const now = this.now();
    for (const [stored, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(stored);
    }
    // Réinsertion : la clé devient la plus récente.
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value: kept, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  /** Comme `get`, avec le cache partagé en second niveau (absent en mémoire). Une panne du cache est ignorée. */
  async load(key: string): Promise<FetchedTorrent | undefined> {
    const local = this.get(key);
    if (local !== undefined || this.kv === undefined) return local;
    try {
      const raw = await this.kv.get(`torrent:${key}`);
      const stored = raw === undefined ? undefined : parseStored(raw);
      if (stored !== undefined) this.set(key, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  /** Comme `set`, avec écriture dans le cache partagé (mêmes règles : octets des seuls torrents privés). */
  async save(key: string, value: FetchedTorrent): Promise<void> {
    this.set(key, value);
    if (this.kv === undefined) return;
    await this.kv.set(`torrent:${key}`, serializeStored(withoutPublicBytes(value)), Math.ceil(this.ttlMs / 1000)).catch(() => undefined);
  }
}

/** Torrent sérialisé en JSON (octets en base64). */
function serializeStored(value: FetchedTorrent): string {
  if (value.kind === 'magnet') return JSON.stringify(value);
  const { bytes, ...rest } = value;
  return JSON.stringify(bytes === undefined ? rest : { ...rest, bytes: bytes.toString('base64') });
}

/** Torrent relu du cache partagé, ou undefined si le contenu est illisible. */
function parseStored(raw: string): FetchedTorrent | undefined {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof value.infoHash !== 'string') return undefined;
  if (value.kind === 'magnet') {
    return typeof value.magnet === 'string' ? { kind: 'magnet', infoHash: value.infoHash, magnet: value.magnet } : undefined;
  }
  if (value.kind !== 'torrent' || !Array.isArray(value.files) || typeof value.private !== 'boolean') return undefined;
  const bytes = typeof value.bytes === 'string' ? Buffer.from(value.bytes, 'base64') : undefined;
  return { kind: 'torrent', infoHash: value.infoHash, files: value.files as TorrentFile[], private: value.private, ...(bytes === undefined ? {} : { bytes }) };
}

function withoutPublicBytes(value: FetchedTorrent): FetchedTorrent {
  if (value.kind === 'magnet' || value.private) return value;
  return { kind: 'torrent', infoHash: value.infoHash, files: value.files, private: false };
}

const sharedCache = new TorrentCache();

/**
 * Masque les secrets d'un texte (message d'erreur, journal) : valeurs de passkey=, apikey=, api_key= et token=,
 * et segment qui suit /rss/ ou /download/. Le reste du texte est inchangé.
 */
export function scrubUrl(text: string): string {
  return text
    .replace(/(passkey|apikey|api_key|token)=[^&#\s"'<>]*/gi, '$1=***')
    .replace(/(\/(?:rss|download)\/)[^/?#\s"'<>]+/gi, '$1***');
}

/** Erreur interne : la redirection pointe vers un magnet (pas une erreur, un résultat). Sous-classe de SourceError. */
class MagnetRedirect extends SourceError {
  readonly magnet: string;

  constructor(magnet: string) {
    super('redirection vers un magnet');
    this.name = 'MagnetRedirect';
    this.magnet = magnet;
  }
}

/**
 * fetch qui intercepte une redirection vers un magnet : le corps est annulé et MagnetRedirect est levée.
 * fetchBytes relaie les SourceError telles quelles, donc la chaîne de redirection s'arrête là, sans saut vers un schéma non http.
 */
function magnetAware(fetchFn: FetchFn): FetchFn {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')?.trim() ?? '';
      if (isMagnet(location)) {
        await response.body?.cancel().catch(() => undefined);
        throw new MagnetRedirect(location);
      }
    }
    return response;
  };
}

function magnetResult(magnet: string): FetchedTorrent {
  const infoHash = infoHashFromMagnet(magnet);
  if (infoHash === undefined) throw new SourceError('magnet sans infoHash');
  return { kind: 'magnet', infoHash, magnet };
}

async function download(downloadUrl: string, opts: FetchTorrentOptions): Promise<FetchedTorrent> {
  if (isMagnet(downloadUrl)) return magnetResult(downloadUrl);
  const { fetchFn, timeoutMs } = resolveOptions({ fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? TORRENT_FETCH_TIMEOUT_MS });
  let result: BytesResult;
  try {
    result = await fetchBytes(
      magnetAware(fetchFn),
      downloadUrl,
      { headers: { Accept: 'application/x-bittorrent, */*;q=0.1' } },
      timeoutMs,
      { maxBytes: MAX_TORRENT_BYTES },
    );
  } catch (err) {
    if (err instanceof MagnetRedirect) return magnetResult(err.magnet);
    throw err;
  }
  if (!result.ok) throw new SourceError(`HTTP ${result.status}`);
  // Content-type non exigé : le contenu est validé par le parseur, pas par l'en-tête.
  const info = parseTorrent(result.bytes);
  return {
    kind: 'torrent',
    infoHash: info.infoHash,
    files: info.files,
    private: info.private,
    bytes: info.private ? Buffer.from(result.bytes) : undefined,
  };
}

/** Message d'erreur sûr : jamais d'URL ni de secret, seulement un code générique ou un message de transport masqué. */
function safeError(err: unknown): SourceError {
  if (err instanceof TorrentFormatError) return new SourceError(`torrent invalide (${err.code})`);
  if (err instanceof SourceError) return new SourceError(scrubUrl(err.message));
  return new SourceError('erreur inattendue');
}

/**
 * Lit le .torrent d'un lien de téléchargement (garde SSRF de fetchBytes, redirections revérifiées, 5 Mo max).
 * Une redirection vers un magnet donne {kind:'magnet', infoHash, magnet} sans octets. Avec `guid`, le résultat
 * est mis en cache (TTL 6 h) ; les octets ne sont gardés que pour un torrent privé.
 * Lève une SourceError sans URL ni secret.
 */
export async function fetchTorrent(downloadUrl: string, opts: FetchTorrentOptions = {}): Promise<FetchedTorrent> {
  const cache = opts.cache ?? sharedCache;
  const key = opts.guid;
  if (key !== undefined) {
    const cached = await cache.load(key);
    if (cached !== undefined) return cached;
  }
  try {
    const fetched = await download(downloadUrl, opts);
    if (key !== undefined) await cache.save(key, fetched);
    return fetched;
  } catch (err) {
    throw safeError(err);
  }
}
