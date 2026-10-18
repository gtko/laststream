import type { Capabilities, Platform } from '../types.js';
import { type WorkerEnv, workersRuntimeEnv } from './env.js';
import { workersHttpClient } from './http-client.js';
import { createWorkersKvCache } from './kv-cache.js';
import { workersScheduler } from './scheduler.js';
import { createWorkersUiAssets } from './ui-assets.js';
import { createDurableObjectUserBackend } from './user-backend.js';

export { runInRequest } from './scheduler.js';
export { type WorkerEnv, workersRuntimeEnv } from './env.js';
export { UserStoreDO } from './user-store-do.js';

/** Sous Workers : ni ffmpeg ni détection de segments ni proxy HLS ; miniatures par WebCodecs côté client (relais de plages). */
export const workersCapabilities: Capabilities = { thumbs: false, rangeThumbs: true, skipDetect: false, tvHls: false, sharedState: true };

/** Plateforme Workers : liaisons `env`, fetch, ctx.waitUntil, KV, Durable Object SQLite, Workers Assets. */
export function createWorkersPlatform(env: WorkerEnv): Platform {
  return {
    env: workersRuntimeEnv(env),
    http: workersHttpClient,
    scheduler: workersScheduler,
    capabilities: workersCapabilities,
    createKvCache: (namespace) => createWorkersKvCache(env.CACHE, namespace),
    createUserBackend: () => createDurableObjectUserBackend(env.USER_STORE),
    uiAssets: createWorkersUiAssets(env.ASSETS),
  };
}
