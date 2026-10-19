/* Cache client des miniatures, par (identifiant de source, index de tranche). IndexedDB si disponible, sinon mémoire.
 * Toute erreur de stockage est ignorée : le cache est un confort, jamais une condition. */

export interface ThumbStore {
  get(key: string): Promise<Blob | undefined>;
  set(key: string, blob: Blob): Promise<void>;
}

/** Empreinte courte et stable d'un texte (cyrb53) : identifiant de source dans les clés, sans garder l'URL. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const thumbKey = (sourceId: string, index: number): string => `${hashText(sourceId)}:${index}`;

/** Ce que l'on sait d'une source : empreinte du torrent et index du fichier dedans, ou le lien (débridé, il change à chaque régénération). */
export interface SourceRef {
  infoHash?: string | null;
  fileIdx?: number | null;
  url?: string | null;
}

/**
 * Identifiant stable d'une source pour le cache : infoHash (en minuscules) et index du fichier s'ils existent, sinon empreinte
 * de l'adresse sans sa query string. Le lien lui-même n'est jamais renvoyé ni stocké. Null si rien d'exploitable.
 */
export function stableSourceId(ref: SourceRef): string | null {
  const hash = typeof ref.infoHash === 'string' ? ref.infoHash.trim().toLowerCase() : '';
  if (hash !== '') return `ih:${hash}:${Number.isInteger(ref.fileIdx) ? ref.fileIdx : ''}`;
  if (typeof ref.url === 'string' && ref.url !== '') return `url:${hashText(ref.url.split(/[?#]/)[0])}`;
  return null;
}

export class MemoryThumbStore implements ThumbStore {
  private readonly map = new Map<string, Blob>();
  constructor(private readonly capacity = 400) {}
  get(key: string): Promise<Blob | undefined> { return Promise.resolve(this.map.get(key)); }
  set(key: string, blob: Blob): Promise<void> {
    this.map.delete(key);
    this.map.set(key, blob);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string);
    return Promise.resolve();
  }
}

const DB_NAME = 'laststream-thumbs';
const STORE = 'frames';
/** Images gardées au plus (≈ 3 Ko chacune) : de quoi couvrir plusieurs films de 3 h. */
export const IDB_CAPACITY = 4000;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

/** IndexedDB ; repli silencieux sur la mémoire si elle est indisponible (fenêtre privée, données bloquées). */
export class IdbThumbStore implements ThumbStore {
  private db: Promise<IDBDatabase | null> | null = null;
  private readonly fallback = new MemoryThumbStore();
  private writes = 0;

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }

  async get(key: string): Promise<Blob | undefined> {
    try {
      const db = await this.open();
      if (db === null) return await this.fallback.get(key);
      const row = await request(db.transaction(STORE).objectStore(STORE).get(key)) as { blob: Blob } | undefined;
      return row?.blob;
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, blob: Blob): Promise<void> {
    try {
      const db = await this.open();
      if (db === null) return await this.fallback.set(key, blob);
      await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ blob, at: Date.now() }, key));
      this.writes += 1;
      if (this.writes % 100 === 0) void this.trim(db);
    } catch {
      await this.fallback.set(key, blob);
    }
  }

  /** Supprime les plus anciennes au-delà de la capacité. */
  private async trim(db: IDBDatabase): Promise<void> {
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const count = await request(store.count());
      if (count <= IDB_CAPACITY) return;
      const keys = await request(store.getAllKeys());
      const rows = await Promise.all(keys.map(async (k) => ({ k, at: ((await request(store.get(k))) as { at: number }).at })));
      rows.sort((a, b) => a.at - b.at);
      for (const r of rows.slice(0, count - IDB_CAPACITY)) store.delete(r.k);
    } catch { /* ignoré */ }
  }
}
