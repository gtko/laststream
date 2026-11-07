import { LruCache } from '../cache/lru.js';
import type { KvCache } from '../platform/types.js';
import { parseEpisode } from '../parse/meta.js';

/** Fichier d'un torrent (pack) : index dans le torrent, nom tel que fourni par la source, taille en octets. */
export interface PackFile {
  idx: number;
  name: string;
  size: number;
}

/** Options du magasin de packs : nombre maximal de torrents, durée de vie, horloge injectable. */
export interface PackStoreOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
  /** Cache persistant partagé (Workers) : `learn` y écrit, `warm` le relit avant les recherches d'épisode. */
  kv?: KvCache;
  /** Rattache une écriture au cycle de vie de la requête (Scheduler.background). Défaut : écriture non attendue. */
  background?: (work: Promise<unknown>) => void;
}

/** Un torrent mémorisé dans un instantané JSON. `remainingMs` : durée de vie restante au moment du export. */
interface PackSnapshotEntry {
  infoHash: string;
  remainingMs: number;
  files: PackFile[];
}

/** Instantané JSON du magasin (version 1), du moins récent au plus récent. */
export interface PackSnapshot {
  version: 1;
  packs: PackSnapshotEntry[];
}

const DEFAULT_MAX = 2000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INFO_HASH = /^[0-9a-f]{40}$/;
const MAX_FILES_PER_PACK = 10_000;
const MAX_NAME_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Info-hash normalisé (minuscules, 40 caractères hexadécimaux) ou undefined. */
function normalizeInfoHash(value: string): string | undefined {
  const hash = value.trim().toLowerCase();
  return INFO_HASH.test(hash) ? hash : undefined;
}

/**
 * Fichiers valides, triés par index, sans doublon d'index. Les entrées mal formées sont ignorées ;
 * un nom trop long est tronqué ; le nombre de fichiers est plafonné.
 */
function cleanFiles(files: readonly unknown[]): PackFile[] {
  const seen = new Set<number>();
  const out: PackFile[] = [];
  for (const raw of files) {
    if (out.length >= MAX_FILES_PER_PACK) break;
    if (!isRecord(raw)) continue;
    const { idx, name, size } = raw;
    if (!isNonNegativeInteger(idx) || seen.has(idx)) continue;
    if (typeof name !== 'string' || typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue;
    seen.add(idx);
    out.push({ idx, name: name.slice(0, MAX_NAME_LENGTH), size });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/** Nom de fichier sans son dossier (séparateurs / et \). */
const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? name;

/**
 * Magasin des fichiers des packs (torrents multi-fichiers) déjà vus, pour retrouver un épisode
 * sans relister le torrent. Borné en nombre (LRU) et en durée (TTL, 30 jours par défaut).
 */
export class PackStore {
  private readonly cache: LruCache<PackFile[]>;
  private readonly kv: KvCache | undefined;
  private readonly ttlMs: number;
  private readonly background: (work: Promise<unknown>) => void;

  constructor(opts: PackStoreOptions = {}) {
    this.kv = opts.kv;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.background = opts.background ?? ((work) => void work.catch(() => undefined));
    this.cache = new LruCache<PackFile[]>({
      max: opts.max ?? DEFAULT_MAX,
      ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
      now: opts.now,
    });
  }

  /**
   * Mémorise les fichiers d'un torrent (remplace les précédents). Renvoie false, sans rien stocker,
   * si l'info-hash est invalide ou s'il ne reste aucun fichier valide.
   */
  learn(infoHash: string, files: readonly PackFile[]): boolean {
    const hash = normalizeInfoHash(infoHash);
    if (hash === undefined || !Array.isArray(files)) return false;
    const clean = cleanFiles(files);
    if (clean.length === 0) return false;
    this.cache.set(hash, clean);
    if (this.kv !== undefined) {
      this.background(this.kv.set(`pack:${hash}`, JSON.stringify(clean), Math.ceil(this.ttlMs / 1000)).catch(() => undefined));
    }
    return true;
  }

  /**
   * Recharge depuis le cache partagé les fichiers de ces torrents appris par d'autres instances. À appeler avant
   * `get` / `findEpisode` (qui restent synchrones). Sans cache partagé, ne fait rien ; une panne du cache est ignorée.
   */
  async warm(infoHashes: readonly string[]): Promise<void> {
    const kv = this.kv;
    if (kv === undefined) return;
    const hashes = [...new Set(infoHashes.map(normalizeInfoHash).filter((hash): hash is string => hash !== undefined))];
    await Promise.all(
      hashes.map(async (hash) => {
        if (this.cache.get(hash) !== undefined) return;
        try {
          const raw = await kv.get(`pack:${hash}`);
          if (raw === undefined) return;
          const files = cleanFiles(JSON.parse(raw) as unknown[]);
          if (files.length > 0) this.cache.set(hash, files);
        } catch {
          // Entrée illisible ou cache indisponible : traité comme absent.
        }
      }),
    );
  }

  /** Fichiers connus du torrent, triés par index (copie). Undefined si inconnu ou expiré. */
  get(infoHash: string): PackFile[] | undefined {
    const hash = normalizeInfoHash(infoHash);
    if (hash === undefined) return undefined;
    return this.cache.get(hash)?.map((file) => ({ ...file }));
  }

  /**
   * Fichier correspondant à un épisode (saison et numéro), reconnu dans le nom de fichier (S01E02, 1x02…).
   * Seul le nom sans dossier est analysé. Si plusieurs fichiers correspondent, le plus gros l'emporte
   * (les échantillons sont petits). Renvoie une copie de { idx, name, size } ou undefined.
   */
  findEpisode(infoHash: string, season: number, episode: number): PackFile | undefined {
    const hash = normalizeInfoHash(infoHash);
    if (hash === undefined || !isNonNegativeInteger(season) || !isNonNegativeInteger(episode)) return undefined;
    const files = this.cache.get(hash);
    if (files === undefined) return undefined;

    let best: PackFile | undefined;
    for (const file of files) {
      const info = parseEpisode(baseName(file.name));
      if (info.season !== season || info.episode !== episode) continue;
      if (best === undefined || file.size > best.size) best = file;
    }
    return best === undefined ? undefined : { ...best };
  }

  /** Instantané JSON (durées restantes, pas d'horodatages absolus). JSON.stringify(store) l'utilise. */
  toJSON(): PackSnapshot {
    return {
      version: 1,
      packs: this.cache.dump().map((entry) => ({
        infoHash: entry.key,
        remainingMs: Math.ceil(entry.remainingMs),
        files: entry.value.map((file) => ({ ...file })),
      })),
    };
  }

  /**
   * Recharge un instantané produit par toJSON. Donnée non fiable : toute entrée invalide ou déjà expirée
   * est ignorée, sans lever d'erreur. L'ordre de récence de l'instantané est conservé.
   */
  static fromJSON(data: unknown, opts: PackStoreOptions = {}): PackStore {
    const store = new PackStore(opts);
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.packs)) return store;
    for (const entry of data.packs as unknown[]) {
      if (!isRecord(entry) || typeof entry.infoHash !== 'string') continue;
      const hash = normalizeInfoHash(entry.infoHash);
      const remainingMs = entry.remainingMs;
      if (hash === undefined || typeof remainingMs !== 'number' || !(remainingMs > 0) || !Number.isFinite(remainingMs)) {
        continue;
      }
      if (!Array.isArray(entry.files)) continue;
      const files = cleanFiles(entry.files as unknown[]);
      if (files.length === 0) continue;
      store.cache.set(hash, files, remainingMs);
    }
    return store;
  }
}
