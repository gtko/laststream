import type { KvCache } from './types.js';

/** Nombre maximal d'entrées par défaut : au-delà, les plus anciennes partent d'abord. */
const MEMORY_KV_MAX_ENTRIES = 10_000;

/**
 * Cache en mémoire avec expiration (un par processus), borné en nombre d'entrées. `now` est injectable pour les tests.
 * Neutre vis-à-vis de l'hôte : utilisé sous Node comme implémentation de `createKvCache`, et comme repli des registres.
 */
export function createMemoryKvCache(now: () => number = Date.now, maxEntries: number = MEMORY_KV_MAX_ENTRIES): KvCache {
  const entries = new Map<string, { value: string; expiresAt: number | undefined }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return Promise.resolve(undefined);
      if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
        entries.delete(key);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(entry.value);
    },
    set(key, value, ttlSeconds) {
      // Réinsertion : la clé devient la plus récente.
      entries.delete(key);
      entries.set(key, { value, expiresAt: ttlSeconds === undefined ? undefined : now() + ttlSeconds * 1000 });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return Promise.resolve();
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}
