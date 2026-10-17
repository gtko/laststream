import type { Express } from 'express';
import type { AppDeps } from '../deps.js';

/**
 * Route stream Stremio.
 * STUB (lot 1) : renvoie toujours une liste vide. Le lot d'agrégation remplace ce handler.
 */
export function registerStreamRoutes(app: Express, _deps: AppDeps): void {
  app.get('/:config/stream/:type/:id.json', (_req, res) => {
    res.json({ streams: [] });
  });
}
