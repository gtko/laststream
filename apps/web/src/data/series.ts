import { api } from './lt';

/*
 * Structure canonique d'une série (GET {base}/{config}/lt/series/:tmdbId/episodes?language=…) : saisons et épisodes
 * dans l'ordre diffusé de TheTVDB ou d'un groupe d'épisodes TMDB, avec numéros absolus et visuels TMDB rattachés.
 * Toute l'interface (sélecteur de saison, compteur de nouveaux épisodes, prochain épisode, clés « vu » et progression,
 * Reprendre, identifiants de flux tt:saison:épisode) suit cette numérotation. Sur une 404, on retombe sur les saisons TMDB.
 */

export interface CanonEpisode {
  season: number;
  episode: number;
  absolute?: number;
  name: string;
  overview: string;
  /** AAAA-MM-JJ, vide si inconnue. */
  airDate: string;
  runtime?: number;
  /** Chemin TMDB (/abc.jpg) ou URL complète. */
  still: string;
  /**
   * Identifiant de flux `<imdb>:<saison>:<épisode>` dans la numérotation des sources (IMDb), absent si inconnu. Pour un
   * anime numéroté d'après MyAnimeList, il diffère de `season:episode` (affichage, « vu », reprise).
   */
  streamId?: string;
  /** Anime : fiche MyAnimeList de l'épisode et son numéro dans cette fiche. */
  mal?: number;
  malEpisode?: number;
  /** Anime : fiche Kitsu équivalente (même numéro d'épisode que MAL). */
  kitsu?: number;
}

export interface CanonSeason {
  number: number;
  name: string;
  airDate: string;
  episodes: CanonEpisode[];
}

export interface Canon {
  source: string;
  seasons: CanonSeason[];
}

type Raw = Record<string, any>;
const pick = (o: Raw, ...keys: string[]): any => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const day = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 10) : '');
/** `{ streamId }` quand le serveur en fournit un (texte non vide), sinon rien. */
const streamIdOf = (v: unknown): { streamId?: string } => (typeof v === 'string' && v !== '' ? { streamId: v } : {});

/** Fiches MAL et Kitsu d'un épisode d'anime (entiers positifs), sinon rien. */
function animeIdsOf(e: Raw): Pick<CanonEpisode, 'mal' | 'malEpisode' | 'kitsu'> {
  const id = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
  const mal = id(e.mal);
  const malEpisode = id(e.malEpisode);
  if (mal === undefined || malEpisode === undefined) return {};
  const kitsu = id(e.kitsu);
  return { mal, malEpisode, ...(kitsu === undefined ? {} : { kitsu }) };
}

/** Identifiants d'anime d'un épisode pour les sources : `mal:<id>:<épisode>`, puis `kitsu:<id>:<épisode>`. */
export function altIdsOf(e: Pick<CanonEpisode, 'mal' | 'malEpisode' | 'kitsu'> | null | undefined): string[] {
  if (!e || e.mal === undefined || e.malEpisode === undefined) return [];
  return [`mal:${e.mal}:${e.malEpisode}`, ...(e.kitsu === undefined ? [] : [`kitsu:${e.kitsu}:${e.malEpisode}`])];
}

