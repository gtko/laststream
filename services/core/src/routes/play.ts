import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App, Ctx } from '../http/app-env.js';
import { originalUrl, sendBody, sendEmpty, sendJson } from '../http/respond.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { platform } from '../platform/index.js';
import { type FailoverReason, type ResolveErrorCode, type ResolvedLink, resolveWithFailover } from '../play/failover.js';
import { type PlayFailureReason, renderFailure } from '../play/errors.js';
import { hostFromUrl } from '../play/hosts.js';
import { issuedUrls } from '../play/issued.js';
import { defaultPlayState, type PlayState } from '../play/state.js';
import { type PlayCopy, decodeCopiesToken } from '../play/token.js';

/** Raison affichée pour chaque motif du failover. `not_ready` et `aborted` n'ont pas de page dédiée. */
const RENDERED_REASON: Readonly<Record<FailoverReason, PlayFailureReason>> = {
  not_cached: 'not_cached',
  dead_link: 'dead_link',
  host_unavailable: 'host_unavailable',
  file_not_found: 'file_not_found',
  subscription_expired: 'subscription_expired',
  invalid_key: 'invalid_key',
  quota: 'quota',
  not_ready: 'not_cached',
  unsupported: 'unsupported_format',
  no_copy: 'no_copy',
  unknown: 'unknown',
  timeout: 'timeout',
  aborted: 'unknown',
};

/** Erreur portant un code du failover, comme celles qu'attend resolveWithFailover. */
function copyError(code: ResolveErrorCode): Error & { code: ResolveErrorCode } {
  return Object.assign(new Error(code), { code });
}

/** Lit la configuration chiffrée (ou JSON brut si allowPlain). Undefined si elle est illisible. */
function readConfig(deps: AppDeps, encoded: string): Config | undefined {
  try {
    return decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
  } catch (err) {
    if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) return undefined;
    throw err;
  }
}

/** Réponse d'échec : page HTML ou JSON selon Accept, sans clé ni URL. Le statut vient de la table des raisons. */
function sendFailure(c: Ctx, reason: PlayFailureReason, accept: string | undefined): Response {
  const failure = renderFailure(reason, { accept });
  return sendBody(c, failure.body, failure.status as ContentfulStatusCode, failure.contentType);
}

/**
 * Lecture d'un stream : GET /:config/play/c/:token, jeton signé de copies ordonnées, essayées une à une (failover,
 * budget play.budgetMs). Avant toute résolution : sortie future (not_released) et limite d'âge (age_limit) sont contrôlées.
 * Seules les copies à lien direct sont jouées : le serveur n'appelle jamais AllDebrid (les liens débridés et les torrents
 * sont résolus par l'appareil). Succès : 302 vers le lien. Erreurs : pages ou JSON génériques, sans clé ni URL.
 */
export function registerPlayRoutes(app: App, deps: AppDeps, state: PlayState = defaultPlayState()): void {
  app.get('/:config/play/c/:token', async (c) => {
    c.header('Cache-Control', 'no-store');
    const accept = c.req.header('accept');

    const decoded = decodeCopiesToken(c.req.param('token'), deps.secret);
    if (decoded === null) {
      return sendJson(c, { error: 'invalid_token', message: 'Lien de lecture invalide.' }, 400);
    }

    const config = readConfig(deps, c.req.param('config'));
    if (config === undefined) {
      return sendJson(c, { error: 'invalid_config' }, 400);
    }

    // Contrôles avant toute résolution : un contenu non sorti ou hors limite d'âge ne consomme aucune résolution.
    if (decoded.releasedAt !== undefined && Date.parse(decoded.releasedAt) > Date.now()) {
      return sendFailure(c, 'not_released', accept);
    }
    const ageLimit = config.filters.ageLimit;
    if (typeof ageLimit === 'number' && decoded.ageFr !== undefined && decoded.ageFr > ageLimit) {
      return sendFailure(c, 'age_limit', accept);
    }

    const copies = decoded.copies.filter((copy) => copy.url !== undefined && copy.kind !== 'hoster');

    const resolveCopy = async (copy: PlayCopy): Promise<ResolvedLink> => {
      if (copy.url === undefined || hostFromUrl(copy.url) === undefined) throw copyError('unknown');
      return { url: copy.url, filename: copy.filename, size: copy.size };
    };

    // Hébergeurs signalés en panne par d'autres instances (cache partagé), avant les contrôles synchrones du failover.
    await state.hostHealth.warm(copies.flatMap((copy) => (copy.url === undefined ? [] : [hostFromUrl(copy.url) ?? ''])));

    const result = await resolveWithFailover({
      copies,
      resolve: resolveCopy,
      budgetMs: config.play.budgetMs,
      isHostDown: (host) => state.hostHealth.isDown(host),
      markHostDown: (host) => {
        state.hostHealth.markDown(host);
      },
    });

    if (!result.ok) {
      return sendFailure(c, RENDERED_REASON[result.reason], accept);
    }
    const location = hostFromUrl(result.link.url) === undefined ? undefined : new URL(result.link.url).href;
    if (location === undefined) {
      return sendFailure(c, 'unknown', accept);
    }
    platform().scheduler.background(issuedUrls().noteResolved(originalUrl(c), location));
    c.header('Location', location);
    return sendEmpty(c, 302);
  });
}
