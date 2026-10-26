/**
 * Épuration d'URL commune au serveur (Sentry du Worker) et à l'application (Sentry navigateur) : réduction de l'hôte,
 * liste des hôtes conservés, masquage des segments de chemin qui portent une configuration d'addon.
 * Les placeholders et l'origine propres à chaque côté ([redacted] / [retiré]) se passent en options.
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
export const DEFAULT_PLACEHOLDERS = {
    redacted: '[redacted]',
    config: CONFIG_PLACEHOLDER,
    debridUrl: '[debrid-url]',
    magnetUrl: '[magnet]',
    magnetText: '[magnet]',
    removedUrl: '[redacted]',
};
const DEBRID = /alldebrid|real-?debrid|torbox|premiumize/i;
const MEDIA_FILE = /\.(m3u8|mkv|mp4)$/i;
const MAGNET_SCHEME = /^magnet:/i;
/** Magnet en texte libre, jusqu'au premier espace ou guillemet. */
const MAGNET_IN_TEXT = /magnet:[^\s"'<>]*/gi;
/** URL (et stremio:) jusqu'au premier espace ou guillemet : une clé après « | » ne doit pas fuir. */
const URL_IN_TEXT = /(?:(?:https?|wss?):\/\/|stremio:)[^\s"'<>]+/gi;
/** Jeton d'invité d'un salon en paramètre court (`?t=` / `&t=`) dans un texte libre hors URL absolue. */
const SHORT_TOKEN_PARAM = /([?&])t=[^&\s"'<>;,]*/g;
/** Clés de débrideur en texte libre (hors d'une URL) : valeur masquée jusqu'au séparateur (&, /, |, espace). */
const DEBRID_PARAM = /\b((?:all|real)-?debrid\w*|torbox|premiumize|debridoptions)(\s*=\s*)[^\s&"',;}|/]+/gi;
const BEARER = /\bBearer\s+[^\s"'<>,;]+/gi;
const LONG_SEGMENT_IN_TEXT = new RegExp(`/[^\\s/]{${MAX_SEGMENT + 1},}`, 'g');
/** apikey / api_key / access_token / token / password / secret… en `clé=valeur`, `clé: valeur` ou JSON. */
const SECRET = /(["']?(?:api[_-]?key|access[_-]?token|token|password|passwd|secret)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi;
const DROP_DEBRID = { dropped: 'debrid' };
const DROP_MAGNET = { dropped: 'magnet' };
const DROP_OTHER = { dropped: 'other' };
const placeholdersOf = (options) => ({ ...DEFAULT_PLACEHOLDERS, ...options.placeholders });
function scrubUrlCore(raw, options) {
    const value = raw.trim();
    if (!value)
        return DROP_OTHER;
    if (DEBRID.test(value))
        return DROP_DEBRID;
    if (MAGNET_SCHEME.test(value))
        return DROP_MAGNET;
    let url;
    try {
        // « //hôte/chemin » (relative au schéma) est lue comme une URL https quand rien ne la résout.
        url = options.resolveRelative && options.origin
            ? new URL(value, options.origin)
            : new URL(value.startsWith('//') ? `https:${value}` : value);
    }
    catch {
        // Chemin relatif sans base : on coupe la requête et le fragment. Toute autre valeur illisible est supprimée.
        const path = value.startsWith('/') ? (value.split(/[?#]/, 1)[0] ?? '') : '';
        return path && !MEDIA_FILE.test(path) ? scrubPath(path) : DROP_OTHER;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'stremio:')
        return DROP_OTHER;
    if (MEDIA_FILE.test(url.pathname))
        return DROP_OTHER;
    const host = url.hostname.toLowerCase();
    // Le consommateur lui-même (hors adresse locale) : chemin épuré. Toute autre origine : hôte seul, s'il est autorisé.
    if (options.origin && url.origin === options.origin && !isIpLiteral(host) && !isLocalName(host)) {
        return `${url.origin}${scrubPath(url.pathname)}${options.hash ? options.hash(url.hash) : ''}`;
    }
    return reduceHost(url);
}
/** Forme sûre d'une URL, ou `null` si elle ne doit jamais être envoyée (débrideur, magnet, flux complet, schéma non web). */
export function tryScrubUrl(raw, options = {}) {
    const result = scrubUrlCore(raw, options);
    return typeof result === 'string' ? result : null;
}
/** Forme sûre d'une URL ; un placeholder remplace ce qui ne doit jamais sortir (débrideur, magnet, flux, schéma). */
export function scrubUrl(raw, options = {}) {
    const result = scrubUrlCore(raw, options);
    if (typeof result === 'string')
        return result;
    const placeholders = placeholdersOf(options);
    if (result === DROP_DEBRID)
        return placeholders.debridUrl;
    return result === DROP_MAGNET ? placeholders.magnetUrl : placeholders.removedUrl;
}
/** Texte libre : URL réécrites, magnets retirés, clés de débrideur, d'API, jetons et mots de passe masqués, segments de configuration masqués. */
export function scrubText(text, options = {}) {
    const placeholders = placeholdersOf(options);
    return text
        .replace(MAGNET_IN_TEXT, () => placeholders.magnetText)
        .replace(URL_IN_TEXT, (match) => {
        const trailing = /[.,;:!?)\]}]*$/.exec(match)?.[0] ?? '';
        const core = match.slice(0, match.length - trailing.length);
        return scrubUrl(core, options) + trailing;
    })
        .replace(SHORT_TOKEN_PARAM, (_match, sep) => `${sep}t=${placeholders.redacted}`)
        .replace(DEBRID_PARAM, (_match, name, eq) => `${name}${eq}${placeholders.redacted}`)
        .replace(BEARER, () => `Bearer ${placeholders.redacted}`)
        .replace(LONG_SEGMENT_IN_TEXT, () => `/${placeholders.config}`)
        .replace(SECRET, (_match, prefix) => `${prefix}${placeholders.redacted}`);
}
