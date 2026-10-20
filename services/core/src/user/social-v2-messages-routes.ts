import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import type { ConvError, ConvScope } from './social-v2-store.js';
import { cleanMessageBody, messageSchema, messagesQuery } from './social-v2-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes des messages directs (`/user/social/messages/:pid`, `/user/social/conversations`) : contrat « Social v2 », servi
 * par les mêmes données que les conversations v3 (un DM est la conversation `dm:<pid>`, voir social-v3-routes.ts). Profil
 * agissant et contrôle d'accès comme pour les autres routes v2 (`actorOf`).
 */

/**
 * Erreur HTTP d'une conversation refusée. DM : soi-même 400 `self`, pid inconnu ou enfant 404 `profile_not_found`, ni ami
 * ni foyer 403 `not_friend`. Groupe : non-membre ou inconnu 404 `conv_not_found` (un groupe ne se devine pas).
 */
export function convError(scope: ConvScope, reason: ConvError | string): UserApiError {
  if (reason === 'self') return new UserApiError(400, 'self');
  if (reason === 'not_allowed') return new UserApiError(403, 'not_allowed');
  if (scope.kind === 'group') return new UserApiError(404, 'conv_not_found');
  if (reason === 'unknown') return new UserApiError(404, 'profile_not_found');
  return new UserApiError(403, 'not_friend');
}

export function registerSocialV2MessageRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);
  const directScope = (c: Ctx): ConvScope => ({ kind: 'dm', peer: pidParam(String(c.req.param('pid')), 'profile_not_found') });

  /** Conversations avec les amis, le foyer et les groupes : `{ conversations }`, les plus récentes d'abord. */
  router.get('/social/conversations', async (c) => {
    const me = await actor(c);
    return sendJson(c, { conversations: await social().conversations(me.pid, Date.now()) });
  });

  /** Messages échangés avec `:pid` : `{ messages }`, du plus ancien au plus récent (`?before=`, `?limit=` 50 au plus). */
  router.get('/social/messages/:pid', async (c) => {
    const me = await actor(c);
    const scope = directScope(c);
    const query = parseWith(messagesQuery, queryParams(c));
    const outcome = await social().convMessages(me.pid, scope, query.before, query.limit);
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    return sendJson(c, { messages: outcome.messages });
  });

  /**
   * Envoi à `:pid` (texte de 1 à 1000 caractères, contexte facultatif). 201 `{ message }`. 429 au-delà de 30 par minute.
   * L'événement `message` part vers le destinataire.
   */
  router.post('/social/messages/:pid', async (c) => {
    const me = await actor(c);
    const scope = directScope(c);
    const input = parseWith(messageSchema, c.get('body'));
    const { body, issues } = cleanMessageBody(input.body);
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const outcome = await social().sendConvMessage(me.pid, scope, { kind: 'text', body, context: input.context }, Date.now());
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'sent') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'message', message: notice.payload });
    return sendJson(c, { message: outcome.message }, 201);
  });

  /**
   * Marque lus tous les messages reçus de `:pid`. 204. L'expéditeur reçoit `read` si au moins un message vient d'être lu.
   */
  router.put('/social/messages/:pid/read', async (c) => {
    const me = await actor(c);
    const scope = directScope(c);
    const outcome = await social().readConv(me.pid, scope, Date.now());
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    if (outcome.count > 0 && outcome.peer !== undefined) emitSocialEvent(deps.socialEvents, [outcome.peer], { t: 'read', pid: me.pid, at: outcome.at });
    return sendEmpty(c, 204);
  });
}
