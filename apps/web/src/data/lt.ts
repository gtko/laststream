import { ltUrl, requireBase, type QueryValue } from './config';
import { getRegion, getVideoLang } from './prefs';
import { cachedRequest, isFicheUrl, requestFiche, requestJson } from './transport';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Les réponses TMDB / MDBList / TVDB gardent la forme du prototype : volontairement non typées ici. */
export type Json = any;

export type Params = Record<string, QueryValue>;

/** GET {base}/{config}/lt/<path> avec cache client (5 min mini) et au plus 6 requêtes en vol. Les fiches revalident leur ETag. */
export function api<T = Json>(path: string, params?: Params): Promise<T> {
  const url = ltUrl(path, params);
  return cachedRequest<T>(url, () => (isFicheUrl(url) ? requestFiche<T>(url) : requestJson<T>(url)));
}

/** Route TMDB (liste blanche côté serveur). `region` suit le réglage de l'utilisateur (France par défaut). */
export function tmdb<T = Json>(path: string, params: Params = {}): Promise<T> {
  return api<T>('tmdb/' + path, { region: getRegion().code, language: getVideoLang().tag, ...params });
}

/**
 * Top 10 servi par lastAddon (lt/top10.ts) : une page, déjà filtrée sur les titres disponibles dans la région.
 * `movie` / `tv` : tendances de la semaine ; `all` avec `day` : tendances du jour, films et séries mêlés.
 */
export function top10<T = Json>(scope: 'movie' | 'tv' | 'all', page = 1, period?: 'day'): Promise<T> {
  return api<T>('top10/' + scope, { page: String(page), region: getRegion().code, language: getVideoLang().tag, ...(period ? { window: period } : {}) });
}

export function postLt<T = Json>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(ltUrl(path), { method: 'POST', body });
}

export interface HistoryEntry {
  title: string;
  year?: number | null;
  type: 'movie' | 'tv';
}

export const mdblist = (type: string, id: string | number) => api('mdblist/' + type + '/' + id);
export const tvdbSeries = (id: string | number) => api('tvdb/series/' + id);

// ---- Fiche serveur d'un film ou d'une série (fusion TMDB, TVDB, notes, casting, saisons et épisodes) ----
export type ServerMetaType = 'movie' | 'series';

/** Notes MDBList : même forme que la route /mdblist (`ratings` par source, `score`). */
export interface ServerMetaRatings {
  ratings: Record<string, number | null>;
  score: number | null;
}

export interface ServerMetaSeason {
  number: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  poster: string | null;
}

export interface ServerMetaEpisode {
  season: number;
  episode: number;
  absolute: number | null;
  name: string | null;
  overview: string | null;
  airDate: string | null;
  runtime: number | null;
  still: string | null;
  tmdbSeason: number | null;
  tmdbEpisode: number | null;
  streamId?: string;
}

/** Saisons et épisodes à plat (séries seulement ; null si indisponibles). */
export interface ServerMetaEpisodes {
  source: string;
  seasons: ServerMetaSeason[];
  episodes: ServerMetaEpisode[];
}

/** Fiche serveur (GET {base}/{config}/lt/meta/:type/:tmdbId) : forme de MetaFiche côté lastAddon (src/lt/meta.ts). */
export interface ServerMeta {
  v: 1;
  type: ServerMetaType;
  tmdbId: number;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  releaseDate: string | null;
  status: string | null;
  nextAirDate: string | null;
  overview: string | null;
  genres: string[];
  runtime: number | null;
  poster: string | null;
  backdrop: string | null;
  cast: Array<{ id: number; name: string; character: string | null; profile: string | null }>;
  ratings: ServerMetaRatings | null;
  ratingsDueAt: number;
  tvdb: { status: string; seasonCount: number; nextAired: string; lastAired: string } | null;
  episodes: ServerMetaEpisodes | null;
  partial: boolean;
}

function isServerMeta(value: unknown, type: ServerMetaType, tmdbId: number): value is ServerMeta {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return r.v === 1 && r.type === type && r.tmdbId === tmdbId && typeof r.title === 'string' && Array.isArray(r.cast);
}

/**
 * Fiche serveur d'un film ou d'une série, avec le même cache que les fiches TMDB et TVDB (corps et ETag gardés ; une
 * réponse 304 réutilise le corps). Rejette sur une erreur (404 : identifiant inconnu ou service non configuré) ou sur une
 * forme inattendue : l'appelant replie alors sur les appels séparés.
 */
