import { NativeDownloads, nativeCode, type LaststreamDownloadsPlugin } from './androidPlugin';
import { DownloadError, type DownloadSink, type DownloadStore } from './types';

/* Magasin Android (ODY-200) : chaque fichier vit dans le stockage privé de l'application, géré par le plugin natif.
 * Toute erreur du plugin devient une `DownloadError` de stockage ; le message ne contient jamais d'URL. */

/** Erreur du plugin → erreur de stockage du socle (`store_full` seulement si le natif le dit). */
function storeError(err: unknown): DownloadError {
  const code = nativeCode(err);
  return new DownloadError(code === 'store_full' ? 'store_full' : 'store_failed', false, code);
}

/** Base64 d'un morceau, par tranches : un `String.fromCharCode(...)` sur 8 Mo dépasserait la pile. */
function toBase64(bytes: Uint8Array): string {
  const step = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function createAndroidStore(plugin: LaststreamDownloadsPlugin = NativeDownloads): DownloadStore {
  /** Appel au plugin : toute erreur devient une erreur de stockage. */
  const call = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      throw storeError(err);
    }
  };

  /** Octets déjà écrits ; un fichier absent compte pour 0 (rien n'est créé). */
  const sizeOf = async (id: string): Promise<number> => {
    try {
      return (await plugin.size({ id })).size;
    } catch (err) {
      if (nativeCode(err) === 'not_found') return 0;
      throw storeError(err);
    }
  };

  const sinkFor = (id: string): DownloadSink => ({
    size: () => sizeOf(id),
    write: (offset, chunk) => call(() => plugin.write({ id, offset, data: toBase64(chunk) })),
    truncate: (len) => call(() => plugin.truncate({ id, len })),
    finalize: () => call(() => plugin.finalize({ id })),
    // Rien à libérer côté JS : le natif garde ses propres handles.
    close: async () => undefined,
  });

  return {
    // Pas d'appel natif à l'ouverture : le fichier est créé à la première écriture.
    async open(id) {
      return sinkFor(id);
    },
    size: (id) => sizeOf(id),
    async remove(id) {
      try {
        await plugin.remove({ id });
      } catch (err) {
        // Supprimer un fichier absent n'est pas une erreur.
        if (nativeCode(err) !== 'not_found') throw storeError(err);
      }
    },
    async usage() {
      const r = await call(() => plugin.usage());
      return { used: r.used, available: r.available };
    },
  };
}

/** Chemin et URI du fichier finalisé (le lecteur libVLC l'ouvre ainsi) ; null tant qu'il n'est pas finalisé. */
export async function androidLocalFile(id: string, plugin: LaststreamDownloadsPlugin = NativeDownloads): Promise<{ path: string; uri: string } | null> {
  try {
    const { path, uri } = await plugin.localPath({ id });
    return { path, uri };
  } catch (err) {
    if (nativeCode(err) === 'not_found') return null;
    throw storeError(err);
  }
}
