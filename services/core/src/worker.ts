import './egress/install.js';
import * as Sentry from '@sentry/cloudflare';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { ADMIN_PREFIX, handleAdmin } from './admin/routes.js';
import { USER_STORE_NAME } from './platform/workers/user-backend.js';
import { createApp, serverRelease } from './app.js';
import { isPlainAllowed, secretFromEnv } from './config/secret.js';
import type { AppDeps } from './deps.js';
import type { App } from './http/app-env.js';
import { DebridEgressBlockedError, runWithEgressContext, SERVER_SIDE_DISABLED, setDebridBlockReporter } from './egress/debrid-guard.js';
import { workerSentryOptions } from './observability/options.js';
import { setWorkerOrigin } from './observability/scrub.js';
import { setUnhandledErrorReporter } from './observability/report.js';
import { platform, setPlatform } from './platform/index.js';
import { handlePartyWs, PARTY_WS_PATH } from './party/ws.js';
import { handleSocialLiveWs } from './user/social-v2-live-ws.js';
import { SOCIAL_LIVE_PATH } from './user/social-v2-live.js';
import { countryCode } from './user/title-starts.js';
import { createWorkersPlatform, createWorkersTvAdmin, ensureWorkersPlatform, prewarmMetaFromEnv, refreshRowsFromEnv, refreshTvFromEnv, runInRequest, type WorkerEnv } from './platform/workers/index.js';
import { createWorkersHealthProbes, createWorkersOpsPorts } from './platform/workers/ops.js';
import { workersQuotaGate } from './platform/workers/metrics.js';

export { Metrics, PartyRoom, UserStoreDO } from './platform/workers/index.js';

/** Application construite au premier appel de l'isolat : les liaisons `env` sont les mêmes pour toutes les requêtes. */
let app: App | undefined;

function appFor(env: WorkerEnv): App {
  if (app !== undefined) return app;
  const platform = createWorkersPlatform(env);
  setPlatform(platform);
  const secret = secretFromEnv();
  if (secret === undefined) throw new Error('LASTADDON_SECRET manquant : wrangler secret put LASTADDON_SECRET');
  const mdbLimit = env.MDBLIST_LIMITER;
  const tvAdmin = createWorkersTvAdmin(env);
  app = createApp({
    secret,
    allowPlain: isPlainAllowed(),
    ui: platform.uiAssets,
    authLimiter: authLimiterFrom(env),
    mdblistLimiter: mdbLimit === undefined ? undefined : async () => (await mdbLimit.limit({ key: 'mdblist' })).success,
    // Budget quotidien global (jour UTC) partagé par toutes les instances : Durable Object Metrics. Absent : compteur en mémoire.
    ...(env.METRICS === undefined ? {} : { mdblistQuota: workersQuotaGate(env.METRICS) }),
    ops: createWorkersOpsPorts(env),
    healthProbes: createWorkersHealthProbes(env),
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

// Garde de sortie : posée par le premier import (egress/install.ts), avant tout autre module de l'isolat (Worker et
// Durable Objects) : le fetch global refuse un hôte de débridage avant l'envoi, redirections comprises.
// Appel bloqué : événement Sentry de niveau error (hôte, déclencheur, identifiant de requête ; ni URL ni clé). Sans SENTRY_DSN, le SDK n'envoie rien.
setDebridBlockReporter((error) => {
  Sentry.withScope((scope) => {
    scope.setLevel('error');
    scope.setTags({ blocked_host: error.host, egress_trigger: error.trigger, request_id: error.requestId ?? 'none' });
    scope.setFingerprint(['server_side_debrid_call']);
    Sentry.captureException(error);
  });
});

// Erreurs 500 de l'application (routes, middlewares) : remontées à Sentry. Sans SENTRY_DSN, le SDK n'envoie rien.
// Un appel de débridage bloqué est déjà remonté par la garde : pas de second événement.
setUnhandledErrorReporter((error) => {
  if (!(error instanceof DebridEgressBlockedError)) Sentry.captureException(error);
});

/** Échec du préchauffage des fiches (cron) : journalisé sans message brut ; les autres tâches du cron ne sont pas concernées. */
function logPrewarmFailure(err: unknown): void {
  console.error('[worker] préchauffage des fiches échoué', err instanceof Error ? err.name : 'inconnue');
}

/** Traite une requête (hors contexte de sortie : voir `worker.fetch`). */
async function handleFetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
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
    // Appel de débridage bloqué (déjà signalé par la garde) : 502 explicite. Sinon, configuration absente ou invalide :
    // remontée à Sentry, puis message générique, jamais de valeur.
    if (err instanceof DebridEgressBlockedError) return Response.json({ error: SERVER_SIDE_DISABLED }, { status: 502 });
    Sentry.captureException(err);
    console.error('[worker] erreur de démarrage', err instanceof Error ? err.name : 'inconnue');
    return Response.json({ error: 'worker_misconfigured' }, { status: 500 });
  }
}

const worker = {
  fetch: (request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> =>
    // Garde de sortie : un appel bloqué pendant la requête est rattaché à son identifiant (cf-ray).
    runWithEgressContext({ trigger: 'request', requestId: request.headers.get('cf-ray') ?? crypto.randomUUID() }, () => handleFetch(request, env, ctx)),

  /**
   * Cron Trigger (wrangler.jsonc, « triggers », toutes les 6 h) : reconstruit le catalogue TV et l'EPG réduit dans R2, en
   * flux ; précalcule les rangées d'accueil communes dans R2 (lt/rows.ts) ; préchauffe les fiches des rangées et du Top 10
   * (lt/meta-prewarm.ts), en dernier : une erreur de ce préchauffage est journalisée sans toucher aux tâches précédentes.
   */
  scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    runWithEgressContext({ trigger: 'cron', requestId: `cron-${crypto.randomUUID()}` }, () => {
      ctx.waitUntil(refreshTvFromEnv(env, { probe: true }));
      ensureWorkersPlatform(env);
      ctx.waitUntil(runInRequest(ctx, () => refreshRowsFromEnv(env)));
      try {
        ctx.waitUntil(runInRequest(ctx, () => prewarmMetaFromEnv(env)).catch(logPrewarmFailure));
      } catch (err) {
        logPrewarmFailure(err);
      }
    });
  },
};

/**
 * Point d'entrée Cloudflare Workers : même application Hono que le serveur Node, plateforme Workers (voir
 * platform/workers/). L'IP du client vient de CF-Connecting-IP (posé par Cloudflare, non falsifiable).
 * Sentry (`@sentry/cloudflare`) : actif seulement si le secret SENTRY_DSN est posé ; données épurées (observability/scrub.ts).
 */
export default Sentry.withSentry(
  (env: WorkerEnv) => workerSentryOptions(env.SENTRY_DSN, serverRelease()),
  worker,
);
