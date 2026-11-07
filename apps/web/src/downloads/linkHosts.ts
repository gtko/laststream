/* Hôtes autorisés pour les liens HTTP donnés par les addons (ODY-204) : https uniquement, nom de domaine public.
 * Un lien d'addon peut pointer vers le réseau local (NAS, box) ou vers l'appareil lui-même : `fetch` le contacterait depuis
 * l'appareil de l'utilisateur. Ce prédicat refuse donc les littéraux IP, localhost, les noms locaux et les hôtes sans point. */

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = ['.local', '.internal', '.localhost'];

/** Vrai si `url` est un lien https vers un nom de domaine public. Le transport refuse tout le reste (voir webHttp.ts). */
export function isAddonLinkUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  // Un point final (« localhost. ») désigne le même hôte.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return false;
  // IPv6 littérale (`[::1]`) : le nom d'hôte contient deux-points ou crochets.
  if (host.startsWith('[') || host.includes(':')) return false;
  if (IPV4.test(host)) return false;
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // Sans point, c'est un nom local (NAS, machine du réseau).
  return host.includes('.');
}

/**
 * Lien accepté par le transfert natif (Android, coque avec transfert, ODY-232) : les règles ci-dessus, sans identifiants dans l'URL
 * et sur le port https par défaut seulement. Le transfert natif n'a pas le garde-fou du navigateur (CORS, réseau privé) : un lien d'addon
 * ne doit pas faire lire un service du réseau local ou un port inattendu. Le code natif réapplique ces règles à chaque redirection
 * (DownloadLogic.kt) et refuse les noms qui se résolvent vers une adresse privée.
 */
export function isNativeLinkUrl(url: URL): boolean {
  if (!isAddonLinkUrl(url)) return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.port === '' || url.port === '443';
}