/** Lit la réponse du serveur (noms de champs tolérés : snake_case ou camelCase). Null si elle est inexploitable. */
export function normalizeCanon(raw: unknown): Canon | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const list: Raw[] | undefined = Array.isArray(r.seasons) ? r.seasons : undefined;
  if (!list) return null;
  const seasons: CanonSeason[] = [];
  for (const s of list) {
    const number = num(pick(s, 'number', 'seasonNumber', 'season_number', 'season'));
    if (number === undefined || !Array.isArray(s.episodes)) continue;
    const episodes: CanonEpisode[] = [];
    for (const e of s.episodes as Raw[]) {
      const episode = num(pick(e, 'number', 'episodeNumber', 'episode_number', 'episode'));
      if (episode === undefined) continue;
      episodes.push({
        season: number,
        episode,
        absolute: num(pick(e, 'absolute', 'absoluteNumber', 'absolute_number')),
        name: String(pick(e, 'name', 'title') ?? ''),
        overview: String(pick(e, 'overview', 'description') ?? ''),
        airDate: day(pick(e, 'airDate', 'air_date', 'aired')),
        runtime: num(pick(e, 'runtime', 'length')),
        still: String(pick(e, 'still', 'still_path', 'stillPath', 'image', 'thumbnail') ?? ''),
        ...streamIdOf(pick(e, 'streamId', 'stream_id')),
        ...animeIdsOf(e),
      });
    }
    episodes.sort((a, b) => a.episode - b.episode);
    seasons.push({ number, name: String(pick(s, 'name', 'title') ?? ''), airDate: day(pick(s, 'airDate', 'air_date', 'aired')) || episodes.find((e) => e.airDate)?.airDate || '', episodes });
  }
  if (!seasons.length) return null;
  seasons.sort((a, b) => a.number - b.number);
  return { source: String(pick(r, 'source', 'order') ?? 'canon'), seasons };
}

export interface CanonSummary {
  /** Saisons au format TMDB (saison 0 comprise) pour les calculs existants. */
  seasons: Array<{ season_number: number; episode_count: number; air_date: string; name: string }>;
  /** Dernier épisode diffusé (saison 0 exclue). */
  lastAired: { season_number: number; episode_number: number } | null;
  /** Prochain épisode à paraître (aujourd'hui compris). */
  next: CanonEpisode | null;
  nSeasons: number;
  nEpisodes: number;
}

export function canonSummary(c: Canon, today: string): CanonSummary {
  const real = c.seasons.filter((s) => s.number > 0);
  const all = real.flatMap((s) => s.episodes);
  const aired = all.filter((e) => e.airDate && e.airDate <= today);
  const last = aired[aired.length - 1];
  const next = all.find((e) => e.airDate && e.airDate >= today) ?? null;
  return {
    seasons: c.seasons.map((s) => ({ season_number: s.number, episode_count: s.episodes.length, air_date: s.airDate, name: s.name })),
    lastAired: last ? { season_number: last.season, episode_number: last.episode } : null,
    next,
    nSeasons: real.length,
    nEpisodes: all.length,
  };
}

/** Épisode au format d'une réponse de saison TMDB (utilisé par les vues existantes). */
export function tmdbShape(e: CanonEpisode): Record<string, unknown> {
  return {
    episode_number: e.episode,
    season_number: e.season,
    absolute_number: e.absolute,
    name: e.name,
    overview: e.overview,
    air_date: e.airDate || null,
    runtime: e.runtime,
    still_path: e.still || null,
  };
}

const cache = new Map<string, Promise<Canon | null>>();

/** Structure canonique d'une série ; null si le serveur n'a pas la route (404) ou ne la connaît pas. */
export function fetchCanon(tmdbId: string | number, language = 'fr-FR'): Promise<Canon | null> {
  const key = tmdbId + '|' + language;
  if (!cache.has(key)) {
    const p = api<unknown>(`series/${tmdbId}/episodes`, { language })
      .then(normalizeCanon)
      .catch((err: { status?: number; code?: string }) => {
        // 404 : route absente ou série inconnue, définitif ; autre erreur : on réessaiera.
        if (err?.status !== 404) cache.delete(key);
        return null;
      });
    cache.set(key, p);
  }
  return cache.get(key)!;
}

/**
 * Épisode canonique diffusé le jour donné (AAAA-MM-JJ), hors spéciaux : saison, épisode et identifiant de flux.
 * Null si aucun épisode ou plusieurs ce jour-là (ambigu).
 */
