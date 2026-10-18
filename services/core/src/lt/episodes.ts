import { isRecord } from '../sources/http.js';
import { LtError, type LtContext, recordAt, TTL } from './context.js';
import { tmdbGet, tvdbAiredEpisodes, type TvdbAiredEpisode, type TvdbLang } from './providers.js';

/**
 * Structure canonique des saisons et épisodes d'une série. Source : TVDB (ordre de diffusion), groupe d'épisodes TMDB,
 * ou saisons TMDB telles quelles. Les spéciaux (saison 0) sont séparés et placés en fin de liste.
 */
export type EpisodeSource = 'tvdb' | 'tmdb-group' | 'tmdb';

export interface SeriesSeason {
  number: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  poster: string | null;
}

export interface SeriesEpisode {
  season: number;
  episode: number;
  /** Rang dans les saisons hors spéciaux (saison puis épisode), à partir de 1 ; null pour les spéciaux. */
  absolute: number | null;
  name: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  still: string | null;
  /** Coordonnées TMDB de l'épisode, null s'il n'a pas d'équivalent côté TMDB. */
  tmdbSeason: number | null;
  tmdbEpisode: number | null;
}

export interface SeriesEpisodes {
  source: EpisodeSource;
  seasons: SeriesSeason[];
  episodes: SeriesEpisode[];
}

/** Jetons nécessaires : TMDB obligatoire, TVDB facultatif (clé et PIN). Jamais journalisés. */
export interface SeriesServices {
  tmdbToken: string;
  tvdbApiKey: string | undefined;
  tvdbPin: string | undefined;
}

/** Résultat d'une cible de recherche : coordonnées canoniques et numéro absolu (null pour un spécial). */
export interface SearchEpisode {
  season: number;
  episode: number;
  absolute: number | null;
}

const DEFAULT_LANGUAGE = 'fr-FR';
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const TMDB_ID = /^[1-9]\d{0,8}$/;
/** Identifiant de groupe d'épisodes TMDB (chaîne hexadécimale). */
const TMDB_GROUP_ID = /^[a-f0-9]{1,64}$/;
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';
const AIR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Types de groupes TMDB retenus : 1 (date de diffusion), 6 et 7 (TV). */
const GROUP_TYPES: ReadonlySet<number> = new Set([1, 6, 7]);
const SEASON_GROUP_NAME = /saison|season/i;
const SPECIALS_NAME = 'Spéciaux';

/** Nom de saison par défaut, sans nom fourni par la source. */
const seasonDefaultName = (number: number): string => (number === 0 ? SPECIALS_NAME : `Saison ${number}`);

const intOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);
const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const dateOf = (value: unknown): string | null => (typeof value === 'string' && AIR_DATE.test(value) ? value : null);
const imageOf = (value: unknown): string | null => (typeof value === 'string' && value.startsWith('/') ? TMDB_IMAGE + value : null);
const runtimeOf = (value: unknown): number | null => {
  const n = intOf(value);
  return n !== null && n > 0 ? n : null;
};
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const present = <T>(value: T | undefined): value is T => value !== undefined;

/**
 * Valide l'identifiant TMDB et la langue (fr-FR par défaut). Entrée invalide : 404 not_found, comme les autres routes.
 */
export function parseSeriesRequest(tmdbId: string, language: string | undefined): { tmdbId: string; language: string } {
  const lang = language === undefined || language === '' ? DEFAULT_LANGUAGE : language;
  if (!TMDB_ID.test(tmdbId) || !LANGUAGE.test(lang)) throw new LtError(404, 'not_found');
  return { tmdbId, language: lang };
}

/** Saison telle que TMDB la décrit dans la fiche de la série. */
interface SeasonInfo {
  number: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  poster: string | null;
}

interface TmdbGroupInfo {
  id: string;
  name: string;
  type: number;
  groupCount: number;
}

/** Fiche TMDB de la série (avec external_ids et episode_groups en append_to_response). */
interface SeriesDetails {
  seasons: SeasonInfo[];
  numberOfSeasons: number;
  tvdbId: number | null;
  groups: TmdbGroupInfo[];
}

