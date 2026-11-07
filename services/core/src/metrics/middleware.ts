import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../http/app-env.js';
import { routeGroup, routeLabel, type MetricsService } from './core.js';

/**
 * Mesure chaque requête : groupe de routes, classe de statut, latence (jusqu'à l'envoi de la réponse), et dernière erreur 5xx
 * (étiquette de route sans paramètre + message épuré). Écriture en mémoire ; l'envoi groupé vers le Durable Object est
 * déclenché ici au plus toutes les ~10 s. Ne bloque jamais la requête et n'en change jamais l'issue.
 */
export function metricsMiddleware(service: () => MetricsService | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    try {
      await next();
    } finally {
      try {
        const svc = service();
        if (svc !== undefined) {
          const status = c.res?.status ?? 500;
          const path = c.req.path;
          svc.sink.request(routeGroup(path), status, Date.now() - started);
          if (status >= 500) svc.sink.error(routeLabel(path), status, c.get('failure') ?? `HTTP ${status}`);
          svc.flushIfDue?.();
        }
      } catch {
        // Les mesures sont facultatives.
      }
    }
  };
}
