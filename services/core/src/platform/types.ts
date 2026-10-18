/**
 * Couche plateforme : tout ce qui dépend de l'environnement d'exécution (Node sur un PC, Cloudflare Workers) passe
 * par ces interfaces. Le code applicatif ne lit jamais `process.env` et n'importe jamais `undici` : il demande la
 * plateforme active (voir `platform()` dans ./index.ts). Les implémentations vivent dans ./node (et, plus tard, ./workers).
 */

import type { AutoDetectOptions, AutoDetector } from '../lt/detect/index.js';
import type { ThumbOptions, ThumbService } from '../lt/thumbs/index.js';
import type { CacheAdmin } from '../admin/cache-types.js';
import type { MetricsService } from '../metrics/core.js';
import type { PartyBackend } from '../party/backend.js';
import type { SkipRepo, UserBackend } from '../user/repo.js';

export type { UserBackend } from '../user/repo.js';
export type { PartyBackend } from '../party/backend.js';

/** Variables d'environnement vues comme un simple dictionnaire (valeurs non définies = absentes). */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Lecture des variables d'exécution (Node : process.env ; Workers : bindings `env`). Lue à la demande, jamais figée. */
export interface RuntimeEnv {
  /** Valeur brute d'une variable, ou undefined si elle est absente. */
  get(name: string): string | undefined;
  /** Dictionnaire complet (PATH, HOME…) pour les sondes d'outils locaux. */
  all(): EnvLike;
  /** Écrit une variable (options de ligne de commande, chargement du .env). Absent quand l'environnement est en lecture seule. */
  set?(name: string, value: string): void;
}

/** Cache clé-valeur avec expiration (Node : mémoire ; Workers : KV). Les valeurs sont des chaînes. */
export interface KvCache {
  get(key: string): Promise<string | undefined>;
  /** `ttlSeconds` : durée de vie ; absent = jusqu'à éviction. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Hôte → adresses IP (toutes), pour les gardes d'URL et l'épinglage DNS. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

/**
 * Politique de connexion opaque transmise à `fetch` (Node : agent undici au DNS épinglé). Les implémentations qui n'ont
 * pas de contrôle de connexion (Workers) peuvent renvoyer `undefined` et compter sur la validation d'URL.
 */
export type OutboundDispatcher = object;

/** Réponse brute d'une requête relayée en flux (statut, en-têtes, corps itérable). */
export interface RawResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Abandonne le corps sans le lire. */
  dump(): Promise<void>;
}

/** Options d'une requête relayée en flux. */
export interface StreamRequestOptions {
  method: 'GET' | 'HEAD';
  headers: Readonly<Record<string, string>>;
  /** Connexion libre (adresses locales autorisées) au lieu de l'agent au DNS épinglé. */
  allowLocal: boolean;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}

/** Client HTTP sortant. */
export interface HttpClient {
  /** fetch par défaut de la plateforme. */
  readonly fetch: typeof fetch;
  /** Résolution DNS réelle d'un hôte (toutes les adresses). */
  resolveHost: HostLookup;
  /**
   * Connexion dont le DNS est résolu et contrôlé une seule fois (adresses publiques exigées) : un rebinding entre le
   * contrôle et la connexion est impossible. `lookup` remplace la résolution système (tests).
   */
  pinnedDispatcher(lookup?: HostLookup): OutboundDispatcher | undefined;
  /** Requête relayée en flux (relais de sources pour ffmpeg). Absent quand la plateforme ne peut pas relayer. */
  stream?(url: URL, options: StreamRequestOptions): Promise<RawResponse>;
}

/** Planification de tâches différées. */
export interface Scheduler {
  /** Exécute `task` après `delayMs`. Renvoie une fonction d'annulation. */
  after(delayMs: number, task: () => void | Promise<void>): () => void;
  /** Exécute `task` toutes les `intervalMs`. Renvoie une fonction d'annulation. */
  every(intervalMs: number, task: () => void | Promise<void>): () => void;
  /** Garde en vie un travail d'arrière-plan après la réponse (Node : rien à faire ; Workers : ctx.waitUntil). */
  background(work: Promise<unknown>): void;
}

/** Service de miniatures utilisé par les routes lt. */
export type ThumbPort = Pick<ThumbService, 'enabled' | 'register' | 'frame' | 'close'>;

/** Services ffmpeg locaux, injectés par la plateforme pour que le code Worker n'importe ni child_process ni fs. */
export interface LocalMedia {
  /** Service de miniatures de la barre de lecture. */
  createThumbs(options: ThumbOptions | undefined): ThumbPort;
  /** Détecteur automatique des segments de saut. */
  createDetector(openSkips: () => SkipRepo, options: AutoDetectOptions): AutoDetector;
}

/** Fonctions disponibles selon la plateforme. */
export interface Capabilities {
  /** Miniatures de la barre de lecture par ffmpeg. */
  thumbs: boolean;
  /** Détection automatique des segments de saut (ffmpeg, empreinte audio). */
  skipDetect: boolean;
  /** Proxy HLS des chaînes TV. */
  tvHls: boolean;
  /** Miniatures décodées côté client (WebCodecs) via le relais de plages Cloudflare (jeton HMAC émis par ce serveur). */
  rangeThumbs: boolean;
  /**
   * Les instances ne partagent pas leur mémoire (Workers : un isolat par région, éphémère) : les états qui doivent
   * survivre à une instance (statuts AllDebrid, packs, URL émises, torrents privés) passent par un `KvCache` partagé.
   */
  sharedState: boolean;
}

/** Fichiers de l'interface web servis à la racine (Node : dossier ; Workers : binding Assets). */
export interface UiAssets {
  /**
   * Réponse pour le chemin demandé (`/index.html`, `/assets/app.js`…), ou null si le fichier n'existe pas.
   * `request` porte les en-têtes conditionnels (If-None-Match, Range…). Les en-têtes de cache propres à l'application
   * sont ajoutés par l'appelant.
   */
  serve(request: Request, pathname: string): Promise<Response | null>;
}

/** Ensemble des services de plateforme. */
export interface Platform {
  readonly env: RuntimeEnv;
  readonly http: HttpClient;
  readonly scheduler: Scheduler;
  readonly capabilities: Capabilities;
  /** Fabrique un cache nommé. */
  createKvCache(namespace: string): KvCache;
  /**
   * Dépôts de données utilisateur et de segments de saut (Node : SQLite local, `path` ou LASTADDON_DATA_DIR ;
   * Workers : Durable Object SQLite).
   */
  createUserBackend(options?: { path?: string }): UserBackend;
  /** Métriques d'exploitation (mémoire sous Node, Durable Object sous Workers). Absent : aucune mesure. */
  readonly metrics?: MetricsService;
  /** Statistiques et purge des caches KV partagés (Workers seulement) ; absent : les routes /admin/caches répondent 501. */
  readonly cacheAdmin?: CacheAdmin;
  /** Salons de visionnage en temps réel (Workers : Durable Object PartyRoom). Absent sur Node : les routes /party répondent 501. */
  createPartyBackend?(): PartyBackend;
  /**
   * Services locaux liés à la machine (ffmpeg : miniatures, détection des segments de saut). Absent sur Workers, où
   * les capacités `thumbs` et `skipDetect` sont fausses.
   */
  localMedia?: LocalMedia;
  /** Interface web lue dans un dossier (Node). Absent sur Workers, où elle vient d'un binding Assets. */
  uiAssetsFromDir?(dir: string): UiAssets;
  /** Interface web fournie par la plateforme elle-même (Workers Assets). */
  uiAssets?: UiAssets;
}
