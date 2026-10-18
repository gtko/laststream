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

export const clearCanonCache = (): void => cache.clear();
