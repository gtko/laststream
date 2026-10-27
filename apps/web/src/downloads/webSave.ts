/* Enregistrement d'un téléchargement sur l'appareil, depuis le navigateur web (LAST-498).
 *
 * Pourquoi : le magasin web (OPFS / IndexedDB, ODY-199) lit le fichier par `fetch`, soumis à CORS. Les serveurs de fichiers des
 * débrideurs (AllDebrid : `*.debrid.it`) n'envoient pas d'en-têtes CORS : le premier morceau est bloqué et le téléchargement échoue
 * en `content`. La coque et Android passent par leur transport natif ; le web n'en a pas, et un relais serveur est exclu (AllDebrid
 * seulement depuis l'appareil). Ici, deux voies, toutes deux depuis l'appareil :
 *  - dossier choisi (File System Access, Chrome/Edge bureau) : le fichier est lu en flux et écrit dans le dossier, si l'hébergeur
 *    autorise CORS ;
 *  - téléchargement du navigateur : un onglet, ouvert au clic (avant toute attente, sinon il serait bloqué), est dirigé vers le lien.
 *    Une navigation n'est pas soumise à CORS : le navigateur enregistre le fichier dans son dossier de téléchargements.
 * Le lien débridé ne sort jamais de l'appareil, n'est ni journalisé ni mémorisé. Seule la poignée du dossier est gardée (IndexedDB). */
import { DownloadError } from './types';

// ---------- Types minimaux de File System Access (absents des types DOM de TypeScript) ----------

type PermissionMode = { mode: 'readwrite' };
type PermissionState = 'granted' | 'denied' | 'prompt';

interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}

export interface FolderHandle {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission?(d: PermissionMode): Promise<PermissionState>;
  requestPermission?(d: PermissionMode): Promise<PermissionState>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry?(name: string): Promise<void>;
}

type DirectoryPicker = (opts?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FolderHandle>;

const RW: PermissionMode = { mode: 'readwrite' };

/** `showDirectoryPicker` du navigateur (Chrome/Edge bureau, contexte sécurisé), sinon null. */
function picker(): DirectoryPicker | null {
  try {
    const w = globalThis as unknown as { showDirectoryPicker?: DirectoryPicker; isSecureContext?: boolean };
    return typeof w.showDirectoryPicker === 'function' && w.isSecureContext !== false ? w.showDirectoryPicker.bind(globalThis) : null;
  } catch {
    return null;
  }
}

/** Le navigateur sait-il écrire dans un dossier choisi par l'utilisateur ? */
export function folderPickerSupported(): boolean {
  return picker() !== null;
}

// ---------- Poignée du dossier, mémorisée dans IndexedDB ----------

const DB_NAME = 'laststream-save-folder';
const STORE = 'handles';
const KEY = 'folder';

/** Poignée en mémoire (session) : évite de relire IndexedDB à chaque clic. `undefined` : pas encore lue. */
let cached: FolderHandle | null | undefined;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    return await new Promise<T>((resolve) => {
      try {
        const req = op(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve((mode === 'readonly' ? req.result : fallback) as T);
        req.onerror = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  } finally {
    db.close();
  }
}

const isFolder = (h: unknown): h is FolderHandle =>
  typeof h === 'object' && h !== null && (h as FolderHandle).kind === 'directory' && typeof (h as FolderHandle).getFileHandle === 'function';

/** Dossier mémorisé, ou null. Ne lève jamais. */
export async function getSaveFolder(): Promise<FolderHandle | null> {
  if (cached !== undefined) return cached;
  const raw = await withStore<unknown>('readonly', (s) => s.get(KEY), null);
  cached = isFolder(raw) ? raw : null;
  return cached;
}

/** Nom du dossier mémorisé (affichage), sans le lire sur le disque. */
export async function saveFolderName(): Promise<string | null> {
  return (await getSaveFolder())?.name ?? null;
}

/**
 * Ouvre le sélecteur de dossier (à appeler pendant un clic) et mémorise le dossier choisi. Null si l'utilisateur annule ou si le
 * navigateur ne sait pas le faire.
 */
export async function pickSaveFolder(): Promise<FolderHandle | null> {
  const pick = picker();
  if (!pick) return null;
  let handle: FolderHandle;
  try {
    handle = await pick({ id: 'laststream-downloads', mode: 'readwrite', startIn: 'downloads' });
  } catch {
    return null; // annulé (AbortError) ou refusé
  }
  cached = handle;
  await withStore('readwrite', (s) => s.put(handle, KEY), undefined);
  return handle;
}

/** Oublie le dossier : les téléchargements repartent vers le dossier du navigateur. */
export async function forgetSaveFolder(): Promise<void> {
  cached = null;
  await withStore('readwrite', (s) => s.delete(KEY), undefined);
}

/**
 * Permission d'écrire dans le dossier. Déjà accordée : sans geste. Sinon, `ask` la redemande (il faut un clic récent : à appeler
 * avant toute attente réseau). Vrai si l'écriture est permise.
 */
export async function folderWritable(h: FolderHandle, ask: boolean): Promise<boolean> {
  try {
    const now = h.queryPermission ? await h.queryPermission(RW) : 'granted';
    if (now === 'granted') return true;
    if (!ask || !h.requestPermission) return false;
    return (await h.requestPermission(RW)) === 'granted';
  } catch {
    return false;
  }
}

// ---------- Nom de fichier ----------

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Nom de fichier sûr pour tous les systèmes : sans séparateur ni caractère interdit, 150 caractères au plus. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const clean = (s: string): string =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s+(\.[a-z0-9]{1,5})$/i, '$1')
      .replace(/^[.\s]+|[.\s]+$/g, '');
  let out = clean(name ?? '');
  if (!out || RESERVED.test(out)) out = clean(fallback) || 'video';
  if (RESERVED.test(out)) out = '_' + out;
  if (out.length > 150) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 6 ? out.slice(dot) : '';
    out = out.slice(0, 150 - ext.length).trimEnd() + ext;
  }
  return out;
}

