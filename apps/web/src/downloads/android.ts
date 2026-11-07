import { NativeDownloads, type LaststreamDownloadsPlugin } from './androidPlugin';
import { createAndroidStore } from './androidStore';
import { createAndroidTransfer } from './androidTransfer';
import type { TransferFn } from './manager';
import type { DownloadStore } from './types';

/* Assemblage Android (ODY-200) : magasin et transfert du plugin natif, à passer à `new DownloadManager({ ..., store, transfer })`.
 * Aucun module de l'application ne l'importe encore : le branchement de l'interface est hors périmètre. */
export function createAndroidDownloads(plugin: LaststreamDownloadsPlugin = NativeDownloads): { store: DownloadStore; transfer: TransferFn } {
  return { store: createAndroidStore(plugin), transfer: createAndroidTransfer(plugin) };
}
