import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchBytes, type FetchFn, isRecord, SourceError } from '../sources/http.js';

/** Liste Fribb (anime-lists, version mini) : correspondances anime ↔ IMDb / TVDB / TMDB et saison. */
export const FRIBB_ANIME_LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_MAX_AGE_MS = DAY_MS;
const DEFAULT_MEMORY_TTL_MS = DAY_MS;
const DEFAULT_RETRY_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 20 * 1024 * 1024;
const IMDB_ID = /^tt\d+$/;

/** Épisode absolu (numérotation continue d'un anime) relié à une saison et un numéro d'épisode. */
export interface EpisodeMapping {
  absolute: number;
  season: number;
  episode: number;
}

/**
 * Entrée de la table de remappage pour une série (identifiant IMDb).
 * - season : saison de la série à laquelle l'entrée correspond (TVDB, à défaut TMDB) ;
 * - episodeOffset : nombre d'épisodes absolus qui précèdent cette saison (la saison 1 vaut 0 par défaut) ;
 * - episodeCount : nombre d'épisodes de la saison, s'il est connu ;
 * - episodes : correspondances explicites (ex. groupe TMDB « absolu »), prioritaires sur le décalage.
 */
export interface AnimeEntry {
  imdbId: string;
  type?: string;
  season?: number;
  episodeOffset?: number;
  episodeCount?: number;
  episodes?: readonly EpisodeMapping[];
}

/** Saison et numéro d'épisode d'une série. */
export interface SeasonEpisode {
  season: number;
  episode: number;
}

type Index = ReadonlyMap<string, readonly AnimeEntry[]>;

const EMPTY_INDEX: Index = new Map();

const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

/** Identifiant IMDb normalisé (tt suivi de chiffres, minuscules) ou undefined. */
function normalizeImdbId(value: string): string | undefined {
  const id = value.trim().toLowerCase();
  return IMDB_ID.test(id) ? id : undefined;
}

/** Numéro de saison d'après un objet { tvdb, tmdb } : TVDB d'abord, puis TMDB. */
function seasonFromIds(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (isNonNegativeInteger(value.tvdb)) return value.tvdb;
  if (isNonNegativeInteger(value.tmdb)) return value.tmdb;
  return undefined;
}

/**
 * Analyse la liste Fribb (tableau JSON). Les entrées sans identifiant IMDb valide et les films sont ignorées.
 * Lève SourceError si la racine n'est pas un tableau.
 */
export function parseFribbList(json: unknown): AnimeEntry[] {
  if (!Array.isArray(json)) throw new SourceError('liste anime au format inattendu');
  const entries: AnimeEntry[] = [];
  for (const raw of json as unknown[]) {
    if (!isRecord(raw) || raw.type === 'MOVIE') continue;
    const imdbId = typeof raw.imdb_id === 'string' ? normalizeImdbId(raw.imdb_id) : undefined;
    if (imdbId === undefined) continue;
    const entry: AnimeEntry = { imdbId };
    if (typeof raw.type === 'string') entry.type = raw.type;
    const season = seasonFromIds(raw.season);
    if (season !== undefined) entry.season = season;
    entries.push(entry);
  }
  return entries;
}

/**
 * Construit des correspondances explicites à partir des groupes d'épisodes TMDB (episode_groups).
 * Attendu : les groupes de type absolu, où episodes[].order est l'index 0-based dans la série continue
 * (absolu = order + 1), avec season_number et episode_number. Les entrées invalides sont ignorées ; si un
 * même absolu apparaît plusieurs fois, la première occurrence gagne. Résultat trié par absolu.
 */
export function fromTmdbEpisodeGroups(groups: unknown): EpisodeMapping[] {
  if (!Array.isArray(groups)) return [];
  const byAbsolute = new Map<number, EpisodeMapping>();
  for (const group of groups as unknown[]) {
    if (!isRecord(group) || !Array.isArray(group.episodes)) continue;
    for (const raw of group.episodes as unknown[]) {
      if (!isRecord(raw)) continue;
      const { order, season_number: season, episode_number: episode } = raw;
      if (!isNonNegativeInteger(order) || !isNonNegativeInteger(season) || !isPositiveInteger(episode)) continue;
      const absolute = order + 1;
      if (!byAbsolute.has(absolute)) byAbsolute.set(absolute, { absolute, season, episode });
    }
  }
  return [...byAbsolute.values()].sort((a, b) => a.absolute - b.absolute);
}

