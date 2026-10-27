/* Lecture de la bibliothèque Stremio, depuis un fichier d'export ou depuis le compte. Le compte est lu depuis l'appareil
 * (api.strem.io, comme l'app Stremio) : l'e-mail et le mot de passe ne passent ni par Laststream ni par lastAddon, ne sont
 * pas conservés, et la session ouverte pour la lecture est fermée aussitôt. Aucune écriture sur le compte Stremio :
 * seules les routes de lecture (`datastoreGet`, `addonCollectionGet`) sont appelées. */

import { appFetch } from '../crossFetch';
import {
  hasRef, isObject, num, refOfMediaId, str, timeOf, typeOf,
  type MigrationAddon, type MigrationBundle, type MigrationItem, type MigrationSource,
} from './types';

export const STREMIO_API = 'https://api.strem.io/api/';
const TIMEOUT_MS = 30_000;

/** Échec de lecture du compte : identifiants refusés, réseau, ou réponse inattendue. */
export class StremioError extends Error {
  constructor(public kind: 'credentials' | 'network' | 'other', message: string) {
    super(message);
    this.name = 'StremioError';
  }
}

// ---------- Bibliothèque ----------

const isLibraryItem = (v: unknown): v is Record<string, unknown> => isObject(v) && typeof v._id === 'string' && typeof v.type === 'string' && (isObject(v.state) || 'removed' in v);

/** Épisode désigné par un `video_id` Stremio (`tt123:1:2`). */
function episodeOf(videoId: string): { season: number; episode: number } | null {
  const p = videoId.split(':');
  if (p.length < 3) return null;
  const season = Number(p[p.length - 2]);
  const episode = Number(p[p.length - 1]);
  return Number.isInteger(season) && Number.isInteger(episode) && episode > 0 ? { season, episode } : null;
}

/** Éléments à importer pour un titre de la bibliothèque Stremio (format `LibraryItem` de stremio-core). */
export function itemsOfLibraryItem(raw: Record<string, unknown>): MigrationItem[] {
  const id = str(raw._id);
  const title = str(raw.name) || id;
  const st = isObject(raw.state) ? raw.state : {};
  const at = timeOf(st.lastWatched) || timeOf(raw._mtime) || timeOf(raw._ctime);
  const type = typeOf(raw.type);
  const ref = refOfMediaId(id);
  const base = { type: type ?? 'movie', ref, title, at } as const;
  if (!type) {
    // Chaînes TV, vidéos d'addons : rien d'équivalent dans Laststream. Seuls les titres de la bibliothèque sont signalés.
    if (raw.removed === true) return [];
    return [{ ...base, uid: 'stremio:' + id + ':library', action: 'library', skipReason: str(raw.type) === 'tv' || str(raw.type) === 'channel' ? 'Chaîne TV : pas de correspondance dans la bibliothèque' : 'Type « ' + str(raw.type) + ' » non pris en charge' }];
  }
  if (!hasRef(ref)) {
    if (raw.removed === true) return [];
    return [{ ...base, uid: 'stremio:' + id + ':library', action: 'library', skipReason: 'Titre propre à un addon (identifiant « ' + id.split(':')[0] + ' »), sans équivalent TMDB' }];
  }
  const out: MigrationItem[] = [];
  const inLibrary = raw.removed !== true && raw.temp !== true;
  const timesWatched = num(st.timesWatched) ?? 0;
  const flagged = num(st.flaggedWatched) ?? 0;
  const watchedField = str(st.watched);
  const offsetMs = num(st.timeOffset) ?? 0;
  const durationMs = num(st.duration) ?? 0;
  if (inLibrary) {
    out.push({ ...base, uid: 'stremio:' + id + ':library', action: 'library', at: timeOf(raw._ctime) || at });
    const started = timesWatched > 0 || flagged > 0 || offsetMs > 0 || (watchedField !== '' && !watchedField.startsWith('undefined:'));
    if (!started) out.push({ ...base, uid: 'stremio:' + id + ':watchlist', action: 'list', list: 'watchlist', at: timeOf(raw._ctime) || at });
  }
  if (type === 'movie' && (flagged > 0 || timesWatched > 0)) out.push({ ...base, uid: 'stremio:' + id + ':watched', action: 'watched' });
  if (type === 'tv' && watchedField && !watchedField.startsWith('undefined:')) out.push({ ...base, uid: 'stremio:' + id + ':watched', action: 'watched', stremioWatched: watchedField });
  if (offsetMs > 0 && durationMs > 0) {
    const ep = type === 'tv' ? episodeOf(str(st.video_id)) : null;
    if (type === 'movie' || ep) {
      out.push({ ...base, uid: 'stremio:' + id + ':progress', action: 'progress', positionSec: Math.floor(offsetMs / 1000), durationSec: Math.floor(durationMs / 1000), ...(ep ?? {}) });
    }
  }
  return out;
}

/** Titres aimés d'un export (`likes`, `liked` ou `loved`) : identifiants seuls ou objets `{ id | mediaId, type | mediaType, name }`. */
function likedItems(root: Record<string, unknown>): MigrationItem[] {
  const raw = ['likes', 'liked', 'loved'].map((k) => root[k]).find(Array.isArray) as unknown[] | undefined;
  if (!raw) return [];
  const out: MigrationItem[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v : isObject(v) ? str(v.id) || str(v.mediaId) || str(v._id) : '';
    const type = isObject(v) ? typeOf(v.type ?? v.mediaType) : null;
    const ref = refOfMediaId(id);
    if (!id || !hasRef(ref)) continue;
    out.push({ uid: 'stremio:' + id + ':favorites', action: 'list', list: 'favorites', type: type ?? 'movie', ref, title: isObject(v) ? str(v.name) || id : id, ...(type ? {} : { typeUnknown: true }) });
  }
  return out;
}

