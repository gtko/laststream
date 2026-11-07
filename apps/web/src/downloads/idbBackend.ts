/* Repli IndexedDB des téléchargements web (ODY-199), quand OPFS est absent (Safari hors worker, navigation privée de Firefox) :
 * un enregistrement par segment, clé `<id>\0<décalage sur 16 chiffres>\0<longueur>` (la longueur dans la clé évite de charger
 * les données pour connaître la taille). Base distincte de l'index (`laststream-downloads`) : aucune migration partagée.
 * Une écriture est une transaction : validée d'un bloc ou annulée (`QuotaExceededError`), jamais à moitié. */
import type { Segment, SegmentBackend } from './segmented';

const DB_NAME = 'laststream-downloads-data';
const DB_VERSION = 1;
const STORE = 'segments';

const pad = (start: number): string => String(start).padStart(16, '0');
const prefix = (id: string): string => `${encodeURIComponent(id)}\u0000`;
const keyOf = (id: string, start: number, length: number): string => `${prefix(id)}${pad(start)}\u0000${length}`;
/** Toutes les clés de `id` (`\u0001` suit `\u0000`). */
const rangeOf = (id: string): IDBKeyRange => IDBKeyRange.bound(prefix(id), `${encodeURIComponent(id)}\u0001`);
/** Les clés du segment de `id` à `start`, quelle que soit sa longueur. */
const segmentRange = (id: string, start: number): IDBKeyRange =>
  IDBKeyRange.bound(`${prefix(id)}${pad(start)}\u0000`, `${prefix(id)}${pad(start)}\u0001`);

function parseKey(key: IDBValidKey): Segment | null {
  const m = /\u0000(\d{16})\u0000(\d+)$/.exec(String(key));
  return m ? { start: Number(m[1]), length: Number(m[2]) } : null;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Transaction d'écriture : résolue à `oncomplete` (validée), rejetée à `onabort` (ex. QuotaExceededError). */
function write(db: IDBDatabase, apply: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    apply(tx.objectStore(STORE));
  });
}

/** Ouvre la base ; null si IndexedDB est absent, refusé ou bloqué. */
export function openDownloadsDb(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (!factory) return resolve(null);
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export class IdbBackend implements SegmentBackend {
  readonly kind = 'indexeddb' as const;

  constructor(private readonly db: IDBDatabase) {}

  private keys(range?: IDBKeyRange): Promise<IDBValidKey[]> {
    return request(this.db.transaction(STORE).objectStore(STORE).getAllKeys(range));
  }

  async list(id: string): Promise<Segment[]> {
    const out: Segment[] = [];
    for (const key of await this.keys(rangeOf(id))) {
      const seg = parseKey(key);
      if (seg && seg.length > 0) out.push(seg);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  async write(id: string, start: number, data: Uint8Array): Promise<void> {
    // `data` peut être une vue sur un grand tampon : le clonage structuré copierait tout le tampon.
    const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
    const buffer = whole ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await write(this.db, (store) => {
      // Un ancien segment à ce décalage (autre longueur, donc autre clé) est remplacé dans la même transaction.
      store.delete(segmentRange(id, start));
      store.put(buffer, keyOf(id, start, data.byteLength));
    });
  }

  async read(id: string, segment: Segment): Promise<Blob> {
    const data = await request<ArrayBuffer | undefined>(
      this.db.transaction(STORE).objectStore(STORE).get(keyOf(id, segment.start, segment.length)),
    );
    return new Blob(data === undefined ? [] : [data]);
  }

  async remove(id: string, starts?: readonly number[]): Promise<void> {
    await write(this.db, (store) => {
      if (starts === undefined) store.delete(rangeOf(id));
      else for (const start of starts) store.delete(segmentRange(id, start));
    });
  }

  async usage(): Promise<number> {
    let total = 0;
    for (const key of await this.keys()) total += parseKey(key)?.length ?? 0;
    return total;
  }
}
