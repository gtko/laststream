import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeApp, createApp } from '../src/app.js';
import type { AppDeps } from '../src/deps.js';
import type { LocalProwlarr } from '../src/sources/local-prowlarr.js';
import { DEFAULT_USER_RATE_LIMITS, SECRET, type RunningApp } from './harness-core.js';
import { serveApp } from './serve.js';

export * from './harness-core.js';

/** Démarre l'application sur un port libre. */
export async function startApp(options: {
  fetch?: typeof fetch;
  lookupHost?: (h: string) => Promise<readonly string[]>;
  allowPlain?: boolean;
  /** Base des données utilisateur : ':memory:' par défaut (jamais de fichier dans le projet pendant les tests). */
  userDbPath?: string;
  /** Limites /user/* par minute : élevées par défaut, pour que les tests fonctionnels ne soient pas bridés. */
  userRateLimits?: Partial<{ read: number; write: number; sensitive: number; loginPerUsername: number; authPerIp: number }>;
  /** Prowlarr local simulé (absent : aucun Prowlarr local). */
  localProwlarr?: () => Promise<LocalProwlarr | null>;
  /** Détection automatique des segments de saut (binaires, URL locales autorisées, budget). */
  skipDetect?: AppDeps['skipDetect'];
  /** Miniatures de la barre (ffmpeg, cache, origines locales de test). */
  thumbs?: AppDeps['thumbs'];
  /** Relais de plages (secret + base du Worker) : `null` par défaut, jamais lu dans l'environnement pendant les tests. */
  rangeProxy?: AppDeps['rangeProxy'];
  /** Dépendances supplémentaires (administration : métriques, caches, TV, salons, limites). */
  extra?: Partial<AppDeps>;
}): Promise<RunningApp> {
  const app = createApp({
    secret: SECRET,
    allowPlain: options.allowPlain ?? false,
    fetch: options.fetch,
    lookupHost: options.lookupHost,
    userDbPath: options.userDbPath ?? ':memory:',
    userRateLimits: options.userRateLimits ?? DEFAULT_USER_RATE_LIMITS,
    localProwlarr: options.localProwlarr,
    skipDetect: options.skipDetect,
    thumbs: options.thumbs ?? { ffmpeg: null },
    rangeProxy: options.rangeProxy ?? null,
    ...options.extra,
  });
  const server: Server = serveApp(app);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          closeApp(app);
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
