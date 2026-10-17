import { isIP } from 'node:net';
import { isNonPublicAddress } from '../sources/ip.js';
import { type HostLookup, resolveHost, SourceError, type UrlGuard } from '../sources/http.js';

/** Cible refusée (adresse privée, nom local, hôte non public). Message sans URL. */
export class UnsafeTargetError extends SourceError {
  constructor() {
    super('adresse non publique refusée');
    this.name = 'UnsafeTargetError';
  }
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal)$/;

/** Hôte d'une URL sans crochets, en minuscules. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * Contrôle synchrone : http(s), hôte non vide, ni nom local (localhost, *.local, *.internal),
 * ni adresse IP littérale non publique. Ne résout pas le DNS.
 */
export function isLiteralSafe(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = bareHost(url);
  if (host === '' || LOCAL_NAME.test(host)) return false;
  if (isIP(host) !== 0 && isNonPublicAddress(host)) return false;
  return true;
}

/** Parse une URL saisie et renvoie null si elle n'est pas sûre au sens de isLiteralSafe. */
export function parseSafeUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return isLiteralSafe(url) ? url : null;
}

/**
 * Garde pour les URL d'origine utilisateur (import de playlist, proxy HLS) : contrôle littéral puis
 * résolution DNS ; toutes les adresses doivent être publiques. Appliquée à chaque saut de redirection.
 * `lookup` est injectable (tests).
 */
export function createPublicGuard(lookup: HostLookup = resolveHost): UrlGuard {
  return async (url) => {
    if (!isLiteralSafe(url)) throw new UnsafeTargetError();
    const host = bareHost(url);
    if (isIP(host) !== 0) return;
    let addresses: readonly string[];
    try {
      addresses = await lookup(host);
    } catch {
      throw new SourceError('hôte non résolu');
    }
    if (addresses.length === 0 || addresses.some((address) => isNonPublicAddress(address))) {
      throw new UnsafeTargetError();
    }
  };
}