export function pickAiredEpisode(c: Canon, airDate: string): CanonEpisode | null {
  if (!airDate) return null;
  const hits = c.seasons.filter((s) => s.number > 0).flatMap((s) => s.episodes).filter((e) => e.airDate === airDate);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Épisode canonique diffusé le jour donné ; null si la structure est indisponible ou l'épisode ambigu. */
export async function canonAiredOn(tmdbId: string | number, airDate: string): Promise<CanonEpisode | null> {
  const c = await fetchCanon(tmdbId);
  return c ? pickAiredEpisode(c, airDate) : null;
}

export const clearCanonCache = (): void => cache.clear();

/**
 * Structure canonique à partir des saisons et des épisodes à plat de la fiche serveur (même forme que la route
 * /series/:id/episodes du serveur, sans saisons imbriquées). Null si la forme est inattendue.
 */
export function canonFromFiche(raw: unknown): Canon | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  if (!Array.isArray(r.seasons) || !Array.isArray(r.episodes)) return null;
  const seasons = r.seasons as Raw[];
  const flat = r.episodes as Raw[];
  const numbers = new Set<number>();
  for (const s of seasons) if (typeof s?.number === 'number') numbers.add(s.number);
  for (const e of flat) if (typeof e?.season === 'number') numbers.add(e.season);
  const nested = [...numbers].map((number) => ({
    ...(seasons.find((s) => s?.number === number) ?? { number }),
    episodes: flat.filter((e) => e?.season === number),
  }));
  return normalizeCanon({ source: r.source, seasons: nested });
}

/** Range une structure canonique déjà reçue (fiche serveur) dans le cache, sans écraser une entrée existante. */
export function seedCanon(tmdbId: string | number, language: string, canon: Canon): void {
  const key = tmdbId + '|' + language;
  if (!cache.has(key)) cache.set(key, Promise.resolve(canon));
}

/**
 * Saisons de la fiche : les vraies saisons dans l'ordre, puis la saison 0 (« Bonus » : téléfilm pilote, spéciaux) en
 * dernier, pour qu'un épisode spécial reste accessible même quand la série a des saisons numérotées.
 */
export function bonusLast<T extends { season_number: number; episode_count?: number }>(seasons: readonly T[]): T[] {
  const real = seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number);
  const bonus = seasons.filter((s) => s.season_number === 0 && (s.episode_count ?? 1) > 0);
  return [...real, ...bonus];
}

/** Identifiants d'un épisode pour les sources, les sous-titres et les segments de saut. */
export interface EpisodeIds {
  /** `<imdb>:<saison>:<épisode>` dans la numérotation des sources. */
  streamId: string;
  /** Saison et épisode de `streamId` (ceux de l'affichage si l'identifiant n'est pas de cette forme). */
  season: number;
  episode: number;
  /** Anime : `mal:<id>:<épisode>` et `kitsu:<id>:<épisode>`. */
  altIds: string[];
}

/**
 * Identifiants de l'épisode affiché (saison, épisode de la structure canonique) : son identifiant de flux, connu de la
 * demande ou lu dans la structure, et ses identifiants d'anime. Un anime numéroté d'après MyAnimeList garde ainsi ses
 * sources, ses sous-titres et ses segments de saut en numérotation IMDb. Structure indisponible : `<imdb>:saison:épisode`.
 */
export async function episodeIds(
  req: { id: string | number; season?: number | null; episode?: number | null; streamId?: string | null },
  imdb: string,
): Promise<EpisodeIds> {
  const season = req.season ?? 1;
  const episode = req.episode ?? 1;
  let canon: Canon | null = null;
  try {
    // api() lève tout de suite sans lastAddon configuré : l'échec, comme une structure indisponible, garde le repli.
    if (/^\d+$/.test(String(req.id))) canon = await fetchCanon(req.id);
  } catch {
    canon = null;
  }
  const hit = canon?.seasons.find((s) => s.number === season)?.episodes.find((e) => e.episode === episode);
  const streamId = req.streamId || hit?.streamId || `${imdb}:${season}:${episode}`;
  const match = /^(tt\d+):(\d+):(\d+)$/.exec(streamId);
  const own = match !== null && match[1] === imdb;
  return { streamId, season: own ? Number(match[2]) : season, episode: own ? Number(match[3]) : episode, altIds: altIdsOf(hit) };
}
