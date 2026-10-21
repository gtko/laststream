import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/* Plugin Android `LaststreamDownloads` (téléchargements hors ligne, ODY-200) : le service natif télécharge le fichier en
 * arrière-plan, l'écrit dans le stockage privé de l'application et notifie la progression. Contrat figé avec le code natif.
 * Aucune URL ne doit remonter dans un message d'erreur : seul le `code` d'une erreur du plugin est repris. */

/** Démarrage ou reprise. Le natif lit lui-même le point de reprise (taille du fichier `.part`). */
interface NativeDownloadStart {
  id: string;
  url: string;
  title: string;
  bytesTotal?: number;
  etag?: string;
  maxBytes?: number;
}

/** Fin d'un job : l'avancement final et les validateurs du lien. */
export interface NativeDownloadResult {
  bytesDone: number;
  bytesTotal?: number;
  etag?: string;
  lastModified?: string;
}

/** Évènement `progress` (environ une fois par seconde). */
export interface NativeDownloadProgress extends NativeDownloadResult {
  id: string;
}

export interface LaststreamDownloadsPlugin {
  /** Se résout à la fin du job ; rejette avec `err.code` (`link_expired`, `network`, `quota_exceeded`, …). */
  start(options: NativeDownloadStart): Promise<NativeDownloadResult>;
  /** Interrompt le job et garde le fichier partiel. */
  cancel(options: { id: string }): Promise<void>;
  size(options: { id: string }): Promise<{ size: number }>;
  truncate(options: { id: string; len: number }): Promise<void>;
  /** `data` : morceau encodé en base64. */
  write(options: { id: string; offset: number; data: string }): Promise<void>;
  finalize(options: { id: string }): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  usage(): Promise<{ used: number; available?: number }>;
  /** Rejette `not_found` tant que le fichier n'est pas finalisé. */
  localPath(options: { id: string }): Promise<{ path: string; uri: string }>;
  requestNotifications(): Promise<{ granted: boolean }>;
  addListener(event: 'progress', fn: (data: NativeDownloadProgress) => void): Promise<PluginListenerHandle>;
}

export const NativeDownloads = registerPlugin<LaststreamDownloadsPlugin>('LaststreamDownloads');

/** Code d'une erreur du plugin, sans le reste du message (qui peut contenir une adresse ou un chemin). */
export function nativeCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** Application Android avec le plugin de téléchargement ; faux dans le navigateur, la coque Windows et iOS. */
export function isAndroidDownloads(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('LaststreamDownloads');
  } catch {
    return false;
  }
}
