import type { AllDebridClient } from './sources/alldebrid.js';

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
  /** Limites /user/* par minute : lectures et écritures par IP, routes sensibles par IP, et /login par nom d'utilisateur. */
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number }>;
}
