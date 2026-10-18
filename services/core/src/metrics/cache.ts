import type { KvCache } from '../platform/types.js';
import type { MetricsSink } from './core.js';

/** Compte les succès et échecs de lecture d'un cache sous son préfixe (taux de succès par préfixe). */
export function withCacheMetrics(kv: KvCache, prefix: string, sink: MetricsSink): KvCache {
  return {
    async get(key) {
      const value = await kv.get(key);
      sink.cache(prefix, value !== undefined);
      return value;
    },
    set: (key, value, ttl) => kv.set(key, value, ttl),
    delete: (key) => kv.delete(key),
  };
}
