import type { AutoDetectOptions } from './lt/detect/index.js';
import type { ThumbOptions } from './lt/thumbs/index.js';
import type { CacheAdmin, MetaAdmin, TvAdmin } from './admin/cache-types.js';
import type { OpsPorts } from './admin/ops-stats.js';
import type { MetricsService } from './metrics/core.js';
import type { PartyBackend, UiAssets, UserBackend } from './platform/index.js';
import type { MetaBlobStore } from './lt/meta.js';
import type { QuotaGate } from './lt/quota.js';
import type { RowBlobStore } from './lt/rows.js';
import type { SharedLimits } from './rate-limit-shared.js';
import type { SocialEventHandler } from './user/social-v2-events.js';

/** Dépendances injectées dans l'application. Ne jamais logger ces valeurs. */
export interface AppDeps {
  /** Clé de chiffrement des configurations. */
  secret: string;
  /** Accepter les configurations en JSON brut (non chiffré). */
  allowPlain: boolean;
  /** fetch injecté pour les requêtes sortantes (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
  /** Résolution DNS injectée pour les gardes d'URL lt (tests). Par défaut : résolution système. */
  lookupHost?: (hostname: string) => Promise<readonly string[]>;
  /** Base SQLite des données utilisateur (':memory:' pour les tests). Par défaut : LASTADDON_DATA_DIR/laststream.db. */
  userDbPath?: string;
  /** Dépôts de données utilisateur et de segments de saut. Par défaut : ceux de la plateforme (createUserBackend). */
  userBackend?: UserBackend;
  /** Salons de visionnage (Workers : Durable Objects). Par défaut : celui de la plateforme ; absent, /party répond 501. */
  party?: PartyBackend;
  /** Métriques d'exploitation (tests). Par défaut : celles de la plateforme. */
  metrics?: MetricsService;
  /** Statistiques et purge des caches KV (tests). Par défaut : celles de la plateforme (Workers). */
  cacheAdmin?: CacheAdmin;
  /** Suppression d'une fiche partagée (tests ; Workers : R2 par la plateforme). Absente : 501. */
  metaAdmin?: MetaAdmin;
  /** Limites /admin/* par minute et par IP (lectures, écritures, ré-authentifications par 10 min). */
  adminRateLimits?: Partial<{ read: number; write: number; elevate: number }>;
  /** API TV d'administration (dernier cron, relance). Absente : les routes /admin/tv répondent 501. */
  tvAdmin?: TvAdmin;
  /** Ports d'exploitation (Workers : buckets R2 en lecture, base SQLite du Durable Object). Absents : stockage « indisponible » (null). */
  ops?: OpsPorts;
  /** Limites /user/* par minute : lectures et écritures par IP, routes sensibles par IP, et /login par nom d'utilisateur ; authPerIp : tentatives /login et /register par IP sur 15 minutes. */
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number; authPerIp: number }>;
  /**
   * Événements sociaux temps réel (demandes, amitiés, présence visible), émis après chaque changement. Absent : aucun effet.
   * Le lot WebSocket s'y branche ; une exception du gestionnaire n'interrompt jamais la requête.
   */
  socialEvents?: SocialEventHandler;
  /**
   * Limiteur de connexion et d'inscription partagé entre instances (Workers : binding Rate Limiting). Remplace les compteurs
   * en mémoire de /user/login et /user/register. `true` = tentative autorisée.
   */
  authLimiter?: { byIp(ip: string): Promise<boolean>; byUsername(username: string): Promise<boolean>; retryAfterSec: number };
  /**
   * Liaisons de limite de débit partagées entre instances (Workers : Rate Limiting, voir rate-limit-shared.ts) pour les routes
   * sensibles : /config, /lt, /user, /admin, /party, tickets live, frappe. S'ajoutent à la Map locale, qui reste le repli
   * (liaison absente : tests, Node, dev).
   */
  sharedLimits?: SharedLimits;
  /** Détection automatique des segments de saut (binaires ffmpeg, URL locales autorisées, budget) : réglages de test. */
  skipDetect?: AutoDetectOptions;
  /** Miniatures de la barre (ffmpeg, cache, origines locales autorisées en plus) : réglages de test. */
  thumbs?: ThumbOptions;
  /** Stockage des fiches partagées (tests ; Workers : R2 par la plateforme). Absent : fiches construites à chaque demande. */
  metaBlobs?: MetaBlobStore;
  /** Stockage des rangées d'accueil communes (tests ; Workers : R2 par la plateforme). Absent : rangées calculées à la demande. */
  rowBlobs?: RowBlobStore;
  /** Limite de débit globale des appels sortants vers MDBList (binding partagé sous Workers). Absent : compteur en mémoire. */
  mdblistLimiter?: () => Promise<boolean>;
  /** Budget quotidien global des appels MDBList (garde partagée sous Workers : Durable Object). Absente : compteur en mémoire. */
  mdblistQuota?: QuotaGate;
  /** Nombre maximal d'appels MDBList par jour UTC (tests). Absent : MDBLIST_DAILY_BUDGET, sinon 800. */
  mdblistDailyBudget?: number;
  /** Dossier de l'interface web servie à la racine (LASTADDON_UI_DIR ou --ui). Absent : pas d'interface. */
  uiDir?: string;
  /** Fichiers de l'interface web (binding Assets sous Workers). Prime sur `uiDir`. */
  ui?: UiAssets;
  /** Origines ajoutées au CORS quand l'interface est servie par ce serveur (même site). */
  uiOrigins?: readonly string[];
  /** Origine du serveur de streaming relayé sous /_ss (LASTADDON_STREAMING_SERVER). Par défaut : la variable, ou 127.0.0.1:11470. */
  streamingServer?: string;
}
