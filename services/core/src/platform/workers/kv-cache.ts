import type { KVNamespace } from '@cloudflare/workers-types';
import type { KvCache } from '../types.js';

/** Durée de vie minimale d'une clé KV (limite de Cloudflare). */
const KV_MIN_TTL_SECONDS = 60;
/** Durée de repli d'une écriture sans durée valide : 24 h. */
const KV_DEFAULT_TTL_SECONDS = 24 * 3600;
/** Longueur maximale d'une clé KV (octets). */
const KV_MAX_KEY_BYTES = 512;

/**
 * Cache persistant partagé entre tous les isolats, au-dessus de Workers KV. Les clés sont préfixées par
 * l'espace de noms. Cohérence éventuelle : une écriture est visible tout de suite dans la même région, jusqu'à une
 * minute plus tard ailleurs — acceptable pour des caches (statuts, URL émises, fichiers de packs).
 * Une clé trop longue est ignorée (lecture vide, écriture sans effet) plutôt que de lever.
 */
export function createWorkersKvCache(kv: KVNamespace, namespace: string): KvCache {
  const keyOf = (key: string): string | undefined => {
    const full = `${namespace}:${key}`;
    return new TextEncoder().encode(full).byteLength <= KV_MAX_KEY_BYTES ? full : undefined;
  };
  return {
    async get(key) {
      const full = keyOf(key);
      return full === undefined ? undefined : ((await kv.get(full)) ?? undefined);
    },
    async set(key, value, ttlSeconds) {
      const full = keyOf(key);
      if (full === undefined) return;
      // Toute clé expire (LAST-138) : une durée absente ou invalide (appel non typé) retombe sur le plafond, jamais sur « permanent ».
      const seconds = Number.isFinite(ttlSeconds) ? ttlSeconds : KV_DEFAULT_TTL_SECONDS;
      await kv.put(full, value, { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(seconds)) });
    },
    async delete(key) {
      const full = keyOf(key);
      if (full !== undefined) await kv.delete(full);
    },
  };
}
