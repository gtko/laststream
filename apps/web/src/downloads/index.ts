/* Index persisté des téléchargements (ODY-198) : une entrée par téléchargement, sans aucun lien (les items n'en portent pas).
 * IndexedDB si disponible, sinon mémoire. Toute erreur de stockage est absorbée : l'index ne fait jamais planter l'appelant. */
import type { DownloadIndex, DownloadItem } from './types';

const DB_NAME = 'laststream-downloads';
const DB_VERSION = 1;
const STORE = 'items';

const copy = (item: DownloadItem): DownloadItem => structuredClone(item);

/** Index en mémoire : repli quand IndexedDB est indisponible. Chaque élément est copié à l'entrée et à la sortie. */
export class MemoryDownloadIndex implements DownloadIndex {
  private readonly items = new Map<string, DownloadItem>();

  all(): Promise<DownloadItem[]> {
    return Promise.resolve([...this.items.values()].map(copy));
  }

  put(item: DownloadItem): Promise<void> {
    this.items.set(item.id, copy(item));
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.items.delete(id);
    return Promise.resolve();
  }
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Écriture dans une transaction : résolue à `oncomplete` (transaction validée), rejetée à `onabort` ou `onerror` (ex. QuotaExceededError). */
function write(db: IDBDatabase, apply: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    apply(tx.objectStore(STORE));
  });
}

/**
 * IndexedDB ; repli sur la mémoire si elle est refusée, bloquée, absente, ou si une opération échoue.
 * `memory` garde les derniers items connus (base lue ou écrite avec succès) : le repli part de là, sans rien perdre.
 * Après un échec, tout passe par la mémoire : aucune écriture n'est partagée entre les deux stockages.
 */
export class IdbDownloadIndex implements DownloadIndex {
  private db: Promise<IDBDatabase | null> | null = null;
  private readonly memory = new Map<string, DownloadItem>();
  private degraded = false;

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => {
          const db = req.result;
          // Une autre fenêtre veut une version plus récente : on libère la base. La prochaine opération la rouvre
          // (si la réouverture échoue, elle bascule en mémoire).
          db.onversionchange = () => {
            db.close();
            this.db = null;
          };
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }

  /** Base à utiliser, ou null quand le repli mémoire est actif. */
  private async database(): Promise<IDBDatabase | null> {
    if (this.degraded) return null;
    const db = await this.open();
    if (db === null) this.degraded = true;
    return db;
  }

  async all(): Promise<DownloadItem[]> {
    const db = await this.database();
    if (db !== null) {
      try {
        const rows = await request<DownloadItem[]>(db.transaction(STORE).objectStore(STORE).getAll());
        this.memory.clear();
        for (const row of rows) this.memory.set(row.id, row);
        return rows.map(copy);
      } catch {
        this.degraded = true;
      }
    }
    return [...this.memory.values()].map(copy);
  }

  async put(item: DownloadItem): Promise<void> {
    const db = await this.database();
    if (db !== null) {
      try {
        await write(db, (store) => store.put(item));
        this.memory.set(item.id, copy(item));
        return;
      } catch {
        this.degraded = true;
      }
    }
    this.memory.set(item.id, copy(item));
  }

  async delete(id: string): Promise<void> {
    const db = await this.database();
    if (db !== null) {
      try {
        await write(db, (store) => store.delete(id));
        this.memory.delete(id);
        return;
      } catch {
        this.degraded = true;
      }
    }
    this.memory.delete(id);
  }
}

/** Index persisté si l'API IndexedDB existe (un refus à l'ouverture bascule seul sur la mémoire), sinon mémoire. Ne lève jamais. */
export function createDownloadIndex(): DownloadIndex {
  try {
    if (typeof indexedDB !== 'undefined') return new IdbDownloadIndex();
  } catch {
    /* accès à indexedDB refusé : repli mémoire */
  }
  return new MemoryDownloadIndex();
}
