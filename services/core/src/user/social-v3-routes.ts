import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { convError } from './social-v2-messages-routes.js';
import { actorOf } from './social-v2-routes.js';
import { convKey, type ConvScope } from './social-v2-store.js';
import { isSingleEmoji, messagesQuery } from './social-v2-validation.js';
import { cleanConvBody, convMessageSchema, groupCreateSchema, groupUpdateSchema, isGroupId, parseConv, reactionSchema, voteSchema } from './social-v3-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes sociales v3 (contrat « Social v3 », docs/social-v3-contract.md, périmètre S3a) : messages d'une conversation
 * (`/user/social/conv/:conv/*`, `:conv` = `dm:<pid>` ou `g:<id>`), réactions, sondages, frappe, et groupes
 * (`/user/social/groups*`). Mêmes règles d'accès que v2 : profil agissant par `X-Profile-Id`, profil enfant refusé.
 */

/** Frappe : une notification par conversation et par intervalle (au-delà : 429). */
const TYPING_INTERVAL_MS = 333;

export function registerSocialV3Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);
  const typingLimit = createRateLimiter(1, TYPING_INTERVAL_MS);

  /** Conversation de l'URL ; forme inconnue : 404 `conv_not_found`. */
  const scopeOf = (c: Ctx): ConvScope => {
    const scope = parseConv(String(c.req.param('conv')));
    if (scope === undefined) throw new UserApiError(404, 'conv_not_found');
    return scope;
  };

  /** Identifiant de groupe de l'URL ; forme inconnue : 404 `group_not_found`. */
  const groupOf = (c: Ctx): string => {
    const id = String(c.req.param('id'));
    if (!isGroupId(id)) throw new UserApiError(404, 'group_not_found');
    return id;
  };

  // Messages d'une conversation

  /** Messages de la conversation : `{ messages }`, du plus ancien au plus récent (`?before=`, `?limit=` 50 au plus). */
  router.get('/social/conv/:conv/messages', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const query = parseWith(messagesQuery, queryParams(c));
    const outcome = await social().convMessages(me.pid, scope, query.before, query.limit);
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    return sendJson(c, { messages: outcome.messages });
  });

  /**
   * Envoi dans la conversation : texte (1 à 1000 caractères), titre, moment, invitation de salon ou sondage (2 à 6 options),
   * avec une réponse facultative. 201 `{ message }`. 429 au-delà de 30 par minute. Chaque destinataire reçoit sa vue.
   */
  router.post('/social/conv/:conv/messages', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const input = parseWith(convMessageSchema, c.get('body'));
    const { body, issues } = cleanConvBody(input.kind, input.body ?? '');
    if (issues.length > 0) throw new UserApiError(400, 'invalid_body', issues);
    const outcome = await social().sendConvMessage(
      me.pid,
      scope,
      { kind: input.kind, body, title: input.title, moment: input.moment, party: input.party, poll: input.poll, replyTo: input.replyTo },
      Date.now(),
    );
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result === 'reply_unknown') throw new UserApiError(400, 'invalid_body', ['replyTo:unknown']);
    if (outcome.result !== 'sent') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'message', message: notice.payload });
    return sendJson(c, { message: outcome.message }, 201);
  });

  /** Marque la conversation lue. 204. En DM, l'expéditeur reçoit `read` si au moins un message vient d'être lu. */
  router.put('/social/conv/:conv/read', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const outcome = await social().readConv(me.pid, scope, Date.now());
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    if (outcome.count > 0 && outcome.peer !== undefined) emitSocialEvent(deps.socialEvents, [outcome.peer], { t: 'read', pid: me.pid, at: outcome.at });
    return sendEmpty(c, 204);
  });

  // Réactions et sondages

  /**
   * Bascule ma réaction `emoji` sur un message (posée si absente, retirée si présente). 200 `{ reactions }` : les réactions
   * du message vues par moi. Les autres membres reçoivent `reaction` avec leur propre vue (`mine`).
   */
  router.post('/social/conv/:conv/messages/:id/reactions', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const messageId = String(c.req.param('id'));
    const input = parseWith(reactionSchema, c.get('body'));
    if (!isSingleEmoji(input.emoji)) throw new UserApiError(400, 'invalid_body', ['emoji:not_emoji']);
    const outcome = await social().toggleReaction(me.pid, scope, messageId, input.emoji, Date.now());
    if (outcome.result === 'message_not_found') throw new UserApiError(404, 'message_not_found');
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) {
      emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'reaction', conv: notice.conv, id: messageId, reactions: notice.payload });
    }
    return sendJson(c, { reactions: outcome.reactions });
  });

  /**
   * Vote pour une option d'un sondage de la conversation. 200 `{ poll }` (ma vue). Un seul vote par profil : 409
   * `already_voted`. Les autres membres reçoivent `poll` avec leur vue.
   */
  router.post('/social/conv/:conv/polls/:pollId/vote', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const pollId = String(c.req.param('pollId'));
    const input = parseWith(voteSchema, c.get('body'));
    const outcome = await social().votePoll(me.pid, scope, pollId, input.optionId, Date.now());
    if (outcome.result === 'poll_not_found') throw new UserApiError(404, 'poll_not_found');
    if (outcome.result === 'option_unknown') throw new UserApiError(400, 'invalid_body', ['optionId:unknown']);
    if (outcome.result === 'poll_closed') throw new UserApiError(409, 'poll_closed');
    if (outcome.result === 'already_voted') throw new UserApiError(409, 'already_voted');
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'poll', conv: notice.conv, poll: notice.payload });
    return sendJson(c, { poll: outcome.poll });
  });

  // Frappe

  /**
   * Signale que je tape dans la conversation. 204. Au plus une fois par tranche de 1/3 s et par conversation (429
   * `rate_limited` au-delà). Les autres membres reçoivent `typing`.
   */
  router.post('/social/conv/:conv/typing', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const verdict = typingLimit(`${me.pid}|${convKey(scope)}`);
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const outcome = await social().typingNotices(me.pid, scope);
    if (outcome.result !== 'ok') throw convError(scope, outcome.result);
    for (const notice of outcome.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'typing', conv: notice.conv, pid: me.pid });
    return sendEmpty(c, 204);
  });

  // Groupes

  /**
   * Crée un groupe : `{ name, members }` (2 à 19 amis, en plus de moi). 201 `Conversation` (le groupe, vu par moi). 403
   * `not_friend` si un membre n'est pas mon ami.
   */
  router.post('/social/groups', async (c) => {
    const me = await actor(c);
    const input = parseWith(groupCreateSchema, c.get('body'));
    const outcome = await social().createGroup(me.pid, input.name, input.members, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_friend') throw new UserApiError(403, 'not_friend');
    if (outcome.result !== 'ok') throw new UserApiError(400, 'invalid_body');
    return sendJson(c, outcome.conversation, 201);
  });

  /**
   * Modifie un groupe dont je suis membre : `{ name?, add?, remove? }`. `add` : amis seulement (403 `not_friend`) ; 409
   * `group_full` au-delà de 20 membres. `remove` : autres membres (moi-même : 400 `self`, pour quitter voir DELETE).
   * 200 `Conversation`. 404 `group_not_found` si je n'en suis pas membre.
   */
  router.put('/social/groups/:id', async (c) => {
    const me = await actor(c);
    const groupId = groupOf(c);
    const input = parseWith(groupUpdateSchema, c.get('body'));
    const outcome = await social().updateGroup(me.pid, groupId, input, Date.now());
    if (outcome.result === 'unknown') throw new UserApiError(404, 'group_not_found');
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_friend') throw new UserApiError(403, 'not_friend');
    if (outcome.result === 'full') throw new UserApiError(409, 'group_full');
    if (outcome.result !== 'ok') throw new UserApiError(400, 'invalid_body');
    return sendJson(c, outcome.conversation);
  });

  /** Quitte le groupe. 204. Le dernier membre qui part supprime le groupe. 404 `group_not_found` si je n'en suis pas membre. */
  router.delete('/social/groups/:id/me', async (c) => {
    const me = await actor(c);
    const groupId = groupOf(c);
    if (!(await social().leaveGroup(me.pid, groupId))) throw new UserApiError(404, 'group_not_found');
    return sendEmpty(c, 204);
  });
}
