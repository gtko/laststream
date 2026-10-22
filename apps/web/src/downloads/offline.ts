/* Sources locales pour la lecture hors ligne (ODY-203) : retrouve un téléchargement terminé et en donne l'adresse au lecteur.
 *
 * - web : le fichier du magasin (OPFS ou IndexedDB) devient une URL d'objet que lit le `<video>` ;
 * - Android : l'URI `file://` du fichier privé, ouvert par libVLC ;
 * - Windows : chemin du fichier téléchargé, ouvert par mpv (`getShellDownloadPath` du magasin de la coque, ODY-201).
 * Aucune requête réseau, aucun lien débridé : seul l'index local et le magasin de la plateforme sont lus. */
import { androidLocalFile } from './androidStore';
import { createDownloadIndex } from './index';
import { isPurgePending } from './settings';
import { getShellDownloadPath } from './shellStore';
import { createWebDownloadStore } from './webStore';
import { downloadId, type DownloadIndex, type DownloadItem } from './types';

export type OfflinePlatform = 'web' | 'android' | 'shell';

/** Fichier lisible hors ligne, prêt pour un moteur. `release` libère l'URL d'objet (web) ; à appeler à la fermeture du lecteur. */
export interface OfflineSource {
  id: string;
  platform: OfflinePlatform;
  /** Adresse passée au moteur : `blob:` (web), `file://` (Android) ou chemin local (Windows). */
  url: string;
  filename: string;
  /** Extension du fichier en minuscules, sans point (`mkv`, `mp4`…), ou chaîne vide. */
  container: string;
  /** Qualité choisie au téléchargement (« 1080p »), ou chaîne vide. */
  quality: string;
  /** Taille du fichier en octets (0 si inconnue). */
  size: number;
  release(): void;
}

/** Ce que sait fournir chaque plateforme ; un fournisseur absent ou qui échoue vaut « pas de copie locale ». */
export interface OfflineProviders {
  /** Web : le fichier téléchargé (`WebDownloadStore.file`). */
  blob?: (id: string, type: string, size: number) => Promise<Blob | null>;
  /** Android : chemin et URI du fichier finalisé (`androidLocalFile`). */
  android?: (id: string) => Promise<{ path: string; uri: string } | null>;
  /** Windows : chemin du fichier finalisé, lisible par mpv ; null s'il est absent. */
  shell?: (id: string) => Promise<string | null>;
}

export interface OfflineDeps {
  index: DownloadIndex;
  providers: OfflineProviders;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export interface OfflineRef {
  /** Clé du titre dans le lecteur (`movie:123`, `tv:456`), utilisée comme `metaId` des téléchargements. */
  key: string;
  season?: number | null;
  episode?: number | null;
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t',
};

/** Extension en minuscules d'un nom de fichier (sans requête ni fragment), ou chaîne vide. */
export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name.split('?')[0].split('#')[0]);
  return m ? m[1].toLowerCase() : '';
}

const containerOf = (item: DownloadItem): string => {
  const c = (item.container ?? '').toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(c) ? c : extensionOf(item.filename ?? '');
};

/** Le téléchargement terminé de ce titre (film ou épisode), ou null. */
export async function findDownloaded(index: DownloadIndex, ref: OfflineRef): Promise<DownloadItem | null> {
  const id = downloadId(ref.key, ref.season ?? undefined, ref.episode ?? undefined);
  try {
    const all = await index.all();
    return all.find((i) => i.id === id && i.state === 'done') ?? null;
  } catch {
    return null;
  }
}

/**
 * Source locale du titre pour cette plateforme, ou null (pas de téléchargement terminé, fichier absent, plateforme sans adaptateur,
 * erreur du magasin). Ne lève jamais : l'appelant retombe alors sur le streaming s'il y a du réseau.
 */
export async function findOfflineSource(deps: OfflineDeps, platform: OfflinePlatform, ref: OfflineRef): Promise<OfflineSource | null> {
  const item = await findDownloaded(deps.index, ref);
  if (!item) return null;
  const container = containerOf(item);
  const filename = item.filename ?? '';
  const base = { id: item.id, platform, filename, container, quality: item.source.quality ?? '', size: item.bytesTotal ?? item.bytesDone };
  try {
    if (platform === 'android') {
      const f = await deps.providers.android?.(item.id);
      return f ? { ...base, url: f.uri, release: () => undefined } : null;
    }
    if (platform === 'shell') {
      const path = await deps.providers.shell?.(item.id);
      return path ? { ...base, url: path, release: () => undefined } : null;
    }
    const blob = await deps.providers.blob?.(item.id, MIME[container] ?? '', base.size);
    if (!blob) return null;
    const make = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
    const revoke = deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
    const url = make(blob);
    let released = false;
    return { ...base, url, release: () => { if (!released) { released = true; revoke(url); } } };
  } catch {
    return null;
  }
}

// ---------- Câblage de l'application ----------

const IDB_MAX_BYTES = 1.5e9;

let sharedIndex: DownloadIndex | null = null;
let webStore: ReturnType<typeof createWebDownloadStore> | null = null;

/** Index des téléchargements lu par la lecture hors ligne (même base IndexedDB que le gestionnaire). */
function sharedDownloadIndex(): DownloadIndex {
  sharedIndex ??= createDownloadIndex();
  return sharedIndex;
}

/** Source locale du titre sur cette plateforme, avec les adaptateurs réels. */
export function offlineSourceFor(platform: OfflinePlatform, ref: OfflineRef, index: DownloadIndex = sharedDownloadIndex()): Promise<OfflineSource | null> {
  // Déconnexion explicite : les fichiers du compte précédent attendent leur purge (au démarrage), jamais lus par le suivant.
  if (isPurgePending()) return Promise.resolve(null);
  return findOfflineSource(
    {
      index,
      providers: {
        blob: async (id, type, size) => {
          const store = (webStore ??= createWebDownloadStore());
          // IndexedDB recharge le fichier entier en mémoire : au-delà de ce seuil, mieux vaut ne pas risquer de planter l'onglet.
          if (size > IDB_MAX_BYTES && (await store.info()).backend === 'indexeddb') return null;
          return store.file(id, type);
        },
        android: (id) => androidLocalFile(id),
        shell: (id) => getShellDownloadPath(id),
      },
    },
    platform,
    ref,
  );
}
