import * as Sentry from '@sentry/cloudflare';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { ADMIN_PREFIX, handleAdmin } from './admin/routes.js';
import { USER_STORE_NAME } from './platform/workers/user-backend.js';
import { createApp, MANIFEST } from './app.js';
import { isPlainAllowed, secretFromEnv } from './config/secret.js';
import type { AppDeps } from './deps.js';
import type { App } from './http/app-env.js';
import { workerSentryOptions } from './observability/options.js';
import { setWorkerOrigin } from './observability/scrub.js';
import { setUnhandledErrorReporter } from './observability/report.js';
import { platform, setPlatform } from './platform/index.js';
import { handlePartyWs, PARTY_WS_PATH } from './party/ws.js';
import { handleSocialLiveWs } from './user/social-v2-live-ws.js';
import { SOCIAL_LIVE_PATH } from './user/social-v2-live.js';
import { countryCode } from './user/title-starts.js';
import { createWorkersPlatform, createWorkersTvAdmin, ensureWorkersPlatform, refreshRowsFromEnv, refreshTvFromEnv, runInRequest, type WorkerEnv } from './platform/workers/index.js';

export { Metrics, PartyRoom, UserStoreDO } from './platform/workers/index.js';

/** Application construite au premier appel de l'isolat : les liaisons `env` sont les mêmes pour toutes les requêtes. */
let app: App | undefined;

function appFor(env: WorkerEnv): App {
  if (app !== undefined) return app;
  const platform = createWorkersPlatform(env);
  setPlatform(platform);
  const secret = secretFromEnv();
  if (secret === undefined) throw new Error('LASTADDON_SECRET manquant : wrangler secret put LASTADDON_SECRET');
  const rangeLimit = env.RANGE_LIMITER;
  const mdbLimit = env.MDBLIST_LIMITER;
  const tvAdmin = createWorkersTvAdmin(env);
  app = createApp({
    secret,
    allowPlain: isPlainAllowed(),
    ui: platform.uiAssets,
    authLimiter: authLimiterFrom(env),
    rangeLimiter: rangeLimit === undefined ? undefined : async (key) => (await rangeLimit.limit({ key })).success,
    mdblistLimiter: mdbLimit === undefined ? undefined : async () => (await mdbLimit.limit({ key: 'mdblist' })).success,
    // Flux temps réel : chaque écriture sociale est diffusée par le Durable Object des données (travail d'arrière-plan).
    socialEvents: (pids, event) => platform.scheduler.background(env.USER_STORE.getByName(USER_STORE_NAME).liveBroadcast([...pids], event)),
    ...(tvAdmin === undefined ? {} : { tvAdmin }),
  });
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

// Erreurs 500 de l'application (routes, middlewares) : remontées à Sentry. Sans SENTRY_DSN, le SDK n'envoie rien.
setUnhandledErrorReporter((error) => Sentry.captureException(error));

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    // Origine du Worker pour la supervision : ses propres URL gardent leur chemin épuré, les autres sont réduites à l'hôte.
    setWorkerOrigin(new URL(request.url).origin);
    if (new URL(request.url).pathname.startsWith(ADMIN_PREFIX)) {
      const secret = typeof env.ADMIN_SECRET === 'string' ? env.ADMIN_SECRET : undefined;
      return handleAdmin(request, secret, (operation) => env.USER_STORE.getByName(USER_STORE_NAME).admin(operation));
    }
    try {
      const handler = appFor(env);
      const clientIp = request.headers.get('cf-connecting-ip') ?? undefined;
      // WebSocket d'un salon : traitée avant l'application (une réponse 101 ne traverse aucun middleware).
      if (PARTY_WS_PATH.test(new URL(request.url).pathname)) {
        const secret = secretFromEnv();
        if (secret === undefined) throw new Error('LASTADDON_SECRET manquant');
        return await handlePartyWs(request, { party: platform().createPartyBackend?.(), secret, ip: clientIp });
      }
      // Flux temps réel social : ticket vérifié ici, connexion acceptée par le Durable Object des données.
      if (new URL(request.url).pathname === SOCIAL_LIVE_PATH) {
        const secret = secretFromEnv();
        if (secret === undefined) throw new Error('LASTADDON_SECRET manquant');
        // Types des requêtes Workers (même pont que party-backend.ts) : le stub accepte la mise à niveau de UserStoreDO.fetch.
        const users = env.USER_STORE.getByName(USER_STORE_NAME) as unknown as { fetch(forwarded: Request): Promise<Response> };
        return await handleSocialLiveWs(request, { secret, ip: clientIp, forward: (forwarded) => users.fetch(forwarded) });
      }
      // Pays Cloudflare (request.cf, absent des types DOM) : « XX » si inconnu.
      const country = countryCode((request as { cf?: { country?: unknown } }).cf?.country);
      return await runInRequest(ctx, () => Promise.resolve(handler.fetch(request, { clientIp, country }, ctx)));
    } catch (err) {
      // Configuration absente ou invalide : remontée à Sentry, puis message générique, jamais de valeur.
      Sentry.captureException(err);
      console.error('[worker] erreur de démarrage', err instanceof Error ? err.name : 'inconnue');
      return Response.json({ error: 'worker_misconfigured' }, { status: 500 });
    }
  },

  /**
   * Cron Trigger (wrangler.jsonc, « triggers », toutes les 6 h) : reconstruit le catalogue TV et l'EPG réduit dans R2, en
   * flux ; précalcule les rangées d'accueil communes dans R2 (lt/rows.ts).
   */
  scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(refreshTvFromEnv(env, { probe: true }));
    ensureWorkersPlatform(env);
    ctx.waitUntil(runInRequest(ctx, () => refreshRowsFromEnv(env)));
  },
};

/**
 * Point d'entrée Cloudflare Workers : même application Hono que le serveur Node, plateforme Workers (voir
 * platform/workers/). L'IP du client vient de CF-Connecting-IP (posé par Cloudflare, non falsifiable).
 * Sentry (`@sentry/cloudflare`) : actif seulement si le secret SENTRY_DSN est posé ; données épurées (observability/scrub.ts).
 */
export default Sentry.withSentry(
  (env: WorkerEnv) => workerSentryOptions(env.SENTRY_DSN, `lastaddon-core@${MANIFEST.version}`),
  worker,
);
