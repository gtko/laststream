/* Domaines des débrideurs que l'appareil peut contacter (mêmes que la liste de la coque Windows) : API et fichiers des débrideurs.
 * Module sans effet de bord, pour que l'affichage des sources puisse reconnaître un lien débridé sans charger le transport. */

const EXACT_HOSTS = ['api.alldebrid.com', 'api.torbox.app'];
const SUFFIXES = ['.debrid.it', '.alldebrid.com', '.torbox.app', '.real-debrid.com'];

export function debridHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return false;
  return EXACT_HOSTS.includes(host) || SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** URL https d'un domaine de débrideur, sans identifiants ni port atypique ; sinon null. */
export function parseDebridUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  return debridHostAllowed(url.hostname) ? url : null;
}
