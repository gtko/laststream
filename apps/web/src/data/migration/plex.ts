/* Historique Plex : titres vus sur le serveur Plex de l'utilisateur, avec leurs dates, importés après autorisation.
 * Tout se fait depuis l'appareil : autorisation par code PIN plex.tv (la page Plex s'ouvre, l'utilisateur accepte), choix du
 * serveur, lecture de `/status/sessions/history/all` puis des identifiants (IMDb, TMDB, TVDB) de chaque titre. Le jeton Plex
 * reste en mémoire le temps de l'import : il n'est ni enregistré ni envoyé à Laststream. */

import { appFetch } from '../crossFetch';
import {
  hasRef, imdbOf, isObject, num, posInt, str,
  type EpisodeRef, type MigrationBundle, type MigrationItem, type TitleRef,
} from './types';

export const PLEX_TV = 'https://plex.tv/api/v2/';
const PRODUCT = 'Laststream';
const CLIENT_KEY = 'laststream.plexClientId';
const PAGE = 200;
const MAX_HISTORY = 20_000;
const TIMEOUT_MS = 20_000;

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (u, i) => appFetch(u, i);

export class PlexError extends Error {
  constructor(public kind: 'denied' | 'network' | 'expired' | 'other', message: string) {
    super(message);
    this.name = 'PlexError';
  }
}

/** Identifiant d'appareil exigé par Plex (stable, sans lien avec le compte). */
export function plexClientId(): string {
  try {
    const v = globalThis.localStorage?.getItem(CLIENT_KEY);
    if (v) return v;
  } catch { /* stockage indisponible : identifiant de session */ }
  const id = 'laststream-' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
  try { globalThis.localStorage?.setItem(CLIENT_KEY, id); } catch { /* idem */ }
  return id;
}

const headers = (token?: string): Record<string, string> => ({
  Accept: 'application/json', 'X-Plex-Product': PRODUCT, 'X-Plex-Client-Identifier': plexClientId(), ...(token ? { 'X-Plex-Token': token } : {}),
});

async function getJson(url: string, init: RequestInit, fetchFn: FetchFn): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch {
    throw new PlexError('network', 'Plex est injoignable depuis cet appareil.');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new PlexError('denied', 'Plex a refusé l’accès : autorise Laststream puis réessaie.');
  if (res.status === 404) throw new PlexError('expired', 'Demande d’autorisation expirée.');
  if (!res.ok) throw new PlexError('other', 'Réponse inattendue de Plex (HTTP ' + res.status + ').');
  try { return await res.json(); } catch { throw new PlexError('other', 'Réponse illisible de Plex.'); }
}

// ---------- Autorisation ----------

export interface PlexPin { id: number; code: string; authUrl: string }

/** Demande un code PIN et l'adresse de la page Plex où l'utilisateur autorise Laststream. */
export async function createPlexPin(fetchFn: FetchFn = defaultFetch): Promise<PlexPin> {
  const data = await getJson(PLEX_TV + 'pins?strong=true', { method: 'POST', headers: headers() }, fetchFn);
  const id = isObject(data) ? posInt(data.id) : undefined;
  const code = isObject(data) ? str(data.code) : '';
  if (!id || !code) throw new PlexError('other', 'Plex n’a pas fourni de code.');
  const q = new URLSearchParams({ clientID: plexClientId(), code, 'context[device][product]': PRODUCT });
  return { id, code, authUrl: 'https://app.plex.tv/auth#?' + q.toString() };
}

/** Jeton une fois l'autorisation donnée, sinon null (à redemander plus tard). */
export async function checkPlexPin(pinId: number, fetchFn: FetchFn = defaultFetch): Promise<string | null> {
  const data = await getJson(PLEX_TV + 'pins/' + pinId, { headers: headers() }, fetchFn);
  const token = isObject(data) ? str(data.authToken) : '';
  return token || null;
}

// ---------- Serveurs ----------

export interface PlexServer { name: string; token: string; uris: string[]; owned: boolean }