// ---------- Addons ----------

const OFFICIAL_HOSTS = /(^|\.)strem\.io$|(^|\.)stremio\.com$|^127\.0\.0\.1$|^localhost$/;

/** Addon d'une collection Stremio (`{ transportUrl, manifest, flags }`). */
export function addonOfDescriptor(d: unknown): MigrationAddon | null {
  if (!isObject(d)) return null;
  const url = str(d.transportUrl) || str(d.transport_url) || str(d.manifestUrl);
  if (!url) return null;
  const manifest = isObject(d.manifest) ? d.manifest : {};
  const flags = isObject(d.flags) ? d.flags : {};
  let host = '';
  try { host = new URL(url).hostname; } catch { /* adresse illisible : signalée par le journal des addons */ }
  return { manifestUrl: url, name: str(manifest.name) || str(d.name) || host || 'Addon', official: flags.official === true || flags.protected === true || OFFICIAL_HOSTS.test(host) };
}

// ---------- Fichier d'export ----------

/** Tableaux d'objets d'un export, à la racine ou un niveau plus bas (`result`, `library`, `addons.addons`…). */
function arraysOf(root: unknown): unknown[][] {
  if (Array.isArray(root)) return [root];
  if (!isObject(root)) return [];
  const out: unknown[][] = [];
  for (const v of Object.values(root)) {
    if (Array.isArray(v)) out.push(v);
    else if (isObject(v)) {
      for (const w of Object.values(v)) if (Array.isArray(w)) out.push(w);
      // Datastore exporté sous forme d'objet { id: item }.
      if (Object.values(v).some(isLibraryItem)) out.push(Object.values(v));
    }
  }
  return out;
}

/** Lit un export Stremio (bibliothèque et addons). Rien n'est envoyé : le fichier est lu en mémoire. */
export function parseStremioExport(json: unknown, source: MigrationSource = 'stremio-file'): MigrationBundle {
  const items: MigrationItem[] = [];
  const addons: MigrationAddon[] = [];
  const seen = new Set<string>();
  for (const arr of arraysOf(json)) {
    for (const v of arr) {
      if (isLibraryItem(v)) {
        if (seen.has(v._id as string)) continue;
        seen.add(v._id as string);
        items.push(...itemsOfLibraryItem(v));
      } else {
        const a = isObject(v) && (v.transportUrl || v.transport_url) ? addonOfDescriptor(v) : null;
        if (a && !addons.some((x) => x.manifestUrl === a.manifestUrl)) addons.push(a);
      }
    }
  }
  if (isObject(json)) items.push(...likedItems(json));
  const notes: string[] = [];
  if (!seen.size && !addons.length) notes.push('Aucune bibliothèque ni addon Stremio reconnu dans ce fichier.');
  return { source, items, addons, notes };
}

// ---------- Compte (depuis l'appareil) ----------

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function apiCall<T>(method: string, body: Record<string, unknown>, fetchFn: FetchFn): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(STREMIO_API + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch {
    throw new StremioError('network', 'Stremio est injoignable depuis cet appareil. Vérifie ta connexion puis réessaie.');
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  if (isObject(data) && isObject(data.error)) {
    const e = data.error;
    if (e.wrongPass === true || e.wrongEmail === true || e.code === 2 || e.code === 3) throw new StremioError('credentials', 'E-mail ou mot de passe Stremio incorrect.');
    throw new StremioError('other', 'Stremio a refusé la demande : ' + (str(e.message) || 'erreur inconnue') + '.');
  }
  if (!res.ok || !isObject(data) || !('result' in data)) throw new StremioError('other', 'Réponse inattendue de Stremio (HTTP ' + res.status + ').');
  return data.result as T;
}

export interface StremioAccountOptions {
  /** Lire aussi la liste des addons (étape séparée, désactivée par défaut). */
  addons?: boolean;
  fetchFn?: FetchFn;
  /** Étape en cours, pour l'affichage. */
  onStep?: (step: 'login' | 'library' | 'addons') => void;
}

/**
 * Lit la bibliothèque (et, si demandé, les addons) du compte Stremio depuis l'appareil. Les identifiants ne sont utilisés
 * que pour ouvrir une session de lecture, fermée à la fin même en cas d'échec.
 */
export async function readStremioAccount(email: string, password: string, opts: StremioAccountOptions = {}): Promise<MigrationBundle> {
  const fetchFn = opts.fetchFn ?? ((u, i) => appFetch(u, i));
  opts.onStep?.('login');
  const login = await apiCall<{ authKey?: string }>('login', { type: 'Login', email, password, facebook: false }, fetchFn);
  const authKey = isObject(login) ? str(login.authKey) : '';
  if (!authKey) throw new StremioError('other', 'Stremio n’a pas ouvert de session.');
  try {
    opts.onStep?.('library');
    const lib = await apiCall<unknown[]>('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true }, fetchFn);
    const bundle = parseStremioExport({ library: Array.isArray(lib) ? lib : [] }, 'stremio');
    bundle.notes = bundle.notes.filter((n) => !n.startsWith('Aucune'));
    if (opts.addons) {
      opts.onStep?.('addons');
      const col = await apiCall<{ addons?: unknown[] }>('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true }, fetchFn);
      const list = isObject(col) && Array.isArray(col.addons) ? col.addons : [];
      bundle.addons = list.map(addonOfDescriptor).filter((a): a is MigrationAddon => a !== null);
    }
    return bundle;
  } finally {
    // Session de lecture seulement : fermée tout de suite (sans effet sur les autres appareils du compte).
    void apiCall('logout', { type: 'Logout', authKey }, fetchFn).catch(() => undefined);
  }
}
