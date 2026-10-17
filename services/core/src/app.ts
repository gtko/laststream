import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { decodeConfig, encodeConfig } from './config/codec.js';
import { ConfigValidationError, configJsonSchema } from './config/schema.js';
import { allowedOrigins } from './config/runtime-env.js';
import type { AppDeps } from './deps.js';
import { catalogEntries } from './lt/catalog.js';
import { registerLtRoutes } from './lt/router.js';
import { registerPlayRoutes } from './routes/play.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerTestRoutes } from './routes/test.js';

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

/** Routes ouvertes : manifest, stream, lt et catalogues en GET (préflight GET inclus). */
function isOpenPath(req: Request): boolean {
  if (OPEN_CORS_PATHS.some((pattern) => pattern.test(req.path))) return true;
  if (!OPEN_LT_PATHS.some((pattern) => pattern.test(req.path))) return false;
  if (req.method === 'GET') return true;
  return req.method === 'OPTIONS' && req.get('access-control-request-method') === 'GET';
}
const CONFIG_RATE_LIMIT = 30;
const CONFIG_RATE_WINDOW_MS = 60_000;
const RATE_TABLE_PRUNE_SIZE = 10_000;

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
    } else if (CONFIG_PATH.test(req.path) || LT_WRITE_PATH.test(req.path)) {
      const origin = req.get('origin');
      res.vary('Origin');
      if (origin !== undefined && origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Compteur à fenêtre fixe par clé (en mémoire, par processus). Renvoie false une fois la limite atteinte. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (key: string): { allowed: boolean; retryAfterSec: number } => {
    const current = now();
    if (windows.size > RATE_TABLE_PRUNE_SIZE) {
      for (const [existing, window] of windows) {
        if (window.resetAt <= current) windows.delete(existing);
      }
    }
    let window = windows.get(key);
    if (window === undefined || window.resetAt <= current) {
      window = { count: 0, resetAt: current + windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((window.resetAt - current) / 1000));
    return { allowed: window.count <= limit, retryAfterSec };
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
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

/** Erreur du parseur JSON (400) ou payload trop gros (413) : réponse générique, sans contenu. */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
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

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(allowedOrigins()));
  app.use(rateLimit((req) => CONFIG_PATH.test(req.path), createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
  app.use(rateLimit((req) => LT_WRITE_PATH.test(req.path) && req.method === 'POST', createRateLimiter(CONFIG_RATE_LIMIT, CONFIG_RATE_WINDOW_MS)));
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
    res.json(configJsonSchema());
  });

  app.post('/config/encode', (req, res, next) => {
    try {
      res.json({ config: encodeConfig(req.body, deps.secret) });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ error: 'invalid_config', issues: err.issues });
        return;
      }
      next(err);
    }
  });

  registerStreamRoutes(app, deps);
  registerTestRoutes(app, deps);
  registerPlayRoutes(app, deps);
  registerLtRoutes(app, deps);

  app.use(errorHandler);
  return app;
}
