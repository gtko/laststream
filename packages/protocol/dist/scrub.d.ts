/**
 * Épuration d'URL commune au serveur (Sentry du Worker) et à l'application (Sentry navigateur) : réduction de l'hôte,
 * liste des hôtes conservés, masquage des segments de chemin qui portent une configuration d'addon.
 * Les placeholders propres à chaque côté ([redacted] / [retiré]) restent dans chaque dépôt.
 */
/** Au-delà de cette longueur, un segment de chemin est une configuration (base64url, JSON…) : jamais envoyé. */
export declare const MAX_SEGMENT = 40;
export declare const CONFIG_PLACEHOLDER = "[config]";
/** Hôtes gardés (origine seule) hors de l'application : métadonnées, visuels, sous-titres et listes de notes. */
export declare const HOST_ALLOWLIST: ReadonlySet<string>;
/** Les workers.dev du projet (compte gtux-prog) sont gardés en origine seule. */
export declare const PROJECT_WORKERS_DEV: RegExp;
/** Segment de chemin portant une configuration d'addon. */
export declare const isConfigSegment: (segment: string) => boolean;
/** Chemin dont les segments de configuration sont remplacés par `[config]`. */
export declare function scrubPath(path: string): string;
/** Adresse littérale IPv4 ou IPv6 (le nom d'hôte d'une URL IPv6 est entre crochets). */
export declare const isIpLiteral: (host: string) => boolean;
/** localhost et les noms *.local (réseau local). */
export declare const isLocalName: (host: string) => boolean;
/**
 * Hors de l'application : `[ip]` pour une adresse littérale, `[host]` pour un nom local ou inconnu, sinon
 * `protocole//hôte[:port]` si l'hôte est autorisé. Accepte une `URL` (ou tout objet de même forme).
 */
export declare function reduceHost(url: {
    hostname: string;
    protocol: string;
    host: string;
}): string;
