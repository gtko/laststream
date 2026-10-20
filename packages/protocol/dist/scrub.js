/**
 * Épuration d'URL commune au serveur (Sentry du Worker) et à l'application (Sentry navigateur) : réduction de l'hôte,
 * liste des hôtes conservés, masquage des segments de chemin qui portent une configuration d'addon.
 * Les placeholders propres à chaque côté ([redacted] / [retiré]) restent dans chaque dépôt.
 */
/** Au-delà de cette longueur, un segment de chemin est une configuration (base64url, JSON…) : jamais envoyé. */
export const MAX_SEGMENT = 40;
export const CONFIG_PLACEHOLDER = '[config]';
/** Hôtes gardés (origine seule) hors de l'application : métadonnées, visuels, sous-titres et listes de notes. */
export const HOST_ALLOWLIST = new Set([
    'api.themoviedb.org',
    'image.tmdb.org',
    'api4.thetvdb.com',
    'api.mdblist.com',
    'v3-cinemeta.strem.io',
]);
/** Les workers.dev du projet (compte gtux-prog) sont gardés en origine seule. */
export const PROJECT_WORKERS_DEV = /\.gtux-prog\.workers\.dev$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Segment de chemin portant une configuration d'addon. */
export const isConfigSegment = (segment) => segment.length > MAX_SEGMENT;
/** Chemin dont les segments de configuration sont remplacés par `[config]`. */
export function scrubPath(path) {
    return path
        .split('/')
        .map((segment) => (isConfigSegment(segment) ? CONFIG_PLACEHOLDER : segment))
        .join('/');
}
/** Adresse littérale IPv4 ou IPv6 (le nom d'hôte d'une URL IPv6 est entre crochets). */
export const isIpLiteral = (host) => IPV4.test(host) || host.startsWith('[');
/** localhost et les noms *.local (réseau local). */
export const isLocalName = (host) => host === 'localhost' || host.endsWith('.local');
/**
 * Hors de l'application : `[ip]` pour une adresse littérale, `[host]` pour un nom local ou inconnu, sinon
 * `protocole//hôte[:port]` si l'hôte est autorisé. Accepte une `URL` (ou tout objet de même forme).
 */
export function reduceHost(url) {
    const host = url.hostname.toLowerCase();
    if (isIpLiteral(host))
        return '[ip]';
    if (!host || isLocalName(host))
        return '[host]';
    if (HOST_ALLOWLIST.has(host) || PROJECT_WORKERS_DEV.test(host))
        return `${url.protocol}//${url.host}`;
    return '[host]';
}