/** Serveurs Plex du compte, avec leurs adresses dans l'ordre d'essai : https direct, puis distant, puis relais. */
export async function listPlexServers(token: string, fetchFn: FetchFn = defaultFetch): Promise<PlexServer[]> {
  const data = await getJson(PLEX_TV + 'resources?includeHttps=1&includeRelay=1', { headers: headers(token) }, fetchFn);
  const list = Array.isArray(data) ? data : [];
  return list.filter((r) => isObject(r) && str(r.provides).split(',').includes('server')).map((r) => {
    const o = r as Record<string, unknown>;
    const conns = (Array.isArray(o.connections) ? o.connections : []).filter(isObject);
    const rank = (c: Record<string, unknown>): number => (c.relay === true ? 3 : 0) + (str(c.protocol) === 'https' ? 0 : 2) + (c.local === true ? 0 : 1);
    const uris = conns.sort((a, b) => rank(a) - rank(b)).map((c) => str(c.uri)).filter(Boolean);
    return { name: str(o.name) || 'Serveur Plex', token: str(o.accessToken) || token, uris, owned: o.owned === true };
  }).filter((s) => s.uris.length > 0);
}

/** Première adresse du serveur qui répond. */
async function reachable(server: PlexServer, fetchFn: FetchFn): Promise<string> {
  for (const uri of server.uris) {
    try {
      await getJson(uri.replace(/\/+$/, '') + '/identity', { headers: headers(server.token) }, fetchFn);
      return uri.replace(/\/+$/, '');
    } catch { /* adresse suivante */ }
  }
  throw new PlexError('network', 'Le serveur « ' + server.name + ' » ne répond à aucune de ses adresses depuis cet appareil.');
}

// ---------- Historique ----------

interface HistoryRow { type: 'movie' | 'episode'; key: string; title: string; season?: number; episode?: number; viewedAt: number; account?: number }

function metadataOf(data: unknown): Record<string, unknown>[] {
  const mc = isObject(data) && isObject(data.MediaContainer) ? data.MediaContainer : {};
  return Array.isArray(mc.Metadata) ? mc.Metadata.filter(isObject) : [];
}

/** Identifiants d'une fiche Plex (`Guid: [{ id: 'imdb://tt…' }, …]`, ou ancien `guid` d'agent). */
export function refOfPlexMeta(m: Record<string, unknown>): TitleRef {
  const ids = (Array.isArray(m.Guid) ? m.Guid : []).map((g) => (isObject(g) ? str(g.id) : '')).concat(str(m.guid));
  const ref: TitleRef = {};
  for (const g of ids) {
    const imdb = /imdb:\/\/(tt\d+)/.exec(g); // `imdb://tt…` ou ancien agent `com.plexapp.agents.imdb://tt…`
    if (imdb && !ref.imdb) ref.imdb = imdbOf(imdb[1]);
    const tmdb = /^(?:tmdb|com\.plexapp\.agents\.themoviedb):\/\/(\d+)/.exec(g);
    if (tmdb && !ref.tmdb) ref.tmdb = posInt(tmdb[1]);
    const tvdb = /^(?:tvdb|com\.plexapp\.agents\.thetvdb):\/\/(\d+)/.exec(g);
    if (tvdb && !ref.tvdb) ref.tvdb = posInt(tvdb[1]);
  }
  return ref;
}

async function accountFilter(base: string, server: PlexServer, userToken: string, fetchFn: FetchFn): Promise<number | null> {
  if (server.owned) return 1; // propriétaire du serveur : compte n° 1
  try {
    const user = await getJson(PLEX_TV + 'user', { headers: headers(userToken) }, fetchFn);
    const names = isObject(user) ? [str(user.username), str(user.title)].filter(Boolean).map((s) => s.toLowerCase()) : [];
    const data = await getJson(base + '/accounts', { headers: headers(server.token) }, fetchFn);
    const mc = isObject(data) && isObject(data.MediaContainer) ? data.MediaContainer : {};
    const acc = (Array.isArray(mc.Account) ? mc.Account : []).filter(isObject).find((a) => names.includes(str(a.name).toLowerCase()));
    return acc ? num(acc.id) ?? null : null;
  } catch {
    return null;
  }
}

