import { isIP } from 'node:net';
import type { ContentRef } from '../types.js';
import { isNonPublicAddress } from './ip.js';
import { upstreamStreamUrl, type UpstreamSource } from './upstream.js';

/**
 * Repli « via l'appareil » : quand un addon amont refuse l'IP du serveur (403, 429, 5xx, page de vérification, délai),
 * lastAddon donne à l'appareil l'URL /stream de cet addon pour que l'appareil l'interroge depuis son IP.
 * L'URL peut contenir la clé de débrideur de l'utilisateur (c'est l'addon qui débride, comme dans Stremio) : c'est sa propre
 * donnée sur sa propre session. La réponse est donc `no-store` et l'URL n'est jamais journalisée.
 */
export interface DeviceFetchEntry {
  addonId: string;
  /** URL /stream de l'addon pour ce titre. */
  url: string;
}

/** Hôte public ? (les adresses privées ou locales ne sont jamais bloquées par Cloudflare : inutile de les confier à l'appareil.) */
function isPublicHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return !isNonPublicAddress(host);
  return host.includes('.') && !/\.(?:local|lan|internal|localhost)$/i.test(host);
}

/** Entrée `deviceFetch` d'un addon bloqué : son URL /stream pour le titre. Undefined si l'adresse est invalide ou locale. */
export function deviceFetchEntry(source: UpstreamSource, ref: ContentRef): DeviceFetchEntry | undefined {
  let target: URL;
  try {
    target = new URL(source.url);
  } catch {
    return undefined;
  }
  if ((target.protocol !== 'https:' && target.protocol !== 'http:') || !isPublicHost(target)) return undefined;
  return { addonId: source.name, url: upstreamStreamUrl(source.url, ref) };
}
