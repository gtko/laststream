import type { R2Bucket } from '@cloudflare/workers-types';
import type { OpsPorts, R2Listing, SqlStats } from '../../admin/ops-stats.js';
import type { WorkerEnv } from './env.js';
import { USER_STORE_NAME } from './user-backend.js';
import type { HealthProbe } from '../../health/probes.js';

/** Clé de sonde : lue seulement (absente, la lecture renvoie null, ce qui est une réponse valide). Jamais écrite. */
const HEALTH_PROBE_KEY = 'health/probe';

/** Liste paginée d'un bucket R2 (lecture seule), au format attendu par admin/ops-stats.ts. */
function listingOf(bucket: R2Bucket | undefined): R2Listing | undefined {
  if (bucket === undefined) return undefined;
  return {
    list: async (options) => {
      const page = await bucket.list(options);
      return { objects: page.objects, truncated: page.truncated, ...(page.truncated ? { cursor: page.cursor } : {}) };
    },
  };
}

/**
 * Ports d'exploitation sous Workers : buckets R2 TV, META et AVATARS (liste seulement) et statistiques de la base SQLite
 * du Durable Object des données utilisateur (RPC opsSqlStats).
 */
export function createWorkersOpsPorts(env: WorkerEnv): OpsPorts {
  return {
    r2: { TV: listingOf(env.TV), META: listingOf(env.META), AVATARS: listingOf(env.AVATARS) },
    sqlStats: async (): Promise<SqlStats> => await env.USER_STORE.getByName(USER_STORE_NAME).opsSqlStats(),
  };
}

/**
 * Sondes de /health sous Workers (lecture seule) : lecture d'une clé du KV (CACHE), tête d'une clé du bucket R2 TV, et
 * requête de santé de la base du Durable Object des données utilisateur. Un binding absent est une panne.
 */
export function createWorkersHealthProbes(env: WorkerEnv): Record<string, HealthProbe> {
  return {
    kv: async () => await env.CACHE.get(HEALTH_PROBE_KEY),
    r2: async () => {
      if (env.TV === undefined) throw new Error('bucket TV absent');
      return await env.TV.head(HEALTH_PROBE_KEY);
    },
    base: async () => await env.USER_STORE.getByName(USER_STORE_NAME).healthPing(),
  };
}