/** Décalage utilisable d'une entrée : fourni (valide) ou 0 pour la saison 1. Undefined si inconnu. */
function seasonOffset(entry: AnimeEntry): number | undefined {
  if (entry.episodeOffset !== undefined) return isNonNegativeInteger(entry.episodeOffset) ? entry.episodeOffset : undefined;
  return entry.season === 1 ? 0 : undefined;
}

const hasEpisodes = (entry: AnimeEntry): boolean => (entry.episodes?.length ?? 0) > 0;

function indexByImdb(entries: readonly AnimeEntry[]): Index {
  const index = new Map<string, AnimeEntry[]>();
  for (const entry of entries) {
    const id = normalizeImdbId(entry.imdbId);
    if (id === undefined) continue;
    const list = index.get(id) ?? [];
    list.push(entry);
    index.set(id, list);
  }
  return index;
}

/** Contenu d'un fichier de cache, ou undefined si absent, illisible, ou plus vieux que maxAgeMs. */
async function readCacheFile(file: string, now: number, maxAgeMs?: number): Promise<string | undefined> {
  try {
    if (maxAgeMs !== undefined) {
      const info = await stat(file);
      if (now - info.mtimeMs >= maxAgeMs) return undefined;
    }
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Écriture atomique (fichier temporaire puis renommage). Le cache disque est facultatif : erreurs ignorées. */
async function writeCacheFile(file: string, text: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  } catch {
    // Pas de cache disque : la liste reste utilisable en mémoire.
  }
}

function tryParseList(text: string | undefined): AnimeEntry[] | undefined {
  if (text === undefined) return undefined;
  try {
    return parseFribbList(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export interface FribbListOptions {
  fetch?: FetchFn;
  /** Fichier de cache disque. Frais (< 24 h) : lu sans réseau. Réseau en panne : le cache périmé sert de repli. */
  cacheFile?: string;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Charge la liste Fribb. Ordre : cache disque frais, puis téléchargement (corps borné, redirections revalidées),
 * puis cache disque périmé si le téléchargement échoue. Lève SourceError si aucune source n'est utilisable.
 * Les URL et messages d'erreur ne sont jamais exposés.
 */
export async function fetchFribbList(opts: FribbListOptions = {}): Promise<AnimeEntry[]> {
  const now = opts.now ?? Date.now;
  const cacheFile = opts.cacheFile;

  if (cacheFile !== undefined) {
    const fresh = tryParseList(await readCacheFile(cacheFile, now(), LIST_MAX_AGE_MS));
    if (fresh !== undefined) return fresh;
  }

  try {
    const result = await fetchBytes(
      opts.fetch ?? fetch,
      FRIBB_ANIME_LIST_URL,
      { headers: { accept: 'application/json' } },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      { maxBytes: LIST_MAX_BYTES },
    );
    if (!result.ok) throw new SourceError(`liste anime indisponible (HTTP ${result.status})`);
    const text = new TextDecoder('utf-8').decode(result.bytes);
    const entries = parseFribbList(JSON.parse(text));
    if (cacheFile !== undefined) await writeCacheFile(cacheFile, text);
    return entries;
  } catch (err) {
    if (cacheFile !== undefined) {
      const stale = tryParseList(await readCacheFile(cacheFile, now()));
      if (stale !== undefined) return stale;
    }
    if (err instanceof SourceError) throw err;
    throw new SourceError('liste anime indisponible');
  }
}

export interface AnimeMapperOptions {
  /** Source de la table de remappage (ex. fetchFribbList). Peut être remplacée par une fixture en test. */
  loadMap: () => Promise<readonly AnimeEntry[]>;
  /** Durée de vie de la table en mémoire (24 h par défaut). */
  ttlMs?: number;
  /** Délai avant nouvelle tentative après un échec sans table en mémoire (10 min par défaut). */
  retryAfterMs?: number;
  now?: () => number;
}

/**
 * Remappage anime : numérotation absolue ↔ saison/épisode, pour une série identifiée par IMDb.
 * La table est chargée une fois, gardée en mémoire ttlMs, et partagée entre appels simultanés.
 * En cas d'échec du chargement, la table précédente (même périmée) reste utilisée. Sans table, les méthodes
 * renvoient undefined : elles ne lèvent jamais.
 */
export class AnimeMapper {
  private readonly loadMap: () => Promise<readonly AnimeEntry[]>;
  private readonly ttlMs: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private index: Index | undefined;
  private loadedAt = 0;
  private failedAt: number | undefined;
  private loading: Promise<Index> | undefined;

  constructor(opts: AnimeMapperOptions) {
    this.loadMap = opts.loadMap;
    this.ttlMs = opts.ttlMs ?? DEFAULT_MEMORY_TTL_MS;
    this.retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Numéro absolu d'un épisode (saison, épisode) d'une série. Une table explicite (groupes TMDB) prime sur le
   * décalage ; sans table explicite, le décalage de l'entrée de la saison est utilisé (saison 1 : décalage 0).
   * Undefined si l'identifiant est invalide, la série inconnue ou la saison sans décalage connu.
   */
  async toAbsolute(imdbId: string, season: number, episode: number): Promise<number | undefined> {
    const id = normalizeImdbId(imdbId);
    if (id === undefined || !isNonNegativeInteger(season) || !isPositiveInteger(episode)) return undefined;
    const entries = (await this.table()).get(id);
    if (entries === undefined) return undefined;

    const explicit = entries.filter(hasEpisodes);
    if (explicit.length > 0) {
      for (const entry of explicit) {
        for (const mapping of entry.episodes ?? []) {
          if (mapping.season === season && mapping.episode === episode) return mapping.absolute;
        }
      }
      return undefined;
    }

    for (const entry of entries) {
      if (entry.season !== season) continue;
      const offset = seasonOffset(entry);
      if (offset === undefined) continue;
      if (entry.episodeCount !== undefined && episode > entry.episodeCount) continue;
      return offset + episode;
    }
    return undefined;
  }

  /**
   * Saison et épisode d'un numéro absolu. Même logique que toAbsolute, dans l'autre sens : pour le décalage,
   * on prend la saison la plus proche qui commence avant ce numéro et qui le contient (si son nombre
   * d'épisodes est connu).
   */
  async toSeasonEpisode(imdbId: string, absolute: number): Promise<SeasonEpisode | undefined> {
    const id = normalizeImdbId(imdbId);
    if (id === undefined || !isPositiveInteger(absolute)) return undefined;
    const entries = (await this.table()).get(id);
    if (entries === undefined) return undefined;

    const explicit = entries.filter(hasEpisodes);
    if (explicit.length > 0) {
      for (const entry of explicit) {
        for (const mapping of entry.episodes ?? []) {
          if (mapping.absolute === absolute) return { season: mapping.season, episode: mapping.episode };
        }
      }
      return undefined;
    }

    const segments = entries
      .flatMap((entry) => {
        const offset = seasonOffset(entry);
        if (entry.season === undefined || offset === undefined || offset >= absolute) return [];
        return [{ entry, season: entry.season, offset }];
      })
      .sort((a, b) => b.offset - a.offset);
    for (const segment of segments) {
      const episode = absolute - segment.offset;
      if (segment.entry.episodeCount !== undefined && episode > segment.entry.episodeCount) continue;
      return { season: segment.season, episode };
    }
    return undefined;
  }

  /** Table en mémoire, rechargée après ttlMs. Les échecs ne lèvent pas : on garde la table précédente. */
  private async table(): Promise<Index> {
    const now = this.now();
    if (this.index !== undefined && now - this.loadedAt < this.ttlMs) return this.index;
    if (this.failedAt !== undefined && now - this.failedAt < this.retryAfterMs) return this.index ?? EMPTY_INDEX;
    if (this.loading === undefined) {
      this.loading = this.refresh().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async refresh(): Promise<Index> {
    try {
      this.index = indexByImdb(await this.loadMap());
      this.loadedAt = this.now();
      this.failedAt = undefined;
    } catch {
      this.failedAt = this.now();
    }
    return this.index ?? EMPTY_INDEX;
  }
}