export async function fetchServerMeta(type: ServerMetaType, tmdbId: number | string): Promise<ServerMeta> {
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('identifiant TMDB invalide');
  // Appel direct à requestFiche : isFicheUrl ne liste que les routes amont (tmdb, mdblist, tvdb).
  const url = ltUrl(`meta/${type}/${id}`);
  const body = await cachedRequest<unknown>(url, () => requestFiche<unknown>(url));
  if (!isServerMeta(body, type, id)) throw new Error('fiche serveur : forme inattendue');
  return body;
}
export interface RecommendOptions {
  /** Nombre de titres demandés. */
  count?: number;
  /** Titres à exclure (vus, en bibliothèque, notés). */
  exclude?: Array<{ type: 'movie' | 'tv'; tmdbId: number }>;
  ratings?: Array<{ title: string; year: number | null; type: 'movie' | 'tv'; rating: number }>;
}
export const recommend = (history: HistoryEntry[], liked: HistoryEntry[], opts: RecommendOptions = {}) =>
  postLt('recommend', { history, liked, ...opts });
export const why = (type: 'movie' | 'tv', tmdbId: number | string, language = 'fr-FR') =>
  postLt<{ text: string }>('why', { type, tmdbId: Number(tmdbId), language });
export const personWhy = (tmdbId: number | string, language = 'fr-FR') =>
  postLt<{ text: string }>('person-why', { tmdbId: Number(tmdbId), language });

// ---- TV en direct ----
export interface TvChannel {
  id: string;
  name: string;
  logo: string;
  group: string;
  cat: string;
  source: string;
  fast: boolean;
  url: string;
  /** Signature du proxy HLS (paramètre `s`) renvoyée avec chaque chaîne. */
  sig: string | null;
  epgId: string;
  flaky: boolean;
  /** Catalogue étendu (Free-TV / iptv-org) : tous les champs sont facultatifs. */
  country?: string;
  countryName?: string;
  languages?: Array<{ code: string; name: string }>;
  categories?: Array<{ id: string; label: string }>;
  quality?: string;
  reliability?: 'high' | 'low';
  alternatives?: Array<{ url: string; sig: string | null; direct?: boolean }>;
  /**
   * Flux lisible sans relais depuis une page web (https et CORS). `false` : exige le relais HLS, que le serveur n'a pas
   * toujours (Workers) ; absent : inconnu. Écarté des pages web sans proxy, conservé pour mpv et libVLC.
   */
  direct?: boolean;
}

export interface TvChannelQuery {
  country?: string;
  language?: string;
  category?: string;
  source?: string;
  q?: string;
  /** 1 : écarte les chaînes dont aucun flux n'est lisible directement dans une page web. */
  direct?: 1;
  page?: number;
  limit?: number;
}

export type TvImportRequest =
  | { type: 'm3u'; url: string }
  | { type: 'xtream'; server: string; username: string; password: string };

/** Liste (tableau) ou page `{channels, total}` selon la version du serveur. */
export const tvChannels = (query: TvChannelQuery = {}) =>
  api<TvChannel[] | { channels?: TvChannel[]; items?: TvChannel[]; total?: number }>('tv/channels', { ...query });
/** Compteurs par pays, langue, catégorie et source ; null si le serveur ne les expose pas. */
export const tvFacets = (query: Pick<TvChannelQuery, 'country' | 'language'> = {}) =>
  api<any>('tv/facets', { ...query }).catch(() => null);
export const tvEpg = (ids: string[], from: number, to: number) => api<any[]>('tv/epg', { ids: ids.join(','), from, to });
export const tvImport = (cfg: TvImportRequest) => postLt<{ count: number; channels: TvChannel[] }>('tv/import', cfg);

/** URL du proxy HLS pour une chaîne, avec la signature telle que renvoyée dans l'entrée de chaîne. */
export function tvHlsUrl(channel: Pick<TvChannel, 'url' | 'sig'>): string {
  return ltUrl('tv/hls', { u: channel.url, s: channel.sig });
}

/** Segments de saut (intro, récap, générique) d'un épisode. */
export const skipSegments = (type: 'movie' | 'series', imdbId: string, season: number, episode: number) =>
  api('skip/' + type + '/' + imdbId + '/' + season + '/' + episode);

/** Réponse de /lt/health (capacités du serveur : miniatures ffmpeg, ...). */
export const ltHealth = () => api('health');

/** Vrai quand la base lastAddon est joignable (route /health de l'addon, hors configuration). */
export async function pingAddon(): Promise<boolean> {
  try {
    await requestJson(requireBase() + '/health');
    return true;
  } catch {
    return false;
  }
}
