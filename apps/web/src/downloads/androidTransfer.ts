import type { PluginListenerHandle } from '@capacitor/core';
import { NativeDownloads, nativeCode, type LaststreamDownloadsPlugin, type NativeDownloadResult } from './androidPlugin';
import type { TransferFn } from './manager';
import { DownloadError, type DownloadErrorCode, type TransferProgress } from './types';

/* Transfert Android (ODY-200) : le service natif télécharge et écrit le fichier ; ce module relaie la progression,
 * l'annulation et les erreurs. Une erreur ne porte jamais l'URL : seul le code du plugin est repris. */

const NATIVE_CODES: readonly DownloadErrorCode[] = [
  'link_expired', 'content', 'network', 'range_mismatch', 'quota_exceeded', 'store_full', 'store_failed', 'cancelled',
];
/** Seuls ces codes valent un nouvel essai (le manager re-résout le lien ou attend le réseau). */
const RETRYABLE: readonly DownloadErrorCode[] = ['link_expired', 'network'];

/** Erreur du plugin → erreur de transfert du socle. Code inconnu ou absent : réseau, réessayable. */
function transferError(err: unknown): DownloadError {
  const raw = nativeCode(err);
  const code: DownloadErrorCode = NATIVE_CODES.includes(raw as DownloadErrorCode) ? (raw as DownloadErrorCode) : 'network';
  return new DownloadError(code, RETRYABLE.includes(code), raw);
}

const cancelled = (): DownloadError => new DownloadError('cancelled', false);

/** Appel dont l'échec ne doit rien casser (notifications, annulation, retrait d'écouteur). Ne lève jamais. */
async function quietly(op: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await op();
  } catch {
    /* ignoré */
  }
}

/** Abonnement à la progression du seul `id`. Sans abonnement (échec de l'enregistrement), le transfert suit quand même. */
async function listenProgress(
  plugin: LaststreamDownloadsPlugin,
  id: string,
  onProgress: (p: TransferProgress) => void | Promise<void>,
): Promise<PluginListenerHandle | undefined> {
  try {
    return await plugin.addListener('progress', (ev) => {
      if (ev?.id !== id) return;
      const p: TransferProgress = { bytesDone: ev.bytesDone, bytesTotal: ev.bytesTotal, etag: ev.etag, lastModified: ev.lastModified };
      try {
        void Promise.resolve(onProgress(p)).catch(() => undefined);
      } catch {
        /* un rappel défaillant n'interrompt pas le transfert */
      }
    });
  } catch {
    return undefined;
  }
}

export function createAndroidTransfer(plugin: LaststreamDownloadsPlugin = NativeDownloads): TransferFn {
  // Une fois par session de l'application (une fabrique = une session).
  let askedNotifications = false;

  return async (p, item): Promise<TransferProgress> => {
    if (p.signal.aborted) throw cancelled();
    if (!askedNotifications) {
      askedNotifications = true;
      // Sans attendre la réponse : le transfert ne dépend pas de la permission.
      void quietly(() => plugin.requestNotifications());
    }

    const { id } = item;
    let handle: PluginListenerHandle | undefined;
    let onAbort: (() => void) | undefined;
    try {
      handle = await listenProgress(plugin, id, p.onProgress);
      if (p.signal.aborted) throw cancelled();

      onAbort = () => void quietly(() => plugin.cancel({ id }));
      p.signal.addEventListener('abort', onAbort, { once: true });

      let res: NativeDownloadResult;
      try {
        res = await plugin.start({ id, url: p.url, title: item.title, bytesTotal: p.bytesTotal, etag: p.etag, maxBytes: p.maxBytes });
      } catch (err) {
        throw p.signal.aborted ? cancelled() : transferError(err);
      }
      if (p.signal.aborted) throw cancelled();
      return { bytesDone: res.bytesDone, bytesTotal: res.bytesTotal, etag: res.etag, lastModified: res.lastModified };
    } finally {
      if (onAbort) p.signal.removeEventListener('abort', onAbort);
      await quietly(async () => handle?.remove());
    }
  };
}
