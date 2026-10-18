import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ConfigDecodeError, decodeConfig, encodeConfig } from './config/codec.js';
import { presetCatalog } from './config/presets.js';
import { ConfigValidationError, configJsonSchema } from './config/schema.js';
import { allowedOrigins, isTrustProxy } from './config/runtime-env.js';
import { maskConfig, mergeSecrets } from './config/secrets.js';
import type { AppDeps } from './deps.js';
import { catalogEntries } from './lt/catalog.js';
import { registerLtRoutes } from './lt/router.js';
import { registerIndexerRoutes } from './routes/indexers.js';
import { registerPlayRoutes } from './routes/play.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerTestRoutes } from './routes/test.js';
import { registerUserRoutes } from './user/routes.js';
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
  /^\/manifest\.json$/,
  /^\/[^/]+\/manifest\.json$/,
  /^\/[^/]+\/stream\/[^/]+\/[^/]+$/,
];
/** Endpoints de configuration (/config/*) : origines restreintes et limite de débit. */
const CONFIG_PATH = /^\/config(?:\/|$)/;
/** Routes lt et catalogues (proxys publics par configuration) : GET ouvert à toute origine. */
const OPEN_LT_PATHS: readonly RegExp[] = [/^\/[^/]+\/lt\/.+$/, /^\/[^/]+\/catalog\/.+$/];
/** Routes lt en POST : origines restreintes et limite de débit, comme /config/*. */
const LT_WRITE_PATH = /^\/[^/]+\/lt(?:\/|$)/;
/** Données utilisateur (/user/*) : origines restreintes, limite de débit comme /config/*, jamais en cache. */
const USER_PATH = /^\/user(?:\/|$)/;
const USER_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const USER_HEADERS = 'Content-Type, Authorization, X-Profile-Token, X-Bootstrap-Token';

/** Routes ouvertes : manifest, stream, lt et catalogues en GET (préflight GET inclus). */
function isOpenPath(req: Request): boolean {
  if (OPEN_CORS_PATHS.some((pattern) => pattern.test(req.path))) return true;
  if (!OPEN_LT_PATHS.some((pattern) => pattern.test(req.path))) return false;
  if (req.method === 'GET') return true;
  return req.method === 'OPTIONS' && req.get('access-control-request-method') === 'GET';
}
const CONFIG_RATE_LIMIT = 30;
const CONFIG_RATE_WINDOW_MS = 60_000;
/** GET lt et catalogues : 120 requêtes par minute et par IP. */
const READ_RATE_LIMIT = 120;
const READ_RATE_WINDOW_MS = 60_000;

/**
 * CORS : `*` uniquement sur les routes manifest et stream (GET). Sur /config/*, seule une origine
 * présente dans `origins` reçoit Access-Control-Allow-Origin. Les autres routes n'ont pas d'en-tête CORS.
 */
function corsMiddleware(origins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isOpenPath(req)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    } else if (CONFIG_PATH.test(req.path) || LT_WRITE_PATH.test(req.path) || USER_PATH.test(req.path)) {
      const origin = req.get('origin');
      res.vary('Origin');
      if (origin !== undefined && origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        if (USER_PATH.test(req.path)) {
          res.setHeader('Access-Control-Allow-Methods', USER_METHODS);
          res.setHeader('Access-Control-Allow-Headers', USER_HEADERS);
        } else {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Limite les requêtes qui satisfont `applies` à CONFIG_RATE_LIMIT par minute et par IP (préflights OPTIONS exclus). */
function rateLimit(applies: (req: Request) => boolean, limiter: ReturnType<typeof createRateLimiter>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!applies(req) || req.method === 'OPTIONS') {
      next();
      return;
    }
    const verdict = limiter(req.ip ?? 'inconnu');
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterSec));
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

/** Erreur du parseur JSON (400) ou payload trop gros (413) : réponse générique, sans contenu. */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: unknown }).status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request' });
    return;
  }
  console.error('Erreur interne', err instanceof Error ? err.name : 'inconnue');
  res.status(500).json({ error: 'internal_error' });
}

/**
 * Manifest d'une configuration. Les catalogues Stremio ne sont annoncés que si le jeton TMDB est configuré ;
 * une configuration illisible renvoie le manifest de base (comportement inchangé).
 */
function hasTmdbToken(deps: AppDeps, encoded: string): boolean {
  try {
    return decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain }).services.tmdbToken !== undefined;
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

/** Fermetures des ressources propres à une application (base des données utilisateur), par application. */
const closers = new WeakMap<Express, () => void>();

/** Libère les ressources d'une application créée par createApp (tests, arrêt propre). */
export function closeApp(app: Express): void {
  closers.get(app)?.();
  closers.delete(app);
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Derrière un reverse proxy de confiance uniquement : le débit se mesure alors sur la vraie IP du client.
  if (isTrustProxy()) app.set('trust proxy', 1);
  app.use(corsMiddleware(allowedOrigins()));
  app.use(rateLimit((req) => CONFIG_PATH.test(req.path), createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
  app.use(rateLimit((req) => LT_WRITE_PATH.test(req.path) && req.method === 'POST', createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
  app.use(rateLimit((req) => req.method === 'GET' && OPEN_LT_PATHS.some((pattern) => pattern.test(req.path)), createRateLimiter(READ_RATE_LIMIT, READ_RATE_WINDOW_MS)));
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/manifest.json', (_req, res) => {
    res.json(MANIFEST);
  });

  app.get('/:config/manifest.json', (req, res) => {
    res.json(manifestFor(deps, req.params.config));
  });

  app.get('/config/schema', (_req, res) => {
    res.json({ ...configJsonSchema(), presets: presetCatalog() });
  });

  app.post('/config/encode', (req, res, next) => {
    try {
      res.json({ config: encodeConfig(encodeInput(req.body, deps), deps.secret) });
    } catch (err) {
      const issues = configIssues(err);
      if (issues !== undefined) {
        res.status(400).json({ error: 'invalid_config', issues });
        return;
      }
      next(err);
    }
  });

  // Déchiffre une configuration pour le configurateur : secrets remplacés par un masque, jamais de valeur.
  app.post('/config/decode', (req, res, next) => {
    try {
      const encoded = isRecord(req.body) ? req.body.config : undefined;
      if (typeof encoded !== 'string') throw new ConfigValidationError(['config: chaîne encodée attendue']);
      const config = decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
      res.setHeader('Cache-Control', 'no-store');
      res.json(maskConfig(config));
    } catch (err) {
      const issues = configIssues(err);
      if (issues !== undefined) {
        res.status(400).json({ error: 'invalid_config', issues });
        return;
      }
      next(err);
    }
  });

  registerStreamRoutes(app, deps);
  registerTestRoutes(app, deps);
  registerPlayRoutes(app, deps);
  registerLtRoutes(app, deps);
  registerIndexerRoutes(app, deps);
  closers.set(app, registerUserRoutes(app, deps));

  app.use(errorHandler);
  return app;
}
