import type { ExecutionContext } from '@cloudflare/workers-types';
import { ADMIN_PREFIX, handleAdmin } from './admin/routes.js';
import { USER_STORE_NAME } from './platform/workers/user-backend.js';
import { createApp } from './app.js';
import { isPlainAllowed, secretFromEnv } from './config/secret.js';
import type { AppDeps } from './deps.js';
import type { App } from './http/app-env.js';
import { setPlatform } from './platform/index.js';
import { createWorkersPlatform, runInRequest, type WorkerEnv } from './platform/workers/index.js';

export { UserStoreDO } from './platform/workers/index.js';

/** Application construite au premier appel de l'isolat : les liaisons `env` sont les mêmes pour toutes les requêtes. */
let app: App | undefined;

function appFor(env: WorkerEnv): App {
  if (app !== undefined) return app;
  const platform = createWorkersPlatform(env);
  setPlatform(platform);
  const secret = secretFromEnv();
  if (secret === undefined) throw new Error('LASTADDON_SECRET manquant : wrangler secret put LASTADDON_SECRET');
  app = createApp({ secret, allowPlain: isPlainAllowed(), ui: platform.uiAssets, authLimiter: authLimiterFrom(env) });
  return app;
}

/** Binding Rate Limiting (10 tentatives par 60 s, maximum de la période autorisée) pour /user/login et /user/register. */
function authLimiterFrom(env: WorkerEnv): AppDeps['authLimiter'] {
  const { AUTH_LIMITER_IP: ip, AUTH_LIMITER_USER: user } = env;
  if (ip === undefined || user === undefined) return undefined;
  return {
    byIp: async (key) => (await ip.limit({ key })).success,
    byUsername: async (key) => (await user.limit({ key })).success,
    retryAfterSec: 60,
  };
}

/**
 * Point d'entrée Cloudflare Workers : même application Hono que le serveur Node, plateforme Workers (voir
 * platform/workers/). L'IP du client vient de CF-Connecting-IP (posé par Cloudflare, non falsifiable).
 */
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(ADMIN_PREFIX)) {
      const secret = typeof env.ADMIN_SECRET === 'string' ? env.ADMIN_SECRET : undefined;
      return handleAdmin(request, secret, (operation) => env.USER_STORE.getByName(USER_STORE_NAME).admin(operation));
    }
    try {
      const handler = appFor(env);
      const clientIp = request.headers.get('cf-connecting-ip') ?? undefined;
      return await runInRequest(ctx, () => Promise.resolve(handler.fetch(request, { clientIp }, ctx)));
    } catch (err) {
      // Configuration absente ou invalide : message générique, jamais de valeur.
      console.error('[worker] erreur de démarrage', err instanceof Error ? err.name : 'inconnue');
      return Response.json({ error: 'worker_misconfigured' }, { status: 500 });
    }
  },
};
