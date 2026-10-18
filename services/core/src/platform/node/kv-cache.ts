import type { KvCache } from '../types.js';

/** Cache en mémoire avec expiration (un par processus). `now` est injectable pour les tests. */
export function createMemoryKvCache(now: () => number = Date.now): KvCache {
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
      entries.set(key, { value, expiresAt: ttlSeconds === undefined ? undefined : now() + ttlSeconds * 1000 });
      return Promise.resolve();
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}