function seriesDetails(json: unknown): SeriesDetails {
  const details = recordAt(json);
  const seasons = arrayOf(details.seasons)
    .filter(isRecord)
    .flatMap((raw): SeasonInfo[] => {
      const number = intOf(raw.season_number);
      if (number === null || number < 0) return [];
      return [
        {
          number,
          name: textOf(raw.name) ?? seasonDefaultName(number),
          episodeCount: intOf(raw.episode_count) ?? 0,
          airDate: dateOf(raw.air_date),
          poster: imageOf(raw.poster_path),
        },
      ];
    });
  const tvdbId = intOf(recordAt(details, 'external_ids').tvdb_id);
  const groups = arrayOf(recordAt(details, 'episode_groups').results)
    .filter(isRecord)
    .map((raw) => ({
      id: textOf(raw.id) ?? '',
      name: textOf(raw.name) ?? '',
      type: intOf(raw.type) ?? -1,
      groupCount: intOf(raw.group_count) ?? 0,
    }));
  return {
    seasons,
    numberOfSeasons: intOf(details.number_of_seasons) ?? seasons.filter((s) => s.number > 0).length,
    tvdbId: tvdbId !== null && tvdbId > 0 ? tvdbId : null,
    groups,
  };
}

/** Épisode TMDB (saison ou groupe). Les coordonnées TMDB sont celles de la source. */
interface TmdbEpisode {
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  still: string | null;
}

function tmdbEpisodeOf(raw: Record<string, unknown>, fallbackSeason: number): TmdbEpisode | undefined {
  const episode = intOf(raw.episode_number);
  if (episode === null || episode < 1) return undefined;
  return {
    season: intOf(raw.season_number) ?? fallbackSeason,
    episode,
    name: textOf(raw.name),
    overview: textOf(raw.overview),
    airDate: dateOf(raw.air_date),
    runtime: runtimeOf(raw.runtime),
    still: imageOf(raw.still_path),
  };
}

/** Épisodes d'une liste de saisons TMDB, en un seul tableau (chaque épisode porte sa saison). */
async function loadSeasons(
  ctx: LtContext,
  token: string,
  tmdbId: string,
  language: string,
  numbers: number[],
): Promise<TmdbEpisode[]> {
  const lists = await Promise.all(
    numbers.map(async (number) => {
      const json = await tmdbGet(ctx, token, `tv/${tmdbId}/season/${number}`, { language });
      return arrayOf(recordAt(json).episodes)
        .filter(isRecord)
        .map((raw) => tmdbEpisodeOf(raw, number))
        .filter(present);
    }),
  );
  return lists.flat();
}

/** Groupes d'un épisode group TMDB, triés par ordre, sans les groupes vides. Nom absent : « Saison N ». */
async function loadGroups(
  ctx: LtContext,
  token: string,
  groupId: string,
  language: string,
): Promise<{ name: string; episodes: TmdbEpisode[] }[]> {
  if (!TMDB_GROUP_ID.test(groupId)) return [];
  const json = await tmdbGet(ctx, token, `tv/episode_group/${groupId}`, { language });
  return arrayOf(recordAt(json).groups)
    .filter(isRecord)
    .sort((a, b) => (intOf(a.order) ?? 0) - (intOf(b.order) ?? 0))
    .map((group, index) => ({
      name: textOf(group.name) ?? seasonDefaultName(index + 1),
      episodes: arrayOf(group.episodes)
        .filter(isRecord)
        .map((raw) => tmdbEpisodeOf(raw, 0))
        .filter(present),
    }))
    .filter((group) => group.episodes.length > 0);
}

/**
 * Groupe d'épisodes qui découpe la série en plus de saisons que TMDB ne l'annonce (ex. anime en une saison TMDB).
 * Le plus grand nombre de groupes l'emporte.
 */
function pickGroup(details: SeriesDetails): TmdbGroupInfo | undefined {
  return details.groups
    .filter(
      (g) =>
        g.id !== '' && (GROUP_TYPES.has(g.type) || SEASON_GROUP_NAME.test(g.name)) && g.groupCount > details.numberOfSeasons,
    )
    .sort((a, b) => b.groupCount - a.groupCount)[0];
}

/** Brouillon d'épisode canonique, avant numérotation absolue et regroupement en saisons. */
interface Draft {
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  still: string | null;
  tmdbSeason: number | null;
  tmdbEpisode: number | null;
}

