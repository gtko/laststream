import { isRecord } from '../sources/http.js';
import { getJson, keyDigest, LtError, type LtContext, ltRequest, recordAt, TTL, type TvdbVersion } from './context.js';

const TMDB_BASE = 'https://api.themoviedb.org/3/';
/** Chemins TMDB autorisés (liste blanche du prototype). */
const TMDB_PATH = /^(trending|movie|tv|discover|search|collection|watch|person|find|list)(\/[a-z0-9_-]+)*$/;
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
  'certification_country',
  'certification',
  'certification.lte',
  'certification.gte',
  'with_companies',
  'with_networks',
  'without_genres',
  'with_keywords',
  'without_keywords',
  'include_video_language',
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
  'external_source',
  'with_runtime.gte',
  'with_runtime.lte',
  'vote_average.gte',
  'vote_average.lte',
  'vote_count.lte',
  'with_origin_country',
  'with_type',
  'with_status',
  'without_companies',
  'with_people',
  'with_cast',
  'with_crew',
  'first_air_date_year',
  'primary_release_year',
  'year',
  'timezone',
  'screened_theatrically',
  'with_release_type',
  'release_date.gte',
  'release_date.lte',
]);
/** Sources d'identifiant externe acceptées par `find` (external_source). */
const TMDB_EXTERNAL_SOURCES: ReadonlySet<string> = new Set(['imdb_id', 'tvdb_id']);

/**
 * Ne garde que les paramètres TMDB en liste blanche ; include_adult n'est accepté qu'à `false`, external_source
 * seulement avec imdb_id ou tvdb_id.
 */
export function tmdbPublicParams(query: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) =>
        TMDB_PUBLIC_PARAMS.has(key) &&
        (key !== 'include_adult' || value === 'false') &&
        (key !== 'external_source' || TMDB_EXTERNAL_SOURCES.has(value)),
    ),
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
  return ctx.state.cache.get(`tmdb:${url.pathname}${url.search}`, tmdbTtl(sub), async () =>
    slimTmdb(await getJson(ctx, url.toString(), { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } }, undefined, { maxBytes: TMDB_MAX_BYTES })),
  );
}

/** Saisons longues (anime : 40+ épisodes) : la réponse TMDB dépasse plusieurs Mo, surtout à cause des génériques par épisode. */
export const TMDB_MAX_BYTES = 16 * 1024 * 1024;

