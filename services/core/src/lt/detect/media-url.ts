import { isLiteralSafe } from '../guard.js';

/** Durée plausible d'un épisode ou d'un film rapporté (secondes). */
export const MIN_REPORT_DURATION = 60;
export const MAX_REPORT_DURATION = 86_400;

/** Longueur maximale d'une URL de média acceptée. */
const MAX_URL_LENGTH = 4096;

/** Prédicat des URL locales autorisées malgré tout (serveur de streaming local). */
export type LocalUrlPolicy = (url: URL) => boolean;

/** Seule exception aux adresses privées : le serveur de streaming local (127.0.0.1:11470). */
export const defaultLocalPolicy: LocalUrlPolicy = (url) =>
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '11470';

/**
 * URL de média validée : http(s), sans identifiants, ni nom local ni IP privée (sauf le serveur local). Le DNS est
 * contrôlé à la connexion (agent épinglé). Retourne null si l'URL est refusée, sans jamais citer sa valeur.
 */
export function validateMediaUrl(raw: unknown, allowLocal: LocalUrlPolicy = defaultLocalPolicy): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return allowLocal(url) || isLiteralSafe(url) ? url : null;
}
