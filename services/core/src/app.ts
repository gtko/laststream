import type { MiddlewareHandler } from 'hono';
import { ConfigDecodeError, decodeConfig, encodeConfig } from './config/codec.js';
import { withServerServices } from './config/server-services.js';
import { presetCatalog } from './config/presets.js';
import { ConfigValidationError, configJsonSchema } from './config/schema.js';
import { edgeTrust } from './config/edge.js';
import { allowedOrigins, configuredStreamingServer, isTrustProxy, legacyIndexersEnabled } from './config/runtime-env.js';
import { maskConfig, mergeSecrets } from './config/secrets.js';
import type { AppDeps } from './deps.js';
import { type App, type AppEnv, type Ctx, newApp } from './http/app-env.js';
import { clientAddress } from './http/client-ip.js';
import { errorHandler, etag, notFound } from './http/common.js';
import { DEFAULT_JSON_LIMIT, jsonBody } from './http/json-body.js';
import { sendJson } from './http/respond.js';
import { catalogEntries } from './lt/catalog.js';
import { closeLtRoutes, registerLtRoutes } from './lt/router.js';
import { platform, runtimeEnv } from './platform/index.js';
import { localProwlarrStatusOf } from './sources/local-prowlarr.js';
import { registerIndexerRoutes } from './routes/indexers.js';
import { registerPlayRoutes } from './routes/play.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerTestRoutes } from './routes/test.js';
import { registerPartyRoutes } from './party/routes.js';
import { registerUserRoutes } from './user/routes.js';
import { registerAdminRoutes } from './admin/api.js';
import { createMaintenanceGate, maintenanceMiddleware } from './admin/maintenance.js';
import { metricsMiddleware } from './metrics/middleware.js';
import { installCacheCounters } from './metrics/index.js';
import { registerStreamingProxy } from './streaming-proxy.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerUiRoutes } from './ui.js';
import { createRateLimiter } from './rate-limit.js';
import { isRecord } from './sources/http.js';

export { createRateLimiter };

export const MANIFEST = {
  id: 'com.laststream.lastaddon',
  version: '0.1.0',
  name: 'lastAddon',
  description: 'Agrégateur de streams (upstreams et Torznab) pour Laststream',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
} as const;

/** Routes publiques lues par Stremio : CORS ouvert (`*`). */
const OPEN_CORS_PATHS: readonly RegExp[] = [
  // Sonde de disponibilité : lue depuis les apps (Capacitor, autre origine) avant toute connexion ; aucune donnée.
  /^\/health$/,
  /^\/manifest\.json$/,
  /^\/[^/]+\/manifest\.json$/,
  /^\/[^/]+\/stream\/[^/]+\/[^/]+$/,
];
/** Avatars par collections (/avatars/*) : lecture publique en GET, sans limite de débit (une grille charge beaucoup d'images). */
const OPEN_AVATAR_PATH = /^\/avatars\/.+$/;
/** Endpoints de configuration (/config/*) : origines restreintes et limite de débit. */
const CONFIG_PATH = /^\/config(?:\/|$)/;
/** Routes lt et catalogues (proxys publics par configuration) : GET ouvert à toute origine. */
const OPEN_LT_PATHS: readonly RegExp[] = [/^\/[^/]+\/lt\/.+$/, /^\/[^/]+\/catalog\/.+$/];
/** Routes lt en POST : origines restreintes et limite de débit, comme /config/*. */
const LT_WRITE_PATH = /^\/[^/]+\/lt(?:\/|$)/;
/** Données utilisateur (/user/*) : origines restreintes, limite de débit comme /config/*, jamais en cache. */
const USER_PATH = /^\/user(?:\/|$)/;
/** Salons de visionnage (/party/*) : mêmes règles d'origine et d'en-têtes que /user. */
const PARTY_PATH = /^\/party(?:\/|$)/;
/** Administration (/admin/*) : propriétaire seulement, mêmes règles d'origine que /user. */
const ADMIN_PATH = /^\/admin(?:\/|$)/;
const USER_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const USER_HEADERS = 'Content-Type, Authorization, X-Profile-Token, X-Bootstrap-Token, X-Profile-Id, X-Admin-Elevation';

/** Routes ouvertes : manifest, stream, lt et catalogues en GET (préflight GET inclus). */
function isOpenPath(c: Ctx): boolean {
  const path = c.req.path;
  if (OPEN_CORS_PATHS.some((pattern) => pattern.test(path))) return true;
  if (!OPEN_LT_PATHS.some((pattern) => pattern.test(path)) && !OPEN_AVATAR_PATH.test(path)) return false;
  if (c.req.method === 'GET') return true;
  return c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') === 'GET';
}
const CONFIG_RATE_LIMIT = 30;
const CONFIG_RATE_WINDOW_MS = 60_000;
/**
 * GET lt et catalogues, par minute et par IP. Une page d'accueil longue charge des centaines de fiches
 * (servies depuis le cache partagé) : 1200 par défaut, réglable par LASTADDON_READ_RATE_LIMIT.
 */
