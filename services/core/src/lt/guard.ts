import { isIP } from 'node:net';
import { isNonPublicAddress } from '../sources/ip.js';
import { UnsafeTargetError, type UrlGuard } from '../sources/http.js';

export { UnsafeTargetError };

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
 * Garde appliquée à chaque saut (URL initiale et redirections) : contrôle littéral uniquement. Le DNS n'est pas
 * résolu ici : il est résolu et contrôlé à la connexion par l'agent épinglé (pinnedLookup), sur la même réponse
 * que celle utilisée pour la connexion. Un contrôle DNS préalable laisserait une fenêtre de rebinding.
 */
export function createPublicGuard(): UrlGuard {
  return async (url) => {
    if (!isLiteralSafe(url)) throw new UnsafeTargetError();
  };
}
