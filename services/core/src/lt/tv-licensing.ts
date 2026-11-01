import { isIP } from 'node:net';

/**
 * Filtre « officiel ou licencié » des flux de la TV en direct (LAST-1411). Garde heuristique, appliquée à l'admission
 * des flux iptv-org et Free-TV, en plus de la garde littérale (guard.ts). Refuse les URL qui ressemblent à des relais de
 * comptes IPTV revendus ou piratés : hôte en adresse IP brute, identifiants dans l'URL (utilisateur:mot de passe@, paramètres
 * de requête de compte), chemins du schéma Xtream Codes. Pluto TV et Samsung TV Plus (FAST, sous licence) n'y passent pas.
 */

/** Paramètres de requête qui portent un identifiant de compte (comparés en minuscules). */
const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set(['u', 'p', 'user', 'username', 'pass', 'password', 'token', 'key']);

/** Schéma Xtream Codes : /live/<utilisateur>/<mot de passe>/<identifiant numérique>[.ts | .m3u8]. */
const XTREAM_LIVE = /^\/live\/[^/]+\/[^/]+\/\d+(\.[a-z0-9]+)?$/i;

/** Schéma « /<alnum>/<alnum>/<chiffres> » servi sur un port non standard, typique des serveurs IPTV revendus. */
const RESELLER_PATH = /^\/[a-z0-9]+\/[a-z0-9]+\/\d+\/?$/i;

/**
 * Vrai si l'URL ne porte pas les marques d'un relais de compte IPTV. Une URL non parsable est refusée. Le port : `URL`
 * retire les ports par défaut (80 pour http, 443 pour https), donc un `port` non vide est non standard.
 */
export function isOfficialStreamUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Adresse IP brute (IPv6 entre crochets dans `hostname`) : aucun nom de domaine, donc aucun éditeur identifiable.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return false;
  if (url.username !== '' || url.password !== '') return false;
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_PARAMS.has(name.toLowerCase())) return false;
  }
  if (XTREAM_LIVE.test(url.pathname)) return false;
  if (url.port !== '' && RESELLER_PATH.test(url.pathname)) return false;
  return true;
}
