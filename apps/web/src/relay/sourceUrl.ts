/* Lien que l'appareil de l'hôte relaie aux invités : une source HTTP(S) qu'il lit déjà directement, sans serveur de streaming.
 *  - lien débridé (hébergeur autorisé, lu par l'appareil) ;
 *  - lien direct d'un addon (`stream.url`, lu tel quel : ni proxy, ni serveur de streaming local).
 * Jamais un torrent ni un magnet (`infoHash`, lecture P2P), jamais une adresse privée ou locale (serveur de streaming, LAN).
 * Fonction pure : la valeur est gardée sur l'appareil de l'hôte, elle n'est jamais envoyée à un invité ni journalisée. */
import { isPrivateHost } from '../player/skip';
import { parseDebridUrl } from '../sources/debrid/http';

/** Forme minimale de la source choisie (`view.stream`). */
export interface StreamSource {
  url?: unknown;
  infoHash?: unknown;
}

/**
 * Lien HTTP(S) à relayer pour la lecture en cours, ou null. `mediaUrl` est le lien réellement lu par le lecteur ; il n'est relayé
 * que s'il est le lien débridé de l'hôte ou le lien direct de l'addon (jamais un proxy du serveur de streaming, jamais un torrent).
 */
export function relayableUrl(mediaUrl: unknown, stream: StreamSource | null | undefined): string | null {
  if (typeof mediaUrl !== 'string' || !/^https?:\/\/\S+$/i.test(mediaUrl)) return null;
  if (parseDebridUrl(mediaUrl)) return mediaUrl;
  if (!stream || typeof stream !== 'object' || stream.infoHash) return null;
  if (typeof stream.url !== 'string' || stream.url !== mediaUrl) return null;
  let host: string;
  try {
    host = new URL(mediaUrl).hostname;
  } catch {
    return null;
  }
  return isPrivateHost(host) ? null : mediaUrl;
}
