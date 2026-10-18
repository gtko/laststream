import type { Capabilities, Platform } from '../types.js';
import { type WorkerEnv, workersRuntimeEnv } from './env.js';
import { workersHttpClient } from './http-client.js';
import { createWorkersKvCache } from './kv-cache.js';
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
    createPartyBackend: () => createDurableObjectPartyBackend(env.PARTY_ROOM),
    uiAssets: createWorkersUiAssets(env.ASSETS),
    tvStore:
      env.TV === undefined
        ? undefined
        : { blobs: createR2TvBlobs(env.TV), requestRefresh: () => workersScheduler.background(refreshTvFromEnv(env, { probe: false })) },
  };
}
