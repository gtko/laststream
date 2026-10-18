import type { ExecutionContext } from '@cloudflare/workers-types';
import { createApp } from './app.js';
import { isPlainAllowed, secretFromEnv } from './config/secret.js';
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
  app = createApp({ secret, allowPlain: isPlainAllowed(), ui: platform.uiAssets });
  return app;
}

/**
 * Point d'entrée Cloudflare Workers : même application Hono que le serveur Node, plateforme Workers (voir
 * platform/workers/). L'IP du client vient de CF-Connecting-IP (posé par Cloudflare, non falsifiable).
 */
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
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
