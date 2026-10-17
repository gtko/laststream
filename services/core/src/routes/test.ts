import type { Express } from 'express';
import type { AppDeps } from '../deps.js';

/**
 * Test de configuration (POST /config/test).
 * STUB (lot 1) : renvoie toujours aucune source. Le lot de test de sources remplace ce handler.
 */
export function registerTestRoutes(app: Express, _deps: AppDeps): void {
  app.post('/config/test', (_req, res) => {
    res.json({ sources: [] });
  });
}
