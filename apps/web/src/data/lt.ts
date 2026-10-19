import { ltUrl, requireBase, type QueryValue } from './config';
import { getRegion, getVideoLang } from './prefs';
import { cachedRequest, isFicheUrl, requestFiche, requestJson } from './transport';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Les réponses TMDB / MDBList / TVDB gardent la forme du prototype : volontairement non typées ici. */
export type Json = any;

export type Params = Record<string, QueryValue>;

/** GET {base}/{config}/lt/<path> avec cache client (5 min mini) et au plus 6 requêtes en vol. */
export function api<T = Json>(path: string, params?: Params): Promise<T> {
  const url = ltUrl(path, params);
  return cachedRequest<T>(url, () => requestJson<T>(url));
}

/** Route TMDB (liste blanche côté serveur). `region` suit le réglage de l'utilisateur (France par défaut). */
export function tmdb<T = Json>(path: string, params: Params = {}): Promise<T> {
  return api<T>('tmdb/' + path, { region: getRegion().code, language: getVideoLang().tag, ...params });
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