/** Métadonnées d'une saison (nom, affiche, date). */
interface SeasonMeta {
  name: string;
  poster: string | null;
  airDate: string | null;
}

const fromTmdb = (e: TmdbEpisode): Draft => ({
  season: e.season,
  episode: e.episode,
  name: e.name,
  overview: e.overview,
  airDate: e.airDate,
  runtime: e.runtime,
  still: e.still,
  tmdbSeason: e.season,
  tmdbEpisode: e.episode,
});

/** Date la plus ancienne d'un ensemble d'épisodes, ou null. */
function earliestDate(episodes: SeriesEpisode[]): string | null {
  const dates = episodes.map((e) => e.airDate).filter((d): d is string => d !== null);
  return dates.length === 0 ? null : dates.reduce((a, b) => (b < a ? b : a));
}

/**
 * Numérote les épisodes (absolu hors spéciaux), range les saisons (spéciaux en fin) et renseigne leurs métadonnées.
 * `meta` reçoit le numéro de saison et son nombre d'épisodes ; un doublon (saison, épisode) est écarté.
 */
function assemble(source: EpisodeSource, drafts: Draft[], meta: (season: number, count: number) => SeasonMeta | undefined): SeriesEpisodes {
  const rank = (season: number): number => (season === 0 ? Number.MAX_SAFE_INTEGER : season);
  const ordered = [...drafts].sort((a, b) => rank(a.season) - rank(b.season) || a.episode - b.episode);
  const seen = new Set<string>();
  const unique = ordered.filter((d) => {
    const key = `${d.season}:${d.episode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let absolute = 0;
  const episodes: SeriesEpisode[] = unique.map((d) => {
    absolute = d.season === 0 ? absolute : absolute + 1;
    return {
      season: d.season,
      episode: d.episode,
      absolute: d.season === 0 ? null : absolute,
      name: d.name,
      overview: d.overview,
      airDate: d.airDate,
      runtime: d.runtime,
      still: d.still,
      tmdbSeason: d.tmdbSeason,
      tmdbEpisode: d.tmdbEpisode,
    };
  });
  const numbers = [...new Set(episodes.map((e) => e.season))];
  const seasons: SeriesSeason[] = numbers.map((number) => {
    const own = episodes.filter((e) => e.season === number);
    const info = meta(number, own.length);
    return {
      number,
      name: info?.name ?? seasonDefaultName(number),
      episodeCount: own.length,
      airDate: info?.airDate ?? earliestDate(own),
      poster: info?.poster ?? null,
    };
  });
  return { source, seasons, episodes };
}

/** Clé de tri par date (absente : en fin), puis saison et épisode. */
interface Sortable {
  season: number;
  episode: number;
  airDate: string | null;
}

const byAirOrder = (a: Sortable, b: Sortable): number =>
  (a.airDate ?? '9999-12-31').localeCompare(b.airDate ?? '9999-12-31') || a.season - b.season || a.episode - b.episode;

/**
 * Relie chaque épisode à l'épisode TMDB de même date de diffusion ; à défaut, à l'épisode TMDB de même rang absolu
 * (ordre des dates). Un épisode TMDB n'est relié qu'une fois.
 */
function linkByAbsolute<T extends Sortable>(own: T[], tmdb: TmdbEpisode[]): [T, TmdbEpisode][] {
  const ownSorted = [...own].sort(byAirOrder);
  const tmdbSorted = [...tmdb].sort(byAirOrder);
  const used = new Set<number>();
  const pairs: [T, TmdbEpisode][] = [];
  ownSorted.forEach((item, rank) => {
    let index = item.airDate === null ? -1 : tmdbSorted.findIndex((t, i) => !used.has(i) && t.airDate === item.airDate);
    if (index < 0 && rank < tmdbSorted.length && !used.has(rank)) index = rank;
    if (index < 0) return;
    used.add(index);
    pairs.push([item, tmdbSorted[index] as TmdbEpisode]);
  });
  return pairs;
}

/** Épisodes TVDB (ordre de diffusion) avec texte français, anglais en repli. */
interface TvdbDraft {
  season: number;
  episode: number;
  frName: string | null;
  frOverview: string | null;
  enName: string | null;
  enOverview: string | null;
  airDate: string | null;
  runtime: number | null;
}

interface AiredSets {
  primary: TvdbAiredEpisode[];
  english: TvdbAiredEpisode[];
}

/**
 * Ordre de diffusion TVDB dans la langue principale. L'anglais n'est demandé que si la langue principale ne couvre
 * pas tous les noms ou résumés ; un échec de l'anglais est ignoré.
 */
async function loadAired(ctx: LtContext, svc: SeriesServices, apiKey: string, tvdbId: number, primary: TvdbLang): Promise<AiredSets> {
  const id = String(tvdbId);
  const first = await tvdbAiredEpisodes(ctx, apiKey, id, primary, svc.tvdbPin);
  const incomplete = primary !== 'en' && first.some((e) => e.name === null || e.overview === null);
  const english = incomplete
    ? await tvdbAiredEpisodes(ctx, apiKey, id, 'en', svc.tvdbPin).catch((): TvdbAiredEpisode[] => [])
    : [];
  return { primary: first, english };
}

/**
 * Structure TVDB. Texte : TVDB français, puis TMDB, puis TVDB anglais. Images, durées et coordonnées TMDB viennent de
 * l'épisode TMDB relié par date ou par rang absolu, quand TVDB ne les fournit pas.
 */
function tvdbStructure(details: SeriesDetails, tmdb: TmdbEpisode[], aired: AiredSets): SeriesEpisodes {
  const english = new Map(aired.english.map((e) => [`${e.season}:${e.number}`, e]));
  const drafts: TvdbDraft[] = aired.primary.map((e) => {
    const en = english.get(`${e.season}:${e.number}`);
    return {
      season: e.season,
      episode: e.number,
      frName: e.name,
      frOverview: e.overview,
      enName: en?.name ?? null,
      enOverview: en?.overview ?? null,
      airDate: e.airDate,
      runtime: e.runtime,
    };
  });
  const regular = drafts.filter((d) => d.season > 0);
  const specials = drafts.filter((d) => d.season === 0);
  const links = new Map<TvdbDraft, TmdbEpisode>([
    ...linkByAbsolute(regular, tmdb.filter((t) => t.season > 0)),
    ...linkByAbsolute(specials, tmdb.filter((t) => t.season === 0)),
  ]);
  const finals: Draft[] = drafts.map((d) => {
    const t = links.get(d);
    return {
      season: d.season,
      episode: d.episode,
      name: d.frName ?? t?.name ?? d.enName,
      overview: d.frOverview ?? t?.overview ?? d.enOverview,
      airDate: d.airDate ?? t?.airDate ?? null,
      runtime: d.runtime ?? t?.runtime ?? null,
      still: t?.still ?? null,
      tmdbSeason: t?.season ?? null,
      tmdbEpisode: t?.episode ?? null,
    };
  });
  // Nom et affiche TMDB seulement si la saison TMDB de même numéro a le même nombre d'épisodes.
  return assemble('tvdb', finals, (number, count) => {
    const info = details.seasons.find((s) => s.number === number && s.episodeCount === count);
    return info === undefined ? undefined : { name: info.name, poster: info.poster, airDate: info.airDate };
  });
}

/** Structure TMDB telle quelle : saisons et spéciaux de la fiche. */
function plainStructure(details: SeriesDetails, tmdb: TmdbEpisode[]): SeriesEpisodes {
  return assemble('tmdb', tmdb.map(fromTmdb), (number) => {
    const info = details.seasons.find((s) => s.number === number);
    return info === undefined ? undefined : { name: info.name, poster: info.poster, airDate: info.airDate };
  });
}

/** Structure à partir d'un groupe d'épisodes TMDB ; undefined si le groupe est vide (repli sur la structure TMDB). */
async function groupStructure(
  ctx: LtContext,
  token: string,
  details: SeriesDetails,
  group: TmdbGroupInfo,
  language: string,
  tmdbId: string,
): Promise<SeriesEpisodes | undefined> {
  const groups = await loadGroups(ctx, token, group.id, language);
  if (groups.length === 0) return undefined;
  const drafts: Draft[] = groups.flatMap((g, index) =>
    g.episodes.map((e, i) => ({ ...fromTmdb(e), season: index + 1, episode: i + 1 })),
  );
  const specials = details.seasons.some((s) => s.number === 0) ? await loadSeasons(ctx, token, tmdbId, language, [0]) : [];
  drafts.push(...specials.map(fromTmdb));
  return assemble('tmdb-group', drafts, (number) => {
    if (number === 0) {
      const info = details.seasons.find((s) => s.number === 0);
      return info === undefined ? undefined : { name: info.name, poster: info.poster, airDate: info.airDate };
    }
    const named = groups[number - 1];
    return named === undefined ? undefined : { name: named.name, poster: null, airDate: null };
  });
}

interface Loaded {
  body: SeriesEpisodes;
  /** Vrai si TVDB était demandé mais indisponible : résultat gardé peu de temps. */
  degraded: boolean;
}

/**
 * Ordre de choix : TVDB (clé configurée et identifiant TVDB connu), puis groupe TMDB, puis saisons TMDB. Une panne TVDB
 * (erreur amont) bascule sur TMDB, signalée par un journal sans clé.
 */
async function load(ctx: LtContext, svc: SeriesServices, tmdbId: string, language: string): Promise<Loaded> {
  const token = svc.tmdbToken;
  const details = seriesDetails(
    await tmdbGet(ctx, token, `tv/${tmdbId}`, { language, append_to_response: 'external_ids,episode_groups' }),
  );
  const allSeasons = details.seasons.map((s) => s.number);
  let degraded = false;
  if (svc.tvdbApiKey !== undefined && details.tvdbId !== null) {
    const primary: TvdbLang = language.split('-')[0] === 'fr' ? 'fr' : 'en';
    let aired: AiredSets | undefined;
    try {
      aired = await loadAired(ctx, svc, svc.tvdbApiKey, details.tvdbId, primary);
    } catch (err) {
      if (!(err instanceof LtError)) throw err;
      console.warn(`[lt][episodes] TVDB indisponible, repli sur TMDB (statut amont : ${err.code})`);
      degraded = true;
    }
    if (aired !== undefined) {
      const tmdb = await loadSeasons(ctx, token, tmdbId, language, allSeasons);
      return { body: tvdbStructure(details, tmdb, aired), degraded: false };
    }
  }
  const group = pickGroup(details);
  if (group !== undefined) {
    const body = await groupStructure(ctx, token, details, group, language, tmdbId);
    if (body !== undefined) return { body, degraded };
  }
  const tmdb = await loadSeasons(ctx, token, tmdbId, language, allSeasons);
  return { body: plainStructure(details, tmdb), degraded };
}

/**
 * Structure des saisons et épisodes d'une série (identifiant TMDB). Cache partagé 12 h ; un repli après panne TVDB
 * n'est gardé que 15 min. La clé de cache ne contient aucun secret : identifiant, langue, présence d'une clé TVDB.
 */
export async function seriesEpisodes(
  ctx: LtContext,
  svc: SeriesServices,
  tmdbId: string,
  language: string | undefined,
): Promise<SeriesEpisodes> {
  const req = parseSeriesRequest(tmdbId, language);
  const key = `episodes:${req.tmdbId}:${req.language}:${svc.tvdbApiKey === undefined ? 'tmdb' : 'tvdb'}`;
  const loaded = await ctx.state.cache.get<Loaded>(
    key,
    (value) => (value.degraded ? TTL.tvPartial : TTL.episodes),
    () => load(ctx, svc, req.tmdbId, req.language),
  );
  return loaded.body;
}

/**
 * Coordonnées de recherche d'un épisode canonique (saison, épisode) : numéro absolu pour les séries à numérotation
 * continue (anime). Null si l'épisode n'existe pas dans la structure.
 */
export async function canonicalToSearch(
  ctx: LtContext,
  svc: SeriesServices,
  tmdbId: string,
  season: number,
  episode: number,
  language?: string,
): Promise<SearchEpisode | null> {
  const structure = await seriesEpisodes(ctx, svc, tmdbId, language);
  const hit = structure.episodes.find((e) => e.season === season && e.episode === episode);
  return hit === undefined ? null : { season: hit.season, episode: hit.episode, absolute: hit.absolute };
}
