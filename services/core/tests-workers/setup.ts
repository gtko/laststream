import { env } from 'cloudflare:workers';
import { setPlatform } from '../src/platform/index.js';
import { nodeRuntimeEnv } from '../src/platform/node/env.js';
import { createWorkersPlatform, type WorkerEnv } from '../src/platform/workers/index.js';

// Plateforme Workers réelle (Durable Object, KV, Assets de Miniflare). Les variables d'exécution restent celles de
// process.env, pour que `vi.stubEnv` des tests fonctionne comme sous Node.
setPlatform({ ...createWorkersPlatform(env as unknown as WorkerEnv), env: nodeRuntimeEnv });
