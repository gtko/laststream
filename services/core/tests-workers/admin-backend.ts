import { env } from 'cloudflare:workers';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { createDurableObjectUserBackend } from '../src/platform/workers/user-backend.js';
import type { UserBackend } from '../src/user/repo.js';

/** Dépôts de test sous Workers : un Durable Object « users » neuf (donc une base vide) par appel. */
export function newBackend(): UserBackend {
  return createDurableObjectUserBackend((env as unknown as WorkerEnv).USER_STORE, `test-${crypto.randomUUID()}`);
}
