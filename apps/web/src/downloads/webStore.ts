/* Magasin des téléchargements web (ODY-199) : implémente `DownloadStore` du socle (ODY-198) sur OPFS, avec repli IndexedDB.
 * Le stockage est choisi à la première utilisation ; la persistance est demandée une fois, au premier téléchargement
 * (sur un geste récent de l'utilisateur), sans attendre la réponse. Sans aucun stockage utilisable, `open` lève `store_failed` et
 * `info().backend` vaut null : l'interface affiche alors `webDownloadErrorMessage`. */
import { IdbBackend, openDownloadsDb } from './idbBackend';
import { OpfsBackend, opfsAvailable } from './opfsBackend';
import { SegmentedStore, type SegmentBackend } from './segmented';
import { estimateStorage, requestPersistence, type StorageManagerLike, type WebStorageInfo } from './webStorage';
import { DownloadError, type DownloadSink, type DownloadStore } from './types';

type WebBackendKind = SegmentBackend['kind'];

export interface WebDownloadInfo extends WebStorageInfo {
  /** Stockage en service ; null si le navigateur n'en offre aucun. */
  backend: WebBackendKind | null;
}

export interface WebDownloadStoreOptions {
  /** Force un stockage (tests, diagnostic) ; sinon OPFS puis IndexedDB. */
  prefer?: WebBackendKind;
  storage?: StorageManagerLike;
  /** Remplace la détection d'un geste récent de l'utilisateur (tests). */
  userGesture?: () => boolean;
  /** Remplace la détection (tests). */
  detect?: () => Promise<SegmentBackend | null>;
}

async function detectBackend(prefer: WebBackendKind | undefined): Promise<SegmentBackend | null> {
  if (prefer !== 'indexeddb') {
    const dir = await opfsAvailable();
    if (dir) return new OpfsBackend(dir);
    if (prefer === 'opfs') return null;
  }
  const db = await openDownloadsDb();
  return db ? new IdbBackend(db) : null;
}

export class WebDownloadStore implements DownloadStore {
  private inner: Promise<SegmentedStore | null> | null = null;
  private persistAsked = false;

  constructor(private readonly opts: WebDownloadStoreOptions = {}) {}

  private ready(): Promise<SegmentedStore | null> {
    this.inner ??= (this.opts.detect ?? (() => detectBackend(this.opts.prefer)))().then(
      (backend) => (backend ? new SegmentedStore(backend) : null),
      () => null,
    );
    return this.inner;
  }

  /** Activation transitoire de l'utilisateur (clic récent) ; vraie si le navigateur ne sait pas la dire. */
  private userGesture(): boolean {
    if (this.opts.userGesture) return this.opts.userGesture();
    return typeof navigator === 'undefined' || navigator.userActivation?.isActive !== false;
  }

  private async need(): Promise<SegmentedStore> {
    const store = await this.ready();
    if (!store) throw new DownloadError('store_failed', false);
    return store;
  }

  async open(id: string): Promise<DownloadSink> {
    const store = await this.need();
    // Persistance demandée seulement sur un geste récent de l'utilisateur : une reprise automatique au chargement de la page
    // ne doit pas ouvrir l'invite de Firefox. L'interface peut aussi appeler `persist()` sur son bouton.
    if (!this.persistAsked && this.userGesture()) {
      this.persistAsked = true;
      void requestPersistence(this.opts.storage);
    }
    return store.open(id);
  }

  async size(id: string): Promise<number> {
    return (await this.ready())?.size(id) ?? 0;
  }

  async remove(id: string): Promise<void> {
    await (await this.ready())?.remove(id);
  }

  async usage(): Promise<{ used: number; available?: number }> {
    const store = await this.ready();
    const used = store ? (await store.usage()).used : 0;
    const { available } = await estimateStorage(this.opts.storage);
    return available === null ? { used } : { used, available };
  }

  /** Le fichier téléchargé, lisible hors ligne ; null s'il est absent ou vide. Base de la lecture locale (ODY-203). */
  async file(id: string, type?: string): Promise<Blob | null> {
    return (await this.ready())?.file(id, type) ?? null;
  }

  /** Stockage en service, quota du navigateur et persistance (pour l'écran « Téléchargements »). */
  async info(): Promise<WebDownloadInfo> {
    const store = await this.ready();
    return { backend: store?.kind ?? null, ...(await estimateStorage(this.opts.storage)) };
  }

  /** Redemande la persistance (bouton de l'interface) ; vrai si elle est accordée. */
  persist(): Promise<boolean> {
    return requestPersistence(this.opts.storage);
  }
}

export const createWebDownloadStore = (opts?: WebDownloadStoreOptions): WebDownloadStore => new WebDownloadStore(opts);
