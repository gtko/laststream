import { platform } from '../platform/index.js';
import { type MetricsSink, type MetricsService, noopSink } from './core.js';

export * from './core.js';

/** Service de métriques de la plateforme active, ou undefined (plateforme sans mesures). */
export function metricsService(): MetricsService | undefined {
  try {
    return platform().metrics;
  } catch {
    return undefined;
  }
}

/** Point d'écriture des métriques : sans effet quand la plateforme n'en fournit pas. N'échoue jamais. */
export function metrics(): MetricsSink {
  return metricsService()?.sink ?? noopSink;
}
