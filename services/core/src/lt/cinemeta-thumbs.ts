import { isRecord } from '../sources/http.js';
import { getJson, LtError, type LtContext, TTL } from './context.js';

/** Vignette d'un épisode d'après Cinemeta (catalogue Stremio) : numérotation et date de diffusion propres à Cinemeta. */
export interface CinemetaThumb {
  season: number;
  episode: number;
  /** Date de diffusion AAAA-MM-JJ, null si absente. */
  released: string | null;
  /** URL https complète. */
  thumbnail: string;
}

const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series';
const IMDB_ID = /^tt\d{5,12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}/;

const intOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

/** Adresse d'image https, ou null (les adresses http sont remontées en https, tout autre schéma est écarté). */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Vignettes des épisodes d'une série (identifiant IMDb) : `meta.videos[].thumbnail`. Un appel par série, cache partagé
 * de 12 h. Série inconnue de Cinemeta (404) : liste vide. Autre panne : LtError (l'appelant décide du repli).
 */
export async function cinemetaThumbs(ctx: LtContext, imdbId: string): Promise<CinemetaThumb[]> {
  if (!IMDB_ID.test(imdbId)) return [];
  return ctx.state.cache.get(`cinemeta:thumbs:${imdbId}`, TTL.episodes, async () => {
    let json: unknown;
    try {
      json = await getJson(ctx, `${CINEMETA}/${imdbId}.json`);
    } catch (err) {
      if (err instanceof LtError && err.code === 'upstream_404') return [];
      throw err;
    }
    const videos = isRecord(json) && isRecord(json.meta) && Array.isArray(json.meta.videos) ? json.meta.videos : [];
    return videos.flatMap((raw): CinemetaThumb[] => {
      if (!isRecord(raw)) return [];
      const season = intOf(raw.season);
      const episode = intOf(raw.episode) ?? intOf(raw.number);
      const thumbnail = httpsUrl(raw.thumbnail);
      if (season === null || episode === null || episode < 1 || thumbnail === null) return [];
      const released = typeof raw.released === 'string' && DAY.test(raw.released) ? raw.released.slice(0, 10) : null;
      return [{ season, episode, released, thumbnail }];
    });
  });
}

/**
 * Vignette Cinemeta de l'épisode (saison, numéro, date). La numérotation Cinemeta n'est retenue que si les dates de
 * diffusion concordent (ou si l'une des deux manque : rien à contredire) ; sinon l'épisode est retrouvé par sa date,
 * à condition qu'elle soit unique chez Cinemeta. `used` empêche d'attribuer deux fois la même vignette.
 */
export function pickThumb(
  thumbs: readonly CinemetaThumb[],
  season: number,
  episode: number,
  airDate: string | null,
  used: Set<CinemetaThumb>,
): string | null {
  const free = thumbs.filter((t) => !used.has(t));
  const byNumber = free.find((t) => t.season === season && t.episode === episode);
  if (byNumber !== undefined && (airDate === null || byNumber.released === null || byNumber.released === airDate)) {
    used.add(byNumber);
    return byNumber.thumbnail;
  }
  if (airDate === null) return null;
  const sameDay = free.filter((t) => t.released === airDate);
  if (sameDay.length !== 1) return null;
  const [hit] = sameDay as [CinemetaThumb];
  used.add(hit);
  return hit.thumbnail;
}