const readRateLimit = (): number => {
  const configured = Number(runtimeEnv().get('LASTADDON_READ_RATE_LIMIT'));
  return configured > 0 ? configured : 1200;
};
const READ_RATE_WINDOW_MS = 60_000;

/**
 * CORS : `*` uniquement sur les routes manifest et stream (GET). Sur /config/*, seule une origine
 * présente dans `origins` reçoit Access-Control-Allow-Origin. Les autres routes n'ont pas d'en-tête CORS.
 */
function corsMiddleware(origins: readonly string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (isOpenPath(c)) {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
    } else if (CONFIG_PATH.test(path) || LT_WRITE_PATH.test(path) || USER_PATH.test(path) || PARTY_PATH.test(path) || ADMIN_PATH.test(path)) {
      const origin = c.req.header('origin');
      c.header('Vary', 'Origin', { append: true });
      if (origin !== undefined && origins.includes(origin)) {
        c.header('Access-Control-Allow-Origin', origin);
        if (USER_PATH.test(path) || PARTY_PATH.test(path) || ADMIN_PATH.test(path)) {
          c.header('Access-Control-Allow-Methods', USER_METHODS);
          c.header('Access-Control-Allow-Headers', USER_HEADERS);
        } else {
          c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          c.header('Access-Control-Allow-Headers', 'Content-Type');
        }
      }
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  };
}

/** Limite les requêtes qui satisfont `applies` à CONFIG_RATE_LIMIT par minute et par IP (préflights OPTIONS exclus). */
function rateLimit(applies: (c: Ctx) => boolean, limiter: ReturnType<typeof createRateLimiter>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!applies(c) || c.req.method === 'OPTIONS') {
      await next();
      return;
    }
    const verdict = limiter(c.get('ip') ?? 'inconnu');
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfterSec));
      c.header('Cache-Control', 'no-store');
      return sendJson(c, { error: 'rate_limited' }, 429);
    }
    await next();
  };
}

/**
 * Manifest d'une configuration. Les catalogues Stremio ne sont annoncés que si le jeton TMDB est configuré ;
 * une configuration illisible renvoie le manifest de base (comportement inchangé).
 */
function hasTmdbToken(deps: AppDeps, encoded: string): boolean {
  try {
    return withServerServices(decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain })).services.tmdbToken !== undefined;
  } catch {
    return false;
  }
}

function manifestFor(deps: AppDeps, encoded: string) {
  if (!hasTmdbToken(deps, encoded)) return MANIFEST;
  return { ...MANIFEST, resources: ['stream', 'catalog'], catalogs: catalogEntries() };
}

/** Problèmes de configuration à renvoyer (chemins et messages, jamais de valeur saisie), ou undefined. */
function configIssues(err: unknown): string[] | undefined {
  if (err instanceof ConfigValidationError) return [...err.issues];
  if (err instanceof ConfigDecodeError) return [`config: ${err.message}`];
  return undefined;
}

/**
 * Entrée de POST /config/encode. Forme directe : la configuration elle-même (inchangée). Forme `{ previous, config }` :
 * `previous` (chiffrée) est déchiffrée ici et ses secrets sont gardés là où `config` les laisse vides, absents ou
 * masqués. Sans `config`, la configuration précédente est reconduite telle quelle.
 */
function encodeInput(body: unknown, deps: AppDeps): unknown {
  if (!isRecord(body) || !('previous' in body || 'config' in body)) return body;
  if (body.previous !== undefined && typeof body.previous !== 'string') {
    throw new ConfigValidationError(['previous: chaîne encodée attendue']);
  }
  if (body.config !== undefined && !isRecord(body.config)) throw new ConfigValidationError(['config: objet attendu']);
  const previous =
    typeof body.previous === 'string' ? decodeConfig(body.previous, deps.secret, { allowPlain: deps.allowPlain }) : undefined;
  const patch = isRecord(body.config) ? body.config : { ...previous };
  return mergeSecrets(patch, previous);
}

/** Fermetures des ressources propres à une application (base des données utilisateur, services lt), par application. */
const closers = new WeakMap<App, () => void>();

/** Libère les ressources d'une application créée par createApp (tests, arrêt propre). */
export function closeApp(app: App): void {
  closers.get(app)?.();
  closers.delete(app);
}

/**
 * Application Hono : même table de routes sous Node (@hono/node-server) et sous Workers. Les services dépendants de
 * l'hôte viennent de la plateforme active (voir platform/).
 */
