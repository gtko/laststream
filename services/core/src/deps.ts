import type { AllDebridClient } from './sources/alldebrid.js';
import type { AutoDetectOptions } from './lt/detect/index.js';
import type { ThumbOptions } from './lt/thumbs/index.js';
import type { LocalProwlarrProvider } from './sources/local-prowlarr.js';

/** Méthodes du client AllDebrid utilisées par les routes : résolution (magnet et fichier .torrent), appel brut, contrôles. */
export type DebridClient = Pick<
  AllDebridClient,
  'resolve' | 'resolveTorrentFile' | 'call' | 'checkCached' | 'checkApiKey'
>;

/** Dépendances injectées dans l'application. Ne jamais logger ces valeurs. */
export interface AppDeps {
  /** Clé de chiffrement des configurations. */
  secret: string;
  /** Accepter les configurations en JSON brut (non chiffré). */
  allowPlain: boolean;
  /** Fabrique du client debrid (tests, injection). Par défaut : AllDebridClient réel. */
  alldebridFactory?: (apiKey: string) => DebridClient;
  /** fetch injecté pour le client AllDebrid réel (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
  /** Résolution DNS injectée pour les gardes d'URL lt (tests). Par défaut : résolution système. */
  lookupHost?: (hostname: string) => Promise<readonly string[]>;
  /** Base SQLite des données utilisateur (':memory:' pour les tests). Par défaut : LASTADDON_DATA_DIR/laststream.db. */
  userDbPath?: string;
  /** Limites /user/* par minute : lectures et écritures par IP, routes sensibles par IP, et /login par nom d'utilisateur ; authPerIp : tentatives /login et /register par IP sur 15 minutes. */
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number; authPerIp: number }>;
  /**
   * Prowlarr local détecté (absent : aucun, ce qui désactive la détection). Le serveur l'initialise au démarrage.
   * Sa clé ne doit jamais sortir vers les clients ni dans les journaux.
   */
  localProwlarr?: LocalProwlarrProvider;
  /** Détection automatique des segments de saut (binaires ffmpeg, URL locales autorisées, budget) : réglages de test. */
  skipDetect?: AutoDetectOptions;
  /** Miniatures de la barre (ffmpeg, cache, origines locales autorisées en plus) : réglages de test. */
  thumbs?: ThumbOptions;
  /** Dossier de l'interface web servie à la racine (LASTADDON_UI_DIR ou --ui). Absent : pas d'interface. */
  uiDir?: string;
  /** Origines ajoutées au CORS quand l'interface est servie par ce serveur (même site). */
  uiOrigins?: readonly string[];
  /** Origine du serveur de streaming relayé sous /_ss (LASTADDON_STREAMING_SERVER). Par défaut : la variable, ou 127.0.0.1:11470. */
  streamingServer?: string;
}