// ---------- Écriture dans le dossier ----------

/** Le navigateur ne peut pas lire ce lien (CORS) : l'appelant passe au téléchargement du navigateur. */
export class CorsBlockedError extends Error {
  constructor() {
    super('cors_blocked');
    this.name = 'CorsBlockedError';
  }
}

export interface FolderWriteOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Octets reçus et taille annoncée (null si inconnue). */
  onProgress?: (done: number, total: number | null) => void;
}

/**
 * Lit `url` en flux et l'écrit dans `folder` sous `name`. `CorsBlockedError` si la lecture est refusée par le navigateur avant tout
 * octet (le fichier n'est alors pas créé). Une erreur HTTP lève `DownloadError('link_expired')` ; un échec d'écriture
 * `DownloadError('store_failed')`. Un fichier partiel est supprimé.
 */
export async function writeToFolder(folder: FolderHandle, name: string, url: string, opts: FolderWriteOptions = {}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw new DownloadError('cancelled', false, err);
    // TypeError de `fetch` en ligne : en pratique CORS (l'hôte ne l'autorise pas).
    if (err instanceof TypeError && (typeof navigator === 'undefined' || navigator.onLine !== false)) throw new CorsBlockedError();
    throw new DownloadError('network', true, err);
  }
  if (!res.ok || !res.body) throw new DownloadError(res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410 ? 'link_expired' : 'network', false);
  const total = Number(res.headers.get('content-length')) || null;
  let writable: WritableLike;
  try {
    writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
  } catch (err) {
    void res.body.cancel().catch(() => undefined);
    throw new DownloadError('store_failed', false, err);
  }
  const reader = res.body.getReader();
  let done = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      try {
        await writable.write(chunk.value);
      } catch (err) {
        throw new DownloadError('store_failed', false, err);
      }
      done += chunk.value.length;
      opts.onProgress?.(done, total);
    }
    await writable.close();
    return done;
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    try {
      await (writable.abort ? writable.abort() : writable.close());
    } catch {
      /* déjà fermé */
    }
    try {
      await folder.removeEntry?.(name);
    } catch {
      /* fichier partiel laissé : rien d'autre à faire */
    }
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(opts.signal?.aborted ? 'cancelled' : 'network', !opts.signal?.aborted, err);
  }
}

// ---------- Téléchargement du navigateur ----------

/** Onglet ouvert au clic, dirigé ensuite vers le lien ; null si le navigateur a bloqué l'ouverture. */
export interface BrowserTab {
  go(url: string): void;
  close(): void;
}

/**
 * Ouvre tout de suite (pendant le clic) un onglet d'attente. Le lien n'est pas encore connu : il est débridé ensuite, et un
 * `window.open` lancé après une attente serait bloqué. Null si l'ouverture est refusée.
 */
export function openBrowserTab(open: (url: string, target: string) => Window | null = (u, t) => window.open(u, t)): BrowserTab | null {
  let win: Window | null = null;
  try {
    win = open('about:blank', '_blank');
  } catch {
    win = null;
  }
  if (!win) return null;
  try {
    win.document.title = 'Téléchargement…';
    win.document.body.innerHTML =
      '<meta name="referrer" content="no-referrer"><p style="font:16px system-ui,sans-serif;color:#ccc;background:#111;margin:0;padding:24px">' +
      'Préparation du téléchargement… Cet onglet se fermera de lui-même, ou affichera la vidéo : utilise alors « Enregistrer sous ».</p>';
    win.document.body.style.background = '#111';
  } catch {
    /* page d'attente facultative */
  }
  try {
    win.opener = null;
  } catch {
    /* propriété en lecture seule ailleurs */
  }
  const tab = win;
  return {
    go(url: string) {
      tab.location.replace(url);
    },
    close() {
      try {
        tab.close();
      } catch {
        /* déjà fermé */
      }
    },
  };
}

/** Lien de téléchargement sans onglet d'attente (onglet bloqué) : à lancer depuis un nouveau clic de l'utilisateur. */
export function browserDownload(url: string, name: string, doc: Document = document): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.referrerPolicy = 'no-referrer';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

export function resetWebSaveForTests(): void {
  cached = undefined;
}