/** Retire l'équipe et les invités de chaque épisode d'une saison : l'app ne les affiche pas et ils pèsent l'essentiel du JSON. */
export function slimTmdb(data: unknown): unknown {
  const episodes = (data as { episodes?: unknown } | null)?.episodes;
  if (Array.isArray(episodes)) {
    for (const ep of episodes) {
      if (ep && typeof ep === 'object') {
        delete (ep as Record<string, unknown>).crew;
        delete (ep as Record<string, unknown>).guest_stars;
      }
    }
  }
  return data;
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

/** Quota MDBList épuisé (429). `retryAfterMs` : délai annoncé par les en-têtes, ou undefined. Même forme qu'une 502 upstream_429. */
export class MdbRateLimited extends LtError {
  readonly retryAfterMs: number | undefined;

  constructor(retryAfterMs: number | undefined) {
    super(502, 'upstream_429', 'mdblist');
    this.name = 'MdbRateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Délai avant remise à zéro d'après les en-têtes MDBList (Retry-After, X-RateLimit-Reset : secondes, epoch ou date). */
export function mdblistRetryDelayMs(headers: Headers, now: number = Date.now()): number | undefined {
  for (const name of ['retry-after', 'x-ratelimit-reset', 'ratelimit-reset', 'x-ratelimit-reset-after']) {
    const raw = headers.get(name)?.trim();
    if (!raw) continue;
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      return n > 1e9 ? Math.max(0, n * 1000 - now) : n * 1000;
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return undefined;
}

/** Cible MDBList d'une demande : source (imdb|tmdb), type MDBList et identifiant. Entrée invalide : 404 not_found. */
export function mdblistTarget(type: string, id: string): { source: 'imdb' | 'tmdb'; mdbType: string; id: string } {
  const mdbType = MDB_TYPES[type];
  if (mdbType === undefined) throw new LtError(404, 'not_found');
  if (/^tt\d{5,12}$/.test(id)) return { source: 'imdb', mdbType, id };
  if (/^\d{1,9}$/.test(id)) return { source: 'tmdb', mdbType, id };
  throw new LtError(404, 'not_found');
}

/** Notes MDBList sans cache, avec la date de sortie (null si inconnue). 429 : MdbRateLimited. */
export async function mdblistFetch(
  ctx: LtContext,
  apiKey: string,
  type: string,
  id: string,
): Promise<{ ratings: MdbRatings; released: string | null }> {
  const target = mdblistTarget(type, id);
  const url = `https://api.mdblist.com/${target.source}/${target.mdbType}/${encodeURIComponent(target.id)}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await ltRequest(ctx, url);
  if (res.status === 429) throw new MdbRateLimited(mdblistRetryDelayMs(res.headers));
  if (!res.ok) throw new LtError(502, `upstream_${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(res.bytes).toString('utf8')) as unknown;
  } catch {
    throw new LtError(502, 'upstream_bad_json');
  }
  // Certaines réponses de quota arrivent avec un message d'erreur plutôt qu'un statut 429.
  if (isRecord(json) && typeof json.error === 'string' && /limit/i.test(json.error)) {
    throw new MdbRateLimited(mdblistRetryDelayMs(res.headers));
  }
  const list: unknown[] = isRecord(json) && Array.isArray(json.ratings) ? json.ratings : [];
  const pick = (name: string): number | null => {
    const entry = list.find((x) => isRecord(x) && x.source === name);
    return isRecord(entry) && typeof entry.value === 'number' ? entry.value : null;
  };
  const day = isRecord(json) && typeof json.released === 'string' ? json.released.slice(0, 10) : '';
  return {
    released: AIR_DATE.test(day) ? day : null,
    ratings: {
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
    },
  };
}

/** Notes MDBList sans cache persistant (vérification d'une clé). Seules les notes et le score sont renvoyés. */
export async function mdblistRatings(ctx: LtContext, apiKey: string, type: string, id: string): Promise<MdbRatings> {
  mdblistTarget(type, id);
  return ctx.state.cache.get(`mdb:${type}:${id}`, TTL.mdb, async () => (await mdblistFetch(ctx, apiKey, type, id)).ratings);
}

export interface TvdbSeries {
  status: string;
  seasonCount: number;
  seasons: { number: number }[];
  nextAired: string;
  lastAired: string;
}

const TVDB_V4_BASE = 'https://api4.thetvdb.com/v4';
/** API v3 : seule à accepter les clés legacy (32 caractères hexadécimaux). Jeton valable 24 h. */
const TVDB_V3_BASE = 'https://api.thetvdb.com';
const TVDB_V4_SESSION_MS = 20 * 24 * 3600e3;
const TVDB_V3_SESSION_MS = 24 * 3600e3;
/** Durée de mémorisation de la version qui a accepté une clé (pas de nouvel essai v4 pendant ce temps). */
const TVDB_VERSION_MS = 24 * 3600e3;
/** Plafond de pages d'épisodes v3 (100 épisodes par page) : au-delà, la série est refusée plutôt que lue en partie. */
const TVDB_V3_MAX_PAGES = 100;
/** Date de diffusion au format AAAA-MM-JJ ; les dates vides ou absentes sont ignorées. */
const AIR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Identifiant de session TVDB : empreinte de la clé et du PIN, jamais la clé en clair. */
function tvdbCredentialId(apiKey: string, pin: string | undefined): string {
  return keyDigest(JSON.stringify([apiKey, pin ?? null]));
}

/**
 * Connexion à une version de l'API TVDB. v4 : jeton dans `data.token`, PIN transmis s'il est configuré. v3 (clés
 * legacy) : jeton à la racine de la réponse, sans PIN.
 */
async function tvdbLogin(ctx: LtContext, version: TvdbVersion, apiKey: string, pin: string | undefined): Promise<string> {
  const payload = version === 'v4' && pin !== undefined ? { apikey: apiKey, pin } : { apikey: apiKey };
  const json = await getJson(ctx, `${version === 'v4' ? TVDB_V4_BASE : TVDB_V3_BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const token = version === 'v4' ? recordAt(json, 'data').token : isRecord(json) ? json.token : undefined;
  if (typeof token !== 'string' || token === '') throw new LtError(502, 'tvdb_login_failed');
  return token;
}

/** Jeton TVDB pour une version et une clé, mis en cache. Une nouvelle connexion si `force`. */
async function tvdbToken(
  ctx: LtContext,
  version: TvdbVersion,
  apiKey: string,
  pin: string | undefined,
  force: boolean,
): Promise<string> {
  const sessionKey = `${version}:${tvdbCredentialId(apiKey, pin)}`;
  const session = ctx.state.tvdbSessions.get(sessionKey);
  if (!force && session !== undefined && session.exp > Date.now()) return session.token;
  const token = await tvdbLogin(ctx, version, apiKey, pin);
  const ttl = version === 'v4' ? TVDB_V4_SESSION_MS : TVDB_V3_SESSION_MS;
  ctx.state.tvdbSessions.set(sessionKey, { token, exp: Date.now() + ttl });
  return token;
}

/**
 * Version d'API qui accepte la clé. Essai v4 d'abord ; un 401 de v4 signale une clé legacy : bascule en v3. Les
 * autres erreurs (panne, 5xx) ne basculent pas. La version retenue est mémorisée par clé.
 */
export async function tvdbApiVersion(ctx: LtContext, apiKey: string, pin: string | undefined): Promise<TvdbVersion> {
  const credentialId = tvdbCredentialId(apiKey, pin);
  const known = ctx.state.tvdbVersions.get(credentialId);
  if (known !== undefined && known.exp > Date.now()) return known.version;
  let version: TvdbVersion = 'v4';
  try {
    await tvdbToken(ctx, 'v4', apiKey, pin, false);
  } catch (err) {
    if (!(err instanceof LtError) || err.code !== 'upstream_401') throw err;
    await tvdbToken(ctx, 'v3', apiKey, pin, false);
    version = 'v3';
  }
  ctx.state.tvdbVersions.set(credentialId, { version, exp: Date.now() + TVDB_VERSION_MS });
  return version;
}

/**
 * Exécute `run` avec un jeton de la version qui accepte la clé. Un 401 pendant l'appel signale un jeton expiré :
 * une seule nouvelle connexion, puis un nouvel essai.
 */
async function withTvdbToken<T>(
  ctx: LtContext,
  apiKey: string,
  pin: string | undefined,
  run: (version: TvdbVersion, token: string) => Promise<T>,
): Promise<T> {
  const version = await tvdbApiVersion(ctx, apiKey, pin);
  const token = await tvdbToken(ctx, version, apiKey, pin, false);
  try {
    return await run(version, token);
  } catch (err) {
    if (!(err instanceof LtError) || err.code !== 'upstream_401') throw err;
    return run(version, await tvdbToken(ctx, version, apiKey, pin, true));
  }
}

/** Forme de sortie commune aux deux versions (identique à celle de l'API v4 historique). */
function toTvdbSeries(status: unknown, seasonNumbers: number[], nextAired: unknown, lastAired: unknown): TvdbSeries {
  const seasons = seasonNumbers.map((number) => ({ number }));
  return {
    status: typeof status === 'string' ? status : '',
    seasonCount: seasons.length,
    seasons,
    nextAired: typeof nextAired === 'string' ? nextAired : '',
    lastAired: typeof lastAired === 'string' ? lastAired : '',
  };
}

/** API v4 : saisons officielles hors saison 0, statut et dates de l'endpoint « extended ». */
async function tvdbV4Series(ctx: LtContext, token: string, id: string): Promise<TvdbSeries> {
  const json = await getJson(ctx, `${TVDB_V4_BASE}/series/${id}/extended?short=true`, {
    headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
  });
  const data = recordAt(json, 'data');
  const rawSeasons: unknown[] = Array.isArray(data.seasons) ? data.seasons : [];
  const seasonNumbers = rawSeasons
    .filter(isRecord)
    .filter((s) => isRecord(s.type) && s.type.type === 'official' && typeof s.number === 'number' && s.number > 0)
    .map((s) => Number(s.number));
  return toTvdbSeries(recordAt(data, 'status').name, seasonNumbers, data.nextAired, data.lastAired);
}

/**
 * Lit toutes les pages d'une liste TVDB à partir de `first`, jusqu'à `links.next` nul (numéro de page suivant).
 * `rows` extrait le tableau d'une page. Plafond : TVDB_V3_MAX_PAGES pages.
 */
async function tvdbPages(
  ctx: LtContext,
  first: number,
  url: (page: number) => string,
  init: RequestInit,
  rows: (json: unknown) => unknown,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let page: number | null = first;
  for (let read = 0; page !== null; read += 1) {
    if (read >= TVDB_V3_MAX_PAGES) throw new LtError(502, 'tvdb_too_many_pages');
    const json = await getJson(ctx, url(page), init);
    const list = rows(json);
    if (Array.isArray(list)) out.push(...list);
    const next: unknown = recordAt(json, 'links').next;
    page = typeof next === 'number' && next > page ? next : null;
  }
  return out;
}

/** Tous les épisodes de la série (API v3, 100 par page), jusqu'à `links.next` nul. */
async function tvdbV3Episodes(ctx: LtContext, token: string, id: string): Promise<unknown[]> {
  const init = { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } };
  return tvdbPages(ctx, 1, (page) => `${TVDB_V3_BASE}/series/${id}/episodes?page=${page}`, init, (json) =>
    isRecord(json) ? json.data : undefined,
  );
}

/**
 * API v3 (clés legacy) : statut (série), saisons diffusées hors saison 0 (résumé), et prochain et dernier épisode
 * diffusés (épisodes, hors saison 0). Prochain = plus ancienne date future ; dernier = plus récente date passée.
 */
async function tvdbV3Series(ctx: LtContext, token: string, id: string): Promise<TvdbSeries> {
  const init = { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } };
  const [series, summary, episodes] = await Promise.all([
    getJson(ctx, `${TVDB_V3_BASE}/series/${id}`, init),
    getJson(ctx, `${TVDB_V3_BASE}/series/${id}/episodes/summary`, init),
    tvdbV3Episodes(ctx, token, id),
  ]);
  const airedSeasons = recordAt(summary, 'data').airedSeasons;
  const seasonNumbers = (Array.isArray(airedSeasons) ? [...new Set<number>(airedSeasons.map(Number))] : [])
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  let nextAired = '';
  let lastAired = '';
  for (const episode of episodes) {
    if (!isRecord(episode) || typeof episode.airedSeason !== 'number' || episode.airedSeason <= 0) continue;
    const date = episode.firstAired;
    if (typeof date !== 'string' || !AIR_DATE.test(date)) continue;
    if (date > today) {
      if (nextAired === '' || date < nextAired) nextAired = date;
    } else if (date > lastAired) {
      lastAired = date;
    }
  }
  return toTvdbSeries(recordAt(series, 'data').status, seasonNumbers, nextAired, lastAired);
}

/**
 * Saisons diffusées (hors saison 0), statut et dates d'une série TVDB. API v4 avec la clé (et le PIN s'il est
 * configuré) ; repli sur l'API v3 pour une clé legacy. Forme de sortie identique dans les deux cas.
 */
export async function tvdbSeries(ctx: LtContext, apiKey: string, id: string, pin?: string): Promise<TvdbSeries> {
  if (!/^\d{1,9}$/.test(id)) throw new LtError(404, 'not_found');
  return ctx.state.cache.get(`tvdb:${id}`, TTL.tvdb, () =>
    withTvdbToken(ctx, apiKey, pin, (version, token) =>
      version === 'v4' ? tvdbV4Series(ctx, token, id) : tvdbV3Series(ctx, token, id),
    ),
  );
}

/** Langues de texte demandées à TVDB : français, puis anglais en repli. */
export type TvdbLang = 'fr' | 'en';

/** Épisode de l'ordre de diffusion TVDB. Saison 0 incluse (spéciaux). Champs absents : null. */
export interface TvdbAiredEpisode {
  season: number;
  number: number;
  name: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  /** Vignette de l'épisode (URL https complète), null si absente. */
  image: string | null;
}

/** Codes de langue ISO 639-2 attendus par l'API v4 (chemin « /episodes/default/{lang} »). */
const TVDB_V4_LANG: Record<TvdbLang, string> = { fr: 'fra', en: 'eng' };

/** Entier positif ou nul, nombre ou chaîne numérique ; sinon null. */
function intOf(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

/** Texte non vide, sinon null. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Date AAAA-MM-JJ, sinon null. */
function airDateOf(value: unknown): string | null {
  return typeof value === 'string' && AIR_DATE.test(value) ? value : null;
}

/** Hôte des images TVDB : v4 renvoie une URL complète, v3 un chemin relatif (« episodes/1/2.jpg »). */
const TVDB_ARTWORK = 'https://artworks.thetvdb.com';

function tvdbImage(value: unknown): string | null {
  const text = nonEmpty(value)?.trim();
  if (text === undefined) return null;
  if (/^https:\/\//i.test(text)) return text;
  if (/^http:\/\//i.test(text)) return 'https://' + text.slice('http://'.length);
  if (/^[\w./-]+$/.test(text) && !text.includes('..')) return `${TVDB_ARTWORK}/banners/${text.replace(/^\/+(banners\/)?/, '')}`;
  return null;
}

function airedFromV4(raw: unknown): TvdbAiredEpisode | undefined {
  if (!isRecord(raw)) return undefined;
  const season = intOf(raw.seasonNumber);
  const number = intOf(raw.number);
  if (season === null || number === null || number < 1) return undefined;
  return {
    season,
    number,
    name: nonEmpty(raw.name),
    overview: nonEmpty(raw.overview),
    airDate: airDateOf(raw.aired),
    runtime: intOf(raw.runtime) || null,
    image: tvdbImage(raw.image),
  };
}

function airedFromV3(raw: unknown): TvdbAiredEpisode | undefined {
  if (!isRecord(raw)) return undefined;
  const season = intOf(raw.airedSeason);
  const number = intOf(raw.airedEpisodeNumber);
  if (season === null || number === null || number < 1) return undefined;
  return {
    season,
    number,
    name: nonEmpty(raw.episodeName),
    overview: nonEmpty(raw.overview),
    airDate: airDateOf(raw.firstAired),
    runtime: null,
    image: tvdbImage(raw.filename),
  };
}

/** Ordre de saison TVDB lu en v4 : « default » (ordre de diffusion TVDB), « official » en repli quand il est vide. */
type TvdbOrder = 'default' | 'official';

/** Épisodes d'un ordre TVDB en v4 (langue du chemin) ou v3 (en-tête Accept-Language, ordre unique). */
async function tvdbAired(ctx: LtContext, token: string, id: string, lang: TvdbLang, version: TvdbVersion, order: TvdbOrder): Promise<TvdbAiredEpisode[]> {
  if (version === 'v4') {
    const init = { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } };
    const rows = await tvdbPages(
      ctx,
      0,
      (page) => `${TVDB_V4_BASE}/series/${id}/episodes/${order}/${TVDB_V4_LANG[lang]}?page=${page}`,
      init,
      (json) => recordAt(json, 'data').episodes,
    );
    return rows.map(airedFromV4).filter((e): e is TvdbAiredEpisode => e !== undefined);
  }
  const init = { headers: { Authorization: 'Bearer ' + token, accept: 'application/json', 'accept-language': lang } };
  const rows = await tvdbPages(ctx, 1, (page) => `${TVDB_V3_BASE}/series/${id}/episodes?page=${page}`, init, (json) =>
    isRecord(json) ? json.data : undefined,
  );
  return rows.map(airedFromV3).filter((e): e is TvdbAiredEpisode => e !== undefined);
}

/**
 * Épisodes de la série dans l'ordre TVDB `default` (ordre de diffusion), texte dans la langue demandée, avec repli sur
 * l'ordre `official` quand `default` ne renvoie aucun épisode (comme Stremio AIOMetadata). Cache partagé (métadonnées
 * publiques, comme tvdbSeries). API v4 avec la clé (et le PIN), repli sur v3 pour une clé legacy.
 */
export async function tvdbAiredEpisodes(
  ctx: LtContext,
  apiKey: string,
  id: string,
  lang: TvdbLang,
  pin?: string,
): Promise<TvdbAiredEpisode[]> {
  if (!/^\d{1,9}$/.test(id)) throw new LtError(404, 'not_found');
  return ctx.state.cache.get(`tvdb:aired:v2:${id}:${lang}`, TTL.tvdb, () =>
    withTvdbToken(ctx, apiKey, pin, async (version, token) => {
      const rows = await tvdbAired(ctx, token, id, lang, version, 'default');
      if (rows.length > 0 || version !== 'v4') return rows;
      return tvdbAired(ctx, token, id, lang, version, 'official');
    }),
  );
}
