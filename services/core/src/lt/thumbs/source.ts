import type { IssuedUrls } from '../../play/issued.js';
import { isLiteralSafe } from '../guard.js';
import { defaultLocalPolicy, type LocalUrlPolicy } from '../detect/media-url.js';

const MAX_URL_LENGTH = 4096;
const STREAMING_PORT = '11470';

export interface ThumbSource {
  /** Cible réellement lue (par le relais local, jamais directement par ffmpeg). */
  target: URL;
  /** Clé de cache : empreinte de l'URL soumise, stable tant que le lien de lecture lastAddon l'est. */
  submitted: string;
}

/**
 * Sources acceptées pour les miniatures, et rien d'autre :
 *  (a) le serveur de streaming local (http://127.0.0.1:11470 ou http://localhost:11470) ;
 *  (b) une URL http(s) publique que lastAddon a émise ou résolue récemment (registre `issued`), ou l'URL de lecture
 *      lastAddon (/play) dont le lien débridé a été résolu récemment : c'est alors ce lien qui est lu.
 * Pas d'identifiants dans l'URL, pas de schéma autre que http(s), pas d'adresse privée (hors serveur local).
 * `extraLocal` (tests, injection) ajoute des origines locales autorisées sans relâcher la règle par défaut.
 */
export async function resolveThumbSource(raw: unknown, issued: IssuedUrls, extraLocal?: LocalUrlPolicy): Promise<ThumbSource | null> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;

  // localhost:11470 est le même serveur que 127.0.0.1:11470.
  if (url.protocol === 'http:' && url.hostname === 'localhost' && url.port === STREAMING_PORT) {
    url = new URL(url.href);
    url.hostname = '127.0.0.1';
  }
  const local = (candidate: URL): boolean => defaultLocalPolicy(candidate) || (extraLocal?.(candidate) ?? false);
  const submitted = url.href;
  if (local(url)) return { target: url, submitted };

  const allowed = (candidate: URL): boolean => local(candidate) || isLiteralSafe(candidate);
  const resolved = await issued.resolvedFor(submitted);
  if (resolved !== undefined) {
    const target = new URL(resolved);
    if (allowed(target)) return { target, submitted };
  }
  if ((await issued.has(submitted)) && allowed(url)) return { target: url, submitted };
  return null;
}
