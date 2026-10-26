/**
 * Épuration d'URL commune au serveur (Sentry du Worker) et à l'application (Sentry navigateur) : réduction de l'hôte,
 * liste des hôtes conservés, masquage des segments de chemin qui portent une configuration d'addon.
 * Les placeholders et l'origine propres à chaque côté ([redacted] / [retiré]) se passent en options.
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
/** Libellés de remplacement. Par défaut ceux du Worker (anglais) ; l'application passe les siens. */
export interface ScrubPlaceholders {
    /** Valeur secrète (clé d'API, jeton, mot de passe, en-tête Bearer). */
    redacted: string;
    /** Segment de chemin portant une configuration d'addon. */
    config: string;
    /** URL d'un débrideur. */
    debridUrl: string;
    /** URL `magnet:` isolée (valeur d'une URL). */
    magnetUrl: string;
    /** Lien magnet rencontré dans un texte libre. */
    magnetText: string;
    /** URL supprimée pour une autre raison (flux complet .m3u8/.mkv/.mp4, schéma non web, valeur illisible). */
    removedUrl: string;
}
export declare const DEFAULT_PLACEHOLDERS: Readonly<ScrubPlaceholders>;
export interface ScrubOptions {
    /** Origine du consommateur (application ou Worker) : ses propres URL gardent leur chemin épuré. Absente : aucune. */
    origin?: string;
    /**
     * Résout une adresse relative sur `origin` (application). Sinon : un chemin relatif est épuré tel quel (Worker).
     * Sans `origin`, un chemin relatif est épuré (et non rejeté).
     */
    resolveRelative?: boolean;
    /** Fragment d'une URL de l'origine (route `#/…`) : retourne la forme à garder. Absent : le fragment est retiré. */
    hash?: (hash: string) => string;
    placeholders?: Partial<ScrubPlaceholders>;
}
/** Forme sûre d'une URL, ou `null` si elle ne doit jamais être envoyée (débrideur, magnet, flux complet, schéma non web). */
export declare function tryScrubUrl(raw: string, options?: ScrubOptions): string | null;
/** Forme sûre d'une URL ; un placeholder remplace ce qui ne doit jamais sortir (débrideur, magnet, flux, schéma). */
export declare function scrubUrl(raw: string, options?: ScrubOptions): string;
/** Texte libre : URL réécrites, magnets retirés, clés de débrideur, d'API, jetons et mots de passe masqués, segments de configuration masqués. */
export declare function scrubText(text: string, options?: ScrubOptions): string;
