import { nodeCapabilities } from './capabilities.js';
import { nodeRuntimeEnv } from './env.js';
import { nodeHttpClient } from './http-client.js';
import { createMemoryKvCache } from './kv-cache.js';
import { nodeScheduler } from './scheduler.js';
import { nodeLocalMedia } from './local-media.js';
import { createFsUiAssets } from './ui-assets.js';
import { createNodeUserBackend } from './user-backend.js';
import type { Platform } from '../types.js';

export { createFsUiAssets, assertUiDir } from './ui-assets.js';
export { createMemoryKvCache } from './kv-cache.js';
export { nodeRuntimeEnv } from './env.js';
export { nodeHttpClient } from './http-client.js';
export { nodeScheduler } from './scheduler.js';
export { projectRoot } from './paths.js';
export { openUserDb, userDbPath, USER_DB_FILE, wrapSqlite } from './user-db.js';
export { createNodeUserBackend } from './user-backend.js';

/** Plateforme Node : process.env, undici, timers, mémoire, fichiers. */
export function createNodePlatform(): Platform {
  return {
    env: nodeRuntimeEnv,
    http: nodeHttpClient,
    scheduler: nodeScheduler,
    capabilities: nodeCapabilities,
    createKvCache: () => createMemoryKvCache(),
    createUserBackend: (options) => createNodeUserBackend(options),
    localMedia: nodeLocalMedia,
    uiAssetsFromDir: createFsUiAssets,
  };
}
