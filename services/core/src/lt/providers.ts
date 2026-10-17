import { isRecord } from '../sources/http.js';
import { getJson, keyDigest, LtError, type LtContext, recordAt, TTL } from './context.js';

const TMDB_BASE = 'https://api.themoviedb.org/3/';
/** Chemins TMDB autorisés (liste blanche du prototype). */
const TMDB_PATH = /^(trending|movie|tv|discover|search|collection|watch|person)(\/[a-z0-9_-]+)*$/;
/** Paramètres TMDB acceptés depuis l'extérieur. Tout autre paramètre est ignoré. */
const TMDB_PUBLIC_PARAMS: ReadonlySet<string> = new Set([
  'language',
  'region',
  'page',
  'query',
  'sort_by',
  'with_genres',
  'with_watch_providers',
  'watch_region',
  'with_watch_monetization_types',
  'append_to_response',
  'include_image_language',
  'primary_release_date.gte',
  'primary_release_date.lte',
  'first_air_date.gte',
  'first_air_date.lte',
  'air_date.gte',
  'air_date.lte',
  'vote_count.gte',
  'with_original_language',
  'include_adult',
]);

/** Ne garde que les paramètres TMDB en liste blanche ; include_adult n'est accepté qu'à `false`. */
export function tmdbPublicParams(query: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter(([key, value]) => TMDB_PUBLIC_PARAMS.has(key) && (key !== 'include_adult' || value === 'false')),
  );
}

/**
 * Durée de vie du cache TMDB selon le chemin : fournisseurs de streaming 12 h, tendances et populaires 3 h, le reste
 * (détails, listes, à venir) 6 h.
 */
export function tmdbTtl(sub: string): number {
  const segments = sub.split('/');
  if (segments.includes('watch')) return TTL.tmdbWatch;
  if (segments.includes('trending') || segments.includes('popular')) return TTL.tmdbFast;
  return TTL.tmdb;
}

/**
 * GET TMDB (API v4, jeton Bearer). Langue fr-FR et région FR par défaut. Cache partagé entre utilisateurs
 * (métadonnées publiques) : ni le jeton ni son empreinte n'entrent dans la clé.
 */
export async function tmdbGet(
  ctx: LtContext,
  token: string,
  sub: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  if (!TMDB_PATH.test(sub)) throw new LtError(404, 'not_found');
  const url = new URL(TMDB_BASE + sub);
  const query = new URLSearchParams(params);
  if (!query.has('language')) query.set('language', 'fr-FR');
  if (!query.has('region')) query.set('region', 'FR');
  query.forEach((value, key) => url.searchParams.set(key, value));
  return ctx.state.cache.get(`tmdb:${url.pathname}${url.search}`, tmdbTtl(sub), () =>
    getJson(ctx, url.toString(), { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } }),
  );
}

const MDB_TYPES: Record<string, string> = { movie: 'movie', tv: 'show', show: 'show' };

export interface MdbRatings {
  ratings: {
    imdb: number | null;
    rottentomatoes: number | null;
    rottentomatoes_audience: number | null;
    metacritic: number | null;
    letterboxd: number | null;
    tmdb: number | null;
    trakt: number | null;
  };
  score: number | null;
}

/** Notes MDBList (IMDb ou TMDB id). Seules les notes et le score sont renvoyés. */
export async function mdblistRatings(ctx: LtContext, apiKey: string, type: string, id: string): Promise<MdbRatings> {
  const mdbType = MDB_TYPES[type];
  if (mdbType === undefined) throw new LtError(404, 'not_found');
  let source: 'imdb' | 'tmdb';
  if (/^tt\d{5,12}$/.test(id)) source = 'imdb';
  else if (/^\d{1,9}$/.test(id)) source = 'tmdb';
  else throw new LtError(404, 'not_found');
  return ctx.state.cache.get(`mdb:${source}:${mdbType}:${id}`, TTL.mdb, async () => {
    const url = `https://api.mdblist.com/${source}/${mdbType}/${encodeURIComponent(id)}?apikey=${encodeURIComponent(apiKey)}`;
    const json = await getJson(ctx, url);
    const list: unknown[] = isRecord(json) && Array.isArray(json.ratings) ? json.ratings : [];
    const pick = (name: string): number | null => {
      const entry = list.find((x) => isRecord(x) && x.source === name);
      return isRecord(entry) && typeof entry.value === 'number' ? entry.value : null;
    };
    return {
      ratings: {
        imdb: pick('imdb'),
        rottentomatoes: pick('tomatoes'),
        rottentomatoes_audience: pick('popcorn') ?? pick('tomatoesaudience'),
        metacritic: pick('metacritic'),
        letterboxd: pick('letterboxd'),
        tmdb: pick('tmdb'),
        trakt: pick('trakt'),
      },
      score: isRecord(json) && typeof json.score === 'number' ? json.score : null,
    };
  });
}

export interface TvdbSeries {
  status: string;
  seasonCount: number;
  seasons: { number: number }[];
  nextAired: string;
  lastAired: string;
}

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const TVDB_SESSION_MS = 20 * 24 * 3600e3;

/** Jeton TVDB, mis en cache par clé API (empreinte). Une nouvelle connexion si `force`. */
async function tvdbToken(ctx: LtContext, apiKey: string, force: boolean): Promise<string> {
  const sessionKey = keyDigest(apiKey);
  const session = ctx.state.tvdbSessions.get(sessionKey);
  if (!force && session !== undefined && session.exp > Date.now()) return session.token;
  const json = await getJson(ctx, `${TVDB_BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ apikey: apiKey }),
  });
  const token = recordAt(json, 'data').token;
  if (typeof token !== 'string' || token === '') throw new LtError(502, 'tvdb_login_failed');
  ctx.state.tvdbSessions.set(sessionKey, { token, exp: Date.now() + TVDB_SESSION_MS });
  return token;
}

/** Saisons officielles (hors saison 0) et prochain épisode d'une série TVDB. */
export async function tvdbSeries(ctx: LtContext, apiKey: string, id: string): Promise<TvdbSeries> {
  if (!/^\d{1,9}$/.test(id)) throw new LtError(404, 'not_found');
  return ctx.state.cache.get(`tvdb:${id}`, TTL.tvdb, async () => {
    const fetchExtended = async (token: string): Promise<unknown> =>
      getJson(ctx, `${TVDB_BASE}/series/${id}/extended?short=true`, {
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
      });
    let json: unknown;
    try {
      json = await fetchExtended(await tvdbToken(ctx, apiKey, false));
    } catch (err) {
      if (!(err instanceof LtError) || err.code !== 'upstream_401') throw err;
      ctx.state.tvdbSessions.delete(keyDigest(apiKey)); // jeton expiré : une seule nouvelle connexion
      json = await fetchExtended(await tvdbToken(ctx, apiKey, true));
    }
    const data = recordAt(json, 'data');
    const rawSeasons: unknown[] = Array.isArray(data.seasons) ? data.seasons : [];
    const seasons = rawSeasons
      .filter(isRecord)
      .filter((s) => isRecord(s.type) && s.type.type === 'official' && typeof s.number === 'number' && s.number > 0)
      .map((s) => ({ number: Number(s.number) }));
    const status = recordAt(data, 'status').name;
    return {
      status: typeof status === 'string' ? status : '',
      seasonCount: seasons.length,
      seasons,
      nextAired: typeof data.nextAired === 'string' ? data.nextAired : '',
      lastAired: typeof data.lastAired === 'string' ? data.lastAired : '',
    };
  });
}
