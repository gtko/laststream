import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';
import { CACHE_PREFIXES, type CacheAdmin, type CachePrefix, type CacheStat, type PurgeJob } from '../../admin/cache-types.js';
import {
  FLUSH_INTERVAL_MS,
  type MetricsBatch,
  MetricsAccumulator,
  type MetricsRange,
  type MetricsReport,
  type MetricsService,
} from '../../metrics/core.js';
import type { ProviderHourRow } from '../../metrics/providers.js';
import { type QuotaGate, utcDay } from '../../lt/quota.js';
import type { Metrics } from './metrics-do.js';

/** Nom du Durable Object global des métriques. */
const METRICS_NAME = 'metrics';

/** Surface RPC du Durable Object utilisée ici (types simples, indépendants du typage RPC générique). */
interface MetricsRpc {
  ingest(batch: MetricsBatch): Promise<void>;
  report(range: MetricsRange, endAt?: number): Promise<MetricsReport>;
  providerHours(): Promise<ProviderHourRow[]>;
  startPurge(prefix: string): Promise<PurgeJob>;
  purgeJob(id: string): Promise<PurgeJob | undefined>;
  purgeJobs(): Promise<PurgeJob[]>;
  quotaTake(provider: string, day: string, budget: number): Promise<boolean>;
}

const rpc = (namespace: DurableObjectNamespace<Metrics>): MetricsRpc => namespace.getByName(METRICS_NAME) as unknown as MetricsRpc;

/**
 * Budget quotidien global (Workers) : compteur par fournisseur et par jour UTC dans le Durable Object global, donc partagé
 * par toutes les instances. Échec fermé : si le Durable Object ne répond pas, l'appel est refusé (jamais un appel non compté).
 */
export function workersQuotaGate(namespace: DurableObjectNamespace<Metrics>, now: () => number = Date.now): QuotaGate {
  return {
    async take(provider, budget) {
      try {
        return await rpc(namespace).quotaTake(provider, utcDay(now()), budget);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Métriques d'un isolat Workers : les mesures s'additionnent en mémoire et partent en un seul lot vers le Durable Object
 * au plus toutes les ~10 s (jamais une requête DO par requête HTTP), via `background` (ctx.waitUntil). Un envoi en échec
 * est remis dans l'accumulateur. Un isolat qui s'arrête avant le prochain envoi perd au plus 10 s de mesures.
 */
export function createRemoteMetrics(
  namespace: DurableObjectNamespace<Metrics>,
  background: (work: Promise<unknown>) => void,
  now: () => number = Date.now,
): MetricsService {
  const acc = new MetricsAccumulator(now);
  let lastFlush = 0;
  const flush = async (): Promise<void> => {
    lastFlush = now();
    if (acc.isEmpty()) return;
    const batch = acc.take();
    try {
      await rpc(namespace).ingest(batch);
    } catch {
      acc.restore(batch);
    }
  };
  return {
    sink: acc,
    flush,
    flushIfDue() {
      if (now() - lastFlush >= FLUSH_INTERVAL_MS && !acc.isEmpty()) background(flush());
    },
    async report(range, endAt) {
      await flush();
      return await rpc(namespace).report(range, endAt);
    },
    async providerHours() {
      await flush();
      return await rpc(namespace).providerHours();
    },
  };
}

/** Pages de 1000 clés lues au plus par préfixe : au-delà, le nombre est un minimum (`exact: false`). */
export const STATS_MAX_PAGES = 10;

/** Statistiques par préfixe (liste KV paginée et bornée) et purges asynchrones (Durable Object Metrics). */
export function createKvCacheAdmin(kv: KVNamespace, namespace: DurableObjectNamespace<Metrics>): CacheAdmin {
  const countPrefix = async (prefix: string): Promise<CacheStat> => {
    let keys = 0;
    let cursor: string | undefined;
    for (let page = 0; page < STATS_MAX_PAGES; page += 1) {
      const result = await kv.list({ prefix: `${prefix}:`, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      keys += result.keys.length;
      if (result.list_complete) return { prefix, keys, exact: true };
      cursor = result.cursor;
    }
    return { prefix, keys, exact: false };
  };
  return {
    stats: () => Promise.all(CACHE_PREFIXES.map(countPrefix)),
    startPurge: (prefix: CachePrefix) => rpc(namespace).startPurge(prefix),
    purgeJob: (id) => rpc(namespace).purgeJob(id),
    purgeJobs: () => rpc(namespace).purgeJobs(),
  };
}
