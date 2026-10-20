import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from './repo.js';
import { emitSocialEvent } from './social-v2-events.js';
import { convError } from './social-v2-messages-routes.js';
import { actorOf, pidParam } from './social-v2-routes.js';
import { convKey, type ConvScope } from './social-v2-store.js';
import { isPid, isSingleEmoji, messagesQuery } from './social-v2-validation.js';
import { cleanConvBody, convMessageSchema, groupCreateSchema, groupUpdateSchema, isGroupId, parseConv, reactionSchema, voteSchema } from './social-v3-validation.js';
import { joinAnswerSchema, prefsPatchSchema, relationSchema, reportSchema } from './social-v3-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes S2 (`/user/social/*`, contrat « Social v3 », S2) : préférences, relations par ami, blocages, signalements et
 * demandes de rejoindre. Profil agissant et contrôle d'accès comme pour les autres routes v2 (`actorOf`). Les effets
 * (visibilité, messages, blocages) sont appliqués par le store : ces routes ne font que valider, appeler et émettre.
 */
function registerPrefsRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, backend.users(), backend.socialV2(), deps.secret);

  // Préférences

  /** Préférences du profil agissant, défauts compris. */
  router.get('/social/prefs', async (c) => {
    const me = await actor(c);
    return sendJson(c, await social().prefsOf(me.pid));
  });

  /** Mise à jour partielle des préférences. Renvoie les préférences complètes. */
  router.put('/social/prefs', async (c) => {
    const me = await actor(c);
    const patch = parseWith(prefsPatchSchema, c.get('body'));
    return sendJson(c, await social().updatePrefs(me.pid, patch));
  });

  // Relations par ami

  /**
   * Relation du profil agissant vers un ami : favori, surnom (vide ou null = aucun), sourdine, masquage d'activité.
   * Renvoie la vue de l'ami. 404 `friend_not_found` si ce profil n'est pas un ami.
   */
  router.put('/social/friends/:pid/relation', async (c) => {
    const me = await actor(c);
    const friendPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const input = parseWith(relationSchema, c.get('body'));
    const nickname = input.nickname === undefined ? undefined : input.nickname === '' ? null : input.nickname;
    const view = await social().updateRelation(me.pid, friendPid, { ...input, nickname }, Date.now());
    if (view === undefined) throw new UserApiError(404, 'friend_not_found');
    return sendJson(c, view);
  });

  // Blocages

  /** Profils bloqués par le profil agissant : `{ blocked: [{ pid, handle }] }`. */
  router.get('/social/blocks', async (c) => {
    const me = await actor(c);
    return sendJson(c, { blocked: await social().blockedOf(me.pid) });
  });

  /**
   * Bloque un profil. 204. Retire l'amitié (acceptée ou en attente) et les demandes de rejoindre, dans les deux sens ; les
   * deux profils reçoivent `unfriend` si une amitié vient de tomber. 400 `self`, 400 `household` (le foyer ne se bloque
   * pas), 404 `profile_not_found`.
   */
  router.post('/social/blocks/:pid', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'profile_not_found');
    const outcome = await social().blockProfile(me.pid, targetPid, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'profile_not_found');
    if (outcome.result === 'household') throw new UserApiError(400, 'household');
    if (outcome.unlinked) {
      emitSocialEvent(deps.socialEvents, [targetPid], { t: 'unfriend', pid: me.pid });
      emitSocialEvent(deps.socialEvents, [me.pid], { t: 'unfriend', pid: targetPid });
    }
    return sendEmpty(c, 204);
  });

  /** Débloque un profil. 204 ; 404 `block_not_found` s'il n'était pas bloqué. L'amitié n'est pas rétablie. */
  router.delete('/social/blocks/:pid', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'block_not_found');
    if (!(await social().unblockProfile(me.pid, targetPid))) throw new UserApiError(404, 'block_not_found');
    return sendEmpty(c, 204);
  });

  // Signalements

  /**
   * Signale un profil : `{ pid, reason: 'spam'|'harassment'|'other', details? (≤ 500) }`. 201 sans corps. 400 `self`,
   * 404 `profile_not_found` (pid inconnu ou mal formé).
   */
  router.post('/social/reports', async (c) => {
    const me = await actor(c);
    const input = parseWith(reportSchema, c.get('body'));
    if (!isPid(input.pid)) throw new UserApiError(404, 'profile_not_found');
    const outcome = await social().addReport(me.pid, input.pid, input.reason, input.details, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'profile_not_found');
    return c.body(null, 201);
  });

  // Demandes de rejoindre

  /**
   * Demande à rejoindre le titre en cours de l'ami `:pid`. 204. L'ami reçoit `join_request` (vue du demandeur). 403
   * `not_allowed` si l'ami a désactivé le partage de lecture (`watchWith` = « never »). 404 `friend_not_found` sans lien.
   */
  router.post('/social/friends/:pid/join-request', async (c) => {
    const me = await actor(c);
    const hostPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const outcome = await social().requestJoin(me.pid, hostPid, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'friend_not_found');
    if (outcome.result === 'not_allowed') throw new UserApiError(403, 'not_allowed');
    emitSocialEvent(deps.socialEvents, [hostPid], { t: 'join_request', from: outcome.from });
    return sendEmpty(c, 204);
  });

  /**
   * Réponse de l'hôte à la demande du profil `:pid`. Corps `{ accept, partyId? }`. 204. Le demandeur reçoit `join_answer`
   * (`pid` = l'hôte). 404 `request_not_found` s'il n'y a pas de demande en attente.
   */
  router.post('/social/join-requests/:pid', async (c) => {
    const me = await actor(c);
    const requesterPid = pidParam(String(c.req.param('pid')), 'request_not_found');
    const input = parseWith(joinAnswerSchema, c.get('body'));
    if (!(await social().answerJoin(me.pid, requesterPid))) throw new UserApiError(404, 'request_not_found');
    emitSocialEvent(deps.socialEvents, [requesterPid], {
      t: 'join_answer',
      pid: me.pid,
      accept: input.accept,
      ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
    });
    return sendEmpty(c, 204);
  });
}

/**
 * Routes sociales v3 (contrat « Social v3 », docs/social-v3-contract.md, périmètre S3a) : messages d'une conversation
 * (`/user/social/conv/:conv/*`, `:conv` = `dm:<pid>` ou `g:<id>`), réactions, sondages, frappe, et groupes
 * (`/user/social/groups*`). Mêmes règles d'accès que v2 : profil agissant par `X-Profile-Id`, profil enfant refusé.
 */

/** Frappe : une notification par conversation et par intervalle (au-delà : 429). */
const TYPING_INTERVAL_MS = 333;

function registerConvRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
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

/** Routes sociales v3 : préférences et relations (S2), conversations riches et groupes (S3a), partage et listes (S3b). */
export function registerSocialV3Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  registerPrefsRoutes(router, deps, backend);
  registerConvRoutes(router, deps, backend);
}
