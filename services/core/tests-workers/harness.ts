import { env } from 'cloudflare:workers';
import { closeApp, createApp } from '../src/app.js';
import type { AppDeps } from '../src/deps.js';
import type { App } from '../src/http/app-env.js';
import { createDurableObjectUserBackend } from '../src/platform/workers/user-backend.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { DEFAULT_USER_RATE_LIMITS, SECRET, type RunningApp } from '../tests/harness-core.js';

export * from '../tests/harness-core.js';

/**
 * Harnais Workers : même interface que tests/lt-harness.ts, mais l'application est câblée sur un Durable Object SQLite
 * (un objet neuf par application, donc une base vide) et appelée sans réseau. Les requêtes `fetch` vers l'adresse
 * factice d'une application sont routées vers elle ; les autres passent au `fetch` réel.
 */
const apps = new Map<string, App>();
const realFetch = globalThis.fetch.bind(globalThis);
let counter = 0;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const app = apps.get(new URL(request.url).origin);
  if (app === undefined) return realFetch(request);
  return Promise.resolve(app.fetch(request, { clientIp: '203.0.113.7' }));
}) as typeof fetch;

/** Démarre l'application (options de tests Node reprises ; celles propres à l'hôte local sont sans objet). */
export function startApp(options: {
  fetch?: typeof fetch;
  lookupHost?: (h: string) => Promise<readonly string[]>;
  allowPlain?: boolean;
  userDbPath?: string;
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number; authPerIp: number }>;
  skipDetect?: AppDeps['skipDetect'];
  thumbs?: AppDeps['thumbs'];
  rangeProxy?: AppDeps['rangeProxy'];
}): Promise<RunningApp> {
  const baseUrl = `http://app-${++counter}.test`;
  const app = createApp({
    secret: SECRET,
    allowPlain: options.allowPlain ?? false,
    fetch: options.fetch,
    lookupHost: options.lookupHost,
    userRateLimits: options.userRateLimits ?? DEFAULT_USER_RATE_LIMITS,
    rangeProxy: options.rangeProxy ?? null,
    userBackend: createDurableObjectUserBackend((env as unknown as WorkerEnv).USER_STORE, `test-${crypto.randomUUID()}`),
  });
  apps.set(baseUrl, app);
  return Promise.resolve({
    baseUrl,
    close: () => {
      apps.delete(baseUrl);
      closeApp(app);
      return Promise.resolve();
    },
  });
}