export interface PlexReadOptions {
  fetchFn?: FetchFn;
  onProgress?: (done: number, total: number) => void;
}

/** Lit l'historique de l'utilisateur sur un serveur et le convertit en éléments « vus » (avec la date du dernier visionnage). */
export async function readPlexHistory(server: PlexServer, userToken: string, opts: PlexReadOptions = {}): Promise<MigrationBundle> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const base = await reachable(server, fetchFn);
  const account = await accountFilter(base, server, userToken, fetchFn);
  const rows: HistoryRow[] = [];
  for (let start = 0; start < MAX_HISTORY; start += PAGE) {
    const q = new URLSearchParams({ sort: 'viewedAt:desc', 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(PAGE) });
    if (account !== null) q.set('accountID', String(account));
    const page = metadataOf(await getJson(base + '/status/sessions/history/all?' + q.toString(), { headers: headers(server.token) }, fetchFn));
    for (const m of page) {
      const type = str(m.type);
      if (type === 'movie' && str(m.ratingKey)) rows.push({ type, key: str(m.ratingKey), title: str(m.title), viewedAt: (num(m.viewedAt) ?? 0) * 1000 });
      else if (type === 'episode' && str(m.grandparentRatingKey)) {
        rows.push({ type, key: str(m.grandparentRatingKey), title: str(m.grandparentTitle), season: num(m.parentIndex), episode: num(m.index), viewedAt: (num(m.viewedAt) ?? 0) * 1000 });
      }
    }
    if (page.length < PAGE) break;
  }
  // Un titre par fiche Plex (film ou série) : identifiants lus une fois, 4 à la fois.
  const keys = [...new Set(rows.map((r) => r.type + ':' + r.key))];
  const refs = new Map<string, TitleRef>();
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const k = keys[next++];
      const ratingKey = k.slice(k.indexOf(':') + 1);
      try {
        const meta = metadataOf(await getJson(base + '/library/metadata/' + encodeURIComponent(ratingKey) + '?includeGuids=1', { headers: headers(server.token) }, fetchFn))[0];
        refs.set(k, meta ? refOfPlexMeta(meta) : {});
      } catch {
        refs.set(k, {}); // fiche supprimée du serveur : signalée au rapport
      }
      opts.onProgress?.(++done, keys.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const items: MigrationItem[] = [];
  for (const k of keys) {
    const group = rows.filter((r) => r.type + ':' + r.key === k);
    const ref = refs.get(k) ?? {};
    const isMovie = group[0].type === 'movie';
    const at = Math.max(...group.map((r) => r.viewedAt));
    const title = group[0].title || 'Sans titre';
    const uid = 'plex:' + server.name + ':' + k;
    if (!hasRef(ref)) {
      items.push({ uid, action: 'watched', type: isMovie ? 'movie' : 'tv', ref, title, at, skipReason: 'Fiche Plex sans identifiant IMDb, TMDB ni TVDB (agent local ou fiche supprimée)' });
      continue;
    }
    if (isMovie) { items.push({ uid, action: 'watched', type: 'movie', ref, title, at }); continue; }
    const eps = new Map<string, EpisodeRef>();
    for (const r of group) if (r.season !== undefined && r.season > 0 && r.episode !== undefined && r.episode > 0) eps.set(r.season + ':' + r.episode, { season: r.season, episode: r.episode });
    if (eps.size) items.push({ uid: uid + ':' + eps.size, action: 'watched', type: 'tv', ref, title, at, episodes: [...eps.values()] });
  }
  const notes = account === null && !server.owned ? ['Compte introuvable sur ce serveur partagé : l’historique de tous ses utilisateurs est lu.'] : [];
  if (!rows.length) notes.push('Aucun visionnage dans l’historique de ce serveur.');
  return { source: 'plex', items, addons: [], notes };
}