export function createApp(deps: AppDeps): App {
  const app = newApp();
  // Derrière un reverse proxy de confiance uniquement : le débit se mesure alors sur la vraie IP du client.
  const trustedHops = isTrustProxy() ? 1 : 0;
  app.use('*', etag());
  // Mesures d'exploitation : groupe de routes, statut, latence, dernières erreurs 5xx (écriture en mémoire, envoi groupé).
  app.use('*', metricsMiddleware(() => deps.metrics ?? platform().metrics));
  // Compteurs par fournisseur (appels, hits L1/L2, périmés, jointures) : écouteur global du cache à deux niveaux.
  installCacheCounters();
  app.use('*', async (c, next) => {
    c.set('ip', clientAddress(c, trustedHops));
    c.set('edge', false);
    await next();
  });
  // Relais de confiance authentifié par secret (LASTADDON_EDGE_SECRET) : IP réelle du client, sans faire confiance à un en-tête libre.
  app.use('*', edgeTrust());
  app.use('*', corsMiddleware([...allowedOrigins(), ...(deps.uiOrigins ?? [])]));
  // Une seule base de données utilisateur par application : fournie, ou créée par la plateforme au premier besoin.
  const backend = deps.userBackend ?? platform().createUserBackend({ path: deps.userDbPath });
  // Mode maintenance (réglage global lu à travers un cache de quelques secondes) : tout répond 503 sauf /admin, /health, connexion.
  const maintenance = createMaintenanceGate(async () => (backend.hasData?.() === false ? { enabled: false, message: '' } : (await backend.admin().getSettings()).maintenance));
  app.use('*', maintenanceMiddleware(maintenance));
  app.use('*', rateLimit((c) => CONFIG_PATH.test(c.req.path), createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
  app.use('*', rateLimit((c) => LT_WRITE_PATH.test(c.req.path) && c.req.method === 'POST', createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
  app.use('*', rateLimit((c) => c.req.method === 'GET' && OPEN_LT_PATHS.some((pattern) => pattern.test(c.req.path)), createRateLimiter(readRateLimit(), READ_RATE_WINDOW_MS)));
  app.use('*', jsonBody(DEFAULT_JSON_LIMIT));

  app.get('/health', (c) => sendJson(c, { ok: true }));

  app.get('/manifest.json', (c) => sendJson(c, MANIFEST));

  app.get('/:config/manifest.json', (c) => sendJson(c, manifestFor(deps, c.req.param('config'))));

  app.get('/config/schema', async (c) => {
    const localProwlarr = await localProwlarrStatusOf(deps.localProwlarr);
    return sendJson(c, { ...configJsonSchema(), presets: presetCatalog(), localProwlarr });
  });

  app.post('/config/encode', (c) => {
    try {
      return sendJson(c, { config: encodeConfig(encodeInput(c.get('body'), deps), deps.secret) });
    } catch (err) {
      const issues = configIssues(err);
      if (issues !== undefined) return sendJson(c, { error: 'invalid_config', issues }, 400);
      throw err;
    }
  });

  // Déchiffre une configuration pour le configurateur : secrets remplacés par un masque, jamais de valeur.
  app.post('/config/decode', (c) => {
    try {
      const body = c.get('body');
      const encoded = isRecord(body) ? body.config : undefined;
      if (typeof encoded !== 'string') throw new ConfigValidationError(['config: chaîne encodée attendue']);
      const config = decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
      c.header('Cache-Control', 'no-store');
      return sendJson(c, maskConfig(config));
    } catch (err) {
      const issues = configIssues(err);
      if (issues !== undefined) return sendJson(c, { error: 'invalid_config', issues }, 400);
      throw err;
    }
  });

  registerStreamRoutes(app, deps);
  registerTestRoutes(app, deps);
  registerPlayRoutes(app, deps);
  registerLtRoutes(app, deps, backend);
  // Routes de gestion des indexeurs : seulement avec LASTADDON_LEGACY_INDEXERS=1 (les addons Stremio sont l'unique source par défaut).
  if (legacyIndexersEnabled()) registerIndexerRoutes(app, deps);
  registerUserRoutes(app, deps, backend, maintenance);
  const party = deps.party ?? platform().createPartyBackend?.();
  registerPartyRoutes(app, deps, backend, party);
  registerAdminRoutes(app, deps, backend, maintenance, party);
  // Avatars par collections : R2 sous Workers, dossier ou relais sous Node. Avant l'interface web (pas de repli sur index.html).
  const avatars = platform().avatarAssets;
  if (avatars !== undefined) registerAvatarRoutes(app, avatars);
  closers.set(app, () => {
    closeLtRoutes(app);
    backend.close();
  });

  const ui = deps.ui ?? platform().uiAssets ?? (deps.uiDir === undefined ? undefined : platform().uiAssetsFromDir?.(deps.uiDir));
  if (ui !== undefined) {
    // Le serveur de streaming local n'existe que sur une machine (Node) : pas de relais /_ss sur Workers.
    if (platform().localMedia !== undefined) registerStreamingProxy(app, deps.streamingServer ?? configuredStreamingServer());
    registerUiRoutes(app, ui);
  }

  app.onError(errorHandler);
  app.notFound(notFound);
  return app;
}
