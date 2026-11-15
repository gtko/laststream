import { isRecord } from '../sources/http.js';
import { cachedInBlobs } from './blob-cache.js';
import { type LtContext, ltDownload, LtError } from './context.js';

/**
 * Numérotation MyAnimeList des anime. La liste Fribb (anime-lists) relie chaque fiche MAL à une série TMDB / TVDB, à
 * une saison et à un décalage d'épisodes. Les épisodes d'un anime sont regroupés par fiche MAL : chaque fiche devient
 * une saison affichée, numérotée comme sur MAL (à partir de 1). Les spéciaux (saison 0) ne sont pas renumérotés.
 */

/** Liste Fribb complète (version mini) : identifiants MAL, Kitsu, TMDB, saison et décalage. */
export const FRIBB_LIST_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const LIST_MAX_BYTES = 32 * 1024 * 1024;
const LIST_TIMEOUT_MS = 20_000;
const INDEX_TTL_MS = 24 * 3600e3;
const INDEX_KEY = 'fribb:mal-index:v1';

/** Système de numérotation de la structure à renuméroter : saisons TVDB ou saisons TMDB. */
export type Numbering = 'tvdb' | 'tmdb';

/**
 * Fiche MAL d'une série. `season` : saison couverte (absente : numérotation continue sur toute la série) ; `offset` :
 * nombre d'épisodes de cette saison (ou de la série, sans saison) qui précèdent le premier épisode de la fiche.
 */
export interface MalEntry {
  mal: number;
  kitsu?: number;
  tvdb?: { season?: number; offset: number };
  tmdb?: { season?: number; offset: number };
}

/** Fiches MAL par identifiant TMDB de série. */
export type MalIndex = Record<string, MalEntry[]>;

const intOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Saison et décalage d'une entrée Fribb pour un système de numérotation ; absent si la saison vaut 0 (spéciaux). */
function placement(raw: Record<string, unknown>, numbering: Numbering): { season?: number; offset: number } | undefined {
  const seasons = isRecord(raw.season) ? raw.season : {};
  const offsets = isRecord(raw.episode_offset) ? raw.episode_offset : {};
  const season = intOf(seasons[numbering]);
  if (season === 0) return undefined;
  const offset = intOf(offsets[numbering]) ?? 0;
  return season === undefined ? { offset } : { season, offset };
}

/**
 * Réduit la liste Fribb aux fiches MAL de séries TMDB (films et entrées sans identifiant MAL écartés). Lève LtError si
 * la racine n'est pas un tableau.
 */
export function parseMalIndex(json: unknown): MalIndex {
  if (!Array.isArray(json)) throw new LtError(502, 'upstream_bad_json');
  const index: MalIndex = {};
  for (const raw of json as unknown[]) {
    if (!isRecord(raw) || raw.type === 'MOVIE') continue;
    const mal = intOf(raw.mal_id);
    const tmdbTv = isRecord(raw.themoviedb_id) ? intOf(raw.themoviedb_id.tv) : undefined;
    if (mal === undefined || mal === 0 || tmdbTv === undefined) continue;
    const tvdb = placement(raw, 'tvdb');
    const tmdb = placement(raw, 'tmdb');
    if (tvdb === undefined && tmdb === undefined) continue;
    const entry: MalEntry = { mal };
    const kitsu = intOf(raw.kitsu_id);
    if (kitsu !== undefined && kitsu > 0) entry.kitsu = kitsu;
    if (tvdb !== undefined) entry.tvdb = tvdb;
    if (tmdb !== undefined) entry.tmdb = tmdb;
    (index[String(tmdbTv)] ??= []).push(entry);
  }
  return index;
}

/** Index des fiches MAL (liste Fribb réduite), gardé 24 h dans le store de blobs et la mémoire. */
async function malIndex(ctx: LtContext): Promise<MalIndex> {
  return cachedInBlobs(
    ctx,
    INDEX_KEY,
    INDEX_TTL_MS,
    async () => {
      const bytes = await ltDownload(ctx, FRIBB_LIST_URL, {}, LIST_TIMEOUT_MS, { maxBytes: LIST_MAX_BYTES });
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new LtError(502, 'upstream_bad_json');
      }
      return parseMalIndex(json);
    },
    'jikan',
  );
}

/** Fiches MAL d'une série TMDB ; liste vide si la série n'est pas un anime connu. Lève LtError si la liste est indisponible. */
export async function malEntriesOf(ctx: LtContext, tmdbId: string): Promise<MalEntry[]> {
  return (await malIndex(ctx))[tmdbId] ?? [];
}

/** Épisode à renuméroter : saison et numéro dans le système `numbering` (null : non placé), rang absolu hors spéciaux. */
export interface Placed {
  season: number | null;
  episode: number | null;
  absolute: number | null;
}

/** Fiche MAL et numéro d'épisode MAL attribués à un épisode. */
export interface MalNumber {
  mal: number;
  kitsu?: number;
  episode: number;
}

interface Slot {
  entry: MalEntry;
  season?: number;
  offset: number;
}

/**
 * Attribue à chaque épisode sa fiche MAL et son numéro MAL. Une fiche liée à une saison couvre les épisodes de cette
 * saison après son décalage, jusqu'à la fiche suivante de la même saison ; une fiche sans saison couvre de même la suite
 * continue de la série (rang absolu). La fiche liée à la saison est prioritaire. Épisode non couvert : undefined.
 */
export function malNumbers(entries: readonly MalEntry[], numbering: Numbering, episodes: readonly Placed[]): (MalNumber | undefined)[] {
  const slots: Slot[] = entries.flatMap((entry): Slot[] => {
    const place = entry[numbering] ?? entry[numbering === 'tvdb' ? 'tmdb' : 'tvdb'];
    return place === undefined ? [] : [{ entry, offset: place.offset, ...(place.season === undefined ? {} : { season: place.season }) }];
  });
  /** Fiche de plus grand décalage inférieur au numéro, parmi celles de la saison (ou sans saison). */
  const pick = (season: number | undefined, n: number): Slot | undefined =>
    slots
      .filter((slot) => slot.season === season && slot.offset < n)
      .sort((a, b) => b.offset - a.offset || a.entry.mal - b.entry.mal)[0];
  return episodes.map((e) => {
    const bySeason = e.season !== null && e.season > 0 && e.episode !== null ? pick(e.season, e.episode) : undefined;
    const slot = bySeason ?? (e.absolute !== null ? pick(undefined, e.absolute) : undefined);
    if (slot === undefined) return undefined;
    const n = slot === bySeason ? (e.episode as number) : (e.absolute as number);
    const number: MalNumber = { mal: slot.entry.mal, episode: n - slot.offset };
    if (slot.entry.kitsu !== undefined) number.kitsu = slot.entry.kitsu;
    return number;
  });
}
