import type { CacheEvent, CacheProvider } from '../cache/ttl-cache.js';
import { setCacheListener } from '../cache/ttl-cache.js';
import { platform } from '../platform/index.js';
import { type MetricsSink, type MetricsService, noopSink } from './core.js';
import type { ProviderEvent, ProviderName } from './providers.js';

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

/** Compteur par fournisseur (appel sortant, lecture de cache, fiche R2, 304). Sans effet hors plateforme de mesure. */
export function recordProviderEvent(provider: ProviderName, event: ProviderEvent): void {
  metrics().provider(provider, event);
}

/**
 * Compteurs des fiches R2 (lot « fiches ») : `r2hit` / `r2miss` pour la lecture du R2, `304` pour une réponse non
 * modifiée. Même compteur que `recordProviderEvent`, avec les seuls événements de fiche.
 */
export function recordMetaEvent(event: 'r2hit' | 'r2miss' | '304', provider: ProviderName): void {
  recordProviderEvent(provider, event);
}

/** Événement de cache -> compteur : un `miss` est un appel sortant. */
const CACHE_EVENT: Readonly<Record<CacheEvent, ProviderEvent>> = {
  miss: 'call',
  l1hit: 'l1hit',
  l2hit: 'l2hit',
  stale: 'stale',
  coalesced: 'coalesced',
};

/**
 * Écouteur des compteurs du cache à deux niveaux (`setCacheListener`). Sans fournisseur (entrée de mémoire seule), rien :
 * ces lectures ne sont pas attribuables à un fournisseur.
 */
export function recordCacheEvent(event: CacheEvent, provider: CacheProvider | undefined): void {
  if (provider === undefined) return;
  recordProviderEvent(provider, CACHE_EVENT[event]);
}

/** Branche les compteurs de cache sur le cache à deux niveaux : à appeler une fois, à la création de l'application. */
export function installCacheCounters(): void {
  setCacheListener(recordCacheEvent);
}
