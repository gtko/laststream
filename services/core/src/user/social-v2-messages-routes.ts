import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import type { TargetError } from './social-v2-store.js';
import { cleanMessageBody, messageSchema, messagesQuery } from './social-v2-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des messages (`/user/social/messages/*`, `/user/social/conversations`) : contrat « Social v2 ». Profil agissant
 * et contrôle d'accès comme pour les autres routes v2 (`actorOf`). Cible : pid inconnu ou enfant 404 `profile_not_found` ;
 * soi-même 400 `self` ; ni ami ni du foyer 403 `not_friend`.
 */

/** Erreur HTTP d'une cible refusée. */
export function targetError(reason: TargetError): UserApiError {
  if (reason === 'self') return new UserApiError(400, 'self');
  if (reason === 'unknown') return new UserApiError(404, 'profile_not_found');
  return new UserApiError(403, 'not_friend');
}

export function registerSocialV2MessageRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);

  /** Conversations avec les amis et le foyer : `{ conversations }`, les plus récentes d'abord. */
  router.get('/social/conversations', async (c) => {
    const me = await actor(c);
    return sendJson(c, { conversations: await social().conversations(me.pid) });
  });

  /** Messages échangés avec `:pid` : `{ messages }`, du plus ancien au plus récent (`?before=`, `?limit=` 50 au plus). */
  router.get('/social/messages/:pid', async (c) => {
    const me = await actor(c);
    const target = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const query = parseWith(messagesQuery, queryParams(c));
    const outcome = await social().messagesWith(me.pid, target, query.before, query.limit);
    if (outcome.result !== 'ok') throw targetError(outcome.result);
    return sendJson(c, { messages: outcome.messages });
  });

  /**
   * Envoi à `:pid` (texte de 1 à 1000 caractères, contexte facultatif). 201 `{ message }`. 429 au-delà de 30 par minute.
   * L'événement `message` part vers le destinataire.
   */
  router.post('/social/messages/:pid', async (c) => {
    const me = await actor(c);
    const target = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const input = parseWith(messageSchema, c.get('body'));
    const { body, issues } = cleanMessageBody(input.body);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const outcome = await social().sendMessage(me.pid, target, body, input.context, Date.now());
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'sent') throw targetError(outcome.result);
    emitSocialEvent(deps.socialEvents, [target], { t: 'message', message: outcome.message });
    return sendJson(c, { message: outcome.message }, 201);
  });

  /**
   * Marque lus tous les messages reçus de `:pid`. 204. L'expéditeur reçoit `read` si au moins un message vient d'être lu.
   */
  router.put('/social/messages/:pid/read', async (c) => {
    const me = await actor(c);
    const target = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const outcome = await social().readFrom(me.pid, target, Date.now());
    if (outcome.result !== 'ok') throw targetError(outcome.result);
    if (outcome.count > 0) emitSocialEvent(deps.socialEvents, [target], { t: 'read', pid: me.pid, at: outcome.at });
    return sendEmpty(c, 204);
  });
}
