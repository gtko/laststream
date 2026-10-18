import { createMemoryMetrics } from '../../metrics/memory.js';
import { withCacheMetrics } from '../../metrics/cache.js';
import type { Capabilities, Platform } from '../types.js';
import { type WorkerEnv, workersRuntimeEnv } from './env.js';
import { workersHttpClient } from './http-client.js';
import { createWorkersKvCache } from './kv-cache.js';
import { createKvCacheAdmin, createRemoteMetrics } from './metrics.js';
import { workersScheduler } from './scheduler.js';
import { createR2TvBlobs, refreshTvFromEnv } from './tv-store.js';
import { createWorkersUiAssets } from './ui-assets.js';
import { createDurableObjectPartyBackend } from './party-backend.js';
import { createDurableObjectUserBackend } from './user-backend.js';

export { runInRequest } from './scheduler.js';
export { type WorkerEnv, workersRuntimeEnv } from './env.js';
export { refreshTvFromEnv } from './tv-store.js';
export { UserStoreDO } from './user-store-do.js';
export { PartyRoom } from './party-room.js';
export { Metrics } from './metrics-do.js';

/** Sous Workers : ni ffmpeg ni détection de segments ni proxy HLS ; miniatures par WebCodecs côté client (relais de plages). */
export const workersCapabilities: Capabilities = { thumbs: false, rangeThumbs: true, skipDetect: false, tvHls: false, sharedState: true };

/** Plateforme Workers : liaisons `env`, fetch, ctx.waitUntil, KV, Durable Object SQLite, Workers Assets. */
export function createWorkersPlatform(env: WorkerEnv): Platform {
  // Métriques agrégées dans le Durable Object `Metrics` ; sans cette liaison, mémoire de l'isolat (développement, tests).
  const metrics = env.METRICS === undefined ? createMemoryMetrics() : createRemoteMetrics(env.METRICS, (work) => workersScheduler.background(work));
  return {
    env: workersRuntimeEnv(env),
    http: workersHttpClient,
    scheduler: workersScheduler,
    capabilities: workersCapabilities,
    createKvCache: (namespace) => withCacheMetrics(createWorkersKvCache(env.CACHE, namespace), namespace, metrics.sink),
    metrics,
    ...(env.METRICS === undefined ? {} : { cacheAdmin: createKvCacheAdmin(env.CACHE, env.METRICS) }),
    createUserBackend: () => createDurableObjectUserBackend(env.USER_STORE),
    createPartyBackend: () => createDurableObjectPartyBackend(env.PARTY_ROOM),
    uiAssets: createWorkersUiAssets(env.ASSETS),
    tvStore:
      env.TV === undefined
        ? undefined
        : { blobs: createR2TvBlobs(env.TV), requestRefresh: () => workersScheduler.background(refreshTvFromEnv(env, { probe: false })) },
  };
}
