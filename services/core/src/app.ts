import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { encodeConfig } from './config/codec.js';
import { ConfigValidationError, configJsonSchema } from './config/schema.js';
import type { AppDeps } from './deps.js';
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

function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
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

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/manifest.json', (_req, res) => {
    res.json(MANIFEST);
  });

  app.get('/:config/manifest.json', (_req, res) => {
    res.json(MANIFEST);
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

  app.use(errorHandler);
  return app;
}
