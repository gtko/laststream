import type { Express } from 'express';
import type { AppDeps } from '../deps.js';

/**
 * Lecture d'un stream (GET /:config/play/:infoHash/:fileIdx?).
 * STUB (lot 1) : renvoie 501. Le lot de résolution debrid remplace ce handler.
 */
export function registerPlayRoutes(app: Express, _deps: AppDeps): void {
  app.get('/:config/play/:infoHash{/:fileIdx}', (_req, res) => {
    res.status(501).json({ error: 'not_implemented' });
  });
}
