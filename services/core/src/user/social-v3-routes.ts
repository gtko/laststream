import type { z } from 'zod';
import { cleanShareNote, LIST_ID, listCreateSchema, listItemKeySchema, listItemSchema, listUpdateSchema, SHARE_CODE, shareLinkSchema, shareSchema } from './social-v3-validation.js';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { createRateLimiter } from '../rate-limit.js';
import type { UserBackend } from './repo.js';
import { recordActivityOf } from './social-v2-activity-routes.js';
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
   * 404 `profile_not_found` (pid inconnu ou mal formé), 429 `rate_limited` au-delà de 10 signalements par jour et par profil.
   */
  router.post('/social/reports', async (c) => {
    const me = await actor(c);
    const input = parseWith(reportSchema, c.get('body'));
    if (!isPid(input.pid)) throw new UserApiError(404, 'profile_not_found');
    const outcome = await social().addReport(me.pid, input.pid, input.reason, input.details, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'profile_not_found');
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    return c.body(null, 201);
  });

  // Demandes de rejoindre

  /**
   * Demande à rejoindre le titre en cours de l'ami `:pid`. 204. L'ami reçoit `join_request` (vue du demandeur), sauf si une
   * demande identique date de moins d'une minute (204 quand même, sans événement). 403 `not_allowed` si l'ami a désactivé le
   * partage de lecture (`watchWith` = « never »). 404 `friend_not_found` sans lien. 429 `rate_limited` au-delà de 5 demandes
   * par tranche de 10 minutes vers le même ami.
   */
  router.post('/social/friends/:pid/join-request', async (c) => {
    const me = await actor(c);
    const hostPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const outcome = await social().requestJoin(me.pid, hostPid, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_found') throw new UserApiError(404, 'friend_not_found');
    if (outcome.result === 'not_allowed') throw new UserApiError(403, 'not_allowed');
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.fresh) emitSocialEvent(deps.socialEvents, [hostPid], { t: 'join_request', from: outcome.from });
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
   * 400 `kind_not_allowed` pour `kind: "party"` : seule `POST /party/:id/invite` crée une invitation de salon.
   */
  router.post('/social/conv/:conv/messages', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const input = parseWith(convMessageSchema, c.get('body'));
    if (input.kind === 'party') throw new UserApiError(400, 'kind_not_allowed');
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
   * du message vues par moi. Les autres membres reçoivent `reaction` avec leur propre vue (`mine`). 429 `rate_limited` au-delà
   * de 60 par minute ; 409 `too_many_reactions` au-delà de 6 emojis distincts de ma part sur le message ; 403 `not_allowed` en DM
   * si l'autre profil n'accepte pas mes messages (`messagesFrom`).
   */
  router.post('/social/conv/:conv/messages/:id/reactions', async (c) => {
    const me = await actor(c);
    const scope = scopeOf(c);
    const messageId = String(c.req.param('id'));
    const input = parseWith(reactionSchema, c.get('body'));
    if (!isSingleEmoji(input.emoji)) throw new UserApiError(400, 'invalid_body', ['emoji:not_emoji']);
    const outcome = await social().toggleReaction(me.pid, scope, messageId, input.emoji, Date.now());
    if (outcome.result === 'message_not_found') throw new UserApiError(404, 'message_not_found');
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result === 'too_many_emojis') throw new UserApiError(409, 'too_many_reactions');
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
   * Crée un groupe dont je suis propriétaire (`group.ownerPid`) : `{ name, members }` (2 à 19 amis, en plus de moi). 201
   * `Conversation` (le groupe, vu par moi). 403 `not_friend` si un membre n'est pas mon ami ; 403 `not_allowed` (`issues` :
   * pids refusés) si un membre n'accepte pas mes messages (`messagesFrom`) ou est en relation de blocage avec moi ; 429
   * `rate_limited` au-delà de 10 créations par heure.
   */
  router.post('/social/groups', async (c) => {
    const me = await actor(c);
    const input = parseWith(groupCreateSchema, c.get('body'));
    const outcome = await social().createGroup(me.pid, input.name, input.members, Date.now());
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_friend') throw new UserApiError(403, 'not_friend');
    if (outcome.result === 'not_allowed') throw new UserApiError(403, 'not_allowed', outcome.refused);
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'ok') throw new UserApiError(400, 'invalid_body');
    return sendJson(c, outcome.conversation, 201);
  });

  /**
   * Modifie un groupe dont je suis le propriétaire : `{ name?, add?, remove? }`. 403 `owner_only` pour un autre membre. `add` :
   * amis du propriétaire (403 `not_friend`) qui acceptent ses messages et ne sont pas bloqués (403 `not_allowed`, `issues` :
   * pids refusés) ; 409 `group_full` au-delà de 20 membres. `remove` : autres membres (moi-même : 400 `self`, pour quitter voir
   * DELETE). 200 `Conversation`. 404 `group_not_found` si je n'en suis pas membre.
   */
  router.put('/social/groups/:id', async (c) => {
    const me = await actor(c);
    const groupId = groupOf(c);
    const input = parseWith(groupUpdateSchema, c.get('body'));
    const outcome = await social().updateGroup(me.pid, groupId, input, Date.now());
    if (outcome.result === 'unknown') throw new UserApiError(404, 'group_not_found');
    if (outcome.result === 'owner_only') throw new UserApiError(403, 'owner_only');
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'not_friend') throw new UserApiError(403, 'not_friend');
    if (outcome.result === 'not_allowed') throw new UserApiError(403, 'not_allowed', outcome.refused);
    if (outcome.result === 'full') throw new UserApiError(409, 'group_full');
    if (outcome.result !== 'ok') throw new UserApiError(400, 'invalid_body');
    return sendJson(c, outcome.conversation);
  });

  /**
   * Quitte le groupe (chacun peut partir). 204. Le dernier membre qui part supprime le groupe ; si je suis le propriétaire, la
   * propriété passe au plus ancien membre. 404 `group_not_found` si je n'en suis pas membre.
   */
  router.delete('/social/groups/:id/me', async (c) => {
    const me = await actor(c);
    const groupId = groupOf(c);
    if (!(await social().leaveGroup(me.pid, groupId))) throw new UserApiError(404, 'group_not_found');
    return sendEmpty(c, 204);
  });
}

/**
 * Routes de partage (S3b, contrat « Social v3 ») sous `/user/social/*` : partage à des amis (`/share`), liens publics
 * (`/share-links`, GET public), listes partagées (`/lists`). Profil agissant et contrôle d'accès comme les autres routes v2
 * (`actorOf`). Le lien public sert l'app sur `/t/:code` : c'est le repli de l'interface (ui.ts), rien à ajouter ici.
 */

type ShareInput = z.infer<typeof shareSchema>;

/** Contenu du message de partage : le titre ou le moment, cohérent avec `kind`. */
function shareMessage(input: ShareInput): { kind: 'title' | 'moment'; body: string; title?: NonNullable<ShareInput['title']>; moment?: NonNullable<ShareInput['moment']> } {
  if (input.kind === 'title') {
    if (input.title === undefined) throw invalid(['title:required']);
    if (input.moment !== undefined) throw invalid(['moment:kind_mismatch']);
    return { kind: 'title', body: '', title: input.title };
  }
  if (input.moment === undefined) throw invalid(['moment:required']);
  if (input.title !== undefined) throw invalid(['title:kind_mismatch']);
  return { kind: 'moment', body: '', moment: input.moment };
}

/** Retire les clés à `undefined` (un champ facultatif absent n'est pas une valeur). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function invalid(issues: string[]): UserApiError {
  return new UserApiError(400, 'invalid_body', issues);
}

/** Erreur HTTP d'une écriture de liste refusée (le résultat `ok` est traité par l'appelant). */
function listFailure(result: string): UserApiError {
  switch (result) {
    case 'owner_only':
      return new UserApiError(403, 'owner_only');
    case 'unknown':
      return new UserApiError(404, 'profile_not_found');
    case 'not_friend':
      return new UserApiError(403, 'not_friend');
    case 'too_many_members':
      return new UserApiError(409, 'too_many_members');
    case 'list_limit_reached':
      return new UserApiError(429, 'list_limit_reached');
    case 'list_full':
      return new UserApiError(409, 'list_full');
    case 'item_exists':
      return new UserApiError(409, 'item_exists');
    case 'item_not_found':
      return new UserApiError(404, 'item_not_found');
    default:
      return new UserApiError(404, 'list_not_found');
  }
}

function registerShareRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const socialV2 = () => backend.socialV2();
  const store = () => backend.socialV3();
  const actor = (c: Ctx) => actorOf(c, users(), socialV2(), deps.secret);

  /** Diffuse une modification de liste à son audience (membres avant et après la modification). */
  const announceList = (audience: readonly string[], listId: string): void => {
    emitSocialEvent(deps.socialEvents, audience, { t: 'list', listId });
  };

  /** Identifiant de liste d'une URL : mal formé équivaut à une liste inconnue. */
  const listIdOf = (c: Ctx): string => {
    const id = String(c.req.param('id'));
    if (!LIST_ID.test(id)) throw new UserApiError(404, 'list_not_found');
    return id;
  };

  // Partage multiple

  /**
   * Partage d'un titre ou d'un moment à plusieurs amis et/ou groupes : un vrai message v3 (`kind` « title » ou « moment »)
   * par destinataire, dans sa conversation (`dm:<pid>` ou `g:<id>`). `to` : `{ pid }` ou `{ group }`. 201 `{ messages }`.
   * Tout ou rien. 400 `self` / `no_recipient` / `invalid_body`, 404 `profile_not_found` / `conv_not_found`, 403 `not_friend` /
   * `not_allowed` (rien n'est envoyé), 429 `rate_limited`. Mêmes règles d'accès, de blocage et de `messagesFrom` que /conv/*.
   */
  router.post('/social/share', async (c) => {
    const me = await actor(c);
    const input = parseWith(shareSchema, c.get('body'));
    const message = shareMessage(input);
    const text = cleanConvBody(input.kind, input.body ?? '');
    if (text.issues.length > 0) throw invalid(text.issues);
    // Texte du message (repli lisible) : la légende saisie, sinon le titre partagé.
    const body = text.body !== '' ? text.body : (message.title ?? message.moment)?.title ?? '';
    const scopes: ConvScope[] = [];
    const seen = new Set<string>();
    for (const target of input.to) {
      const scope: ConvScope = 'pid' in target ? { kind: 'dm', peer: target.pid } : { kind: 'group', id: target.group };
      if (!seen.has(convKey(scope))) {
        seen.add(convKey(scope));
        scopes.push(scope);
      }
    }
    if (scopes.length === 0) throw new UserApiError(400, 'no_recipient');
    const outcome = await socialV2().shareConv(me.pid, scopes, { ...message, body }, Date.now());
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'sent') {
      throw convError(outcome.scope, outcome.result);
    }
    for (const entry of outcome.sent) {
      for (const notice of entry.notices) emitSocialEvent(deps.socialEvents, [notice.pid], { t: 'message', message: notice.payload });
    }
    return sendJson(c, { messages: outcome.sent.map((entry) => entry.message) }, 201);
  });

  // Liens publics

  /**
   * Crée un lien public vers un titre (ou un moment si `pos` est donné). `title` facultatif : sans lui, le titre de l'index
   * des fiches. `withInvite` réserve un emplacement d'invitation libre du compte (consommé seulement à l'inscription).
   * 201 `{ url, code, inviteCode? }` ; 429 `invite_quota_reached` si plus d'emplacement, 429 `rate_limited` (30 liens par heure
   * et par profil, compté en base), 400 `title_required`. Un lien expire au bout de 30 jours.
   */
  router.post('/social/share-links', async (c) => {
    const me = await actor(c);
    const input = parseWith(shareLinkSchema, c.get('body'));
    // Une invitation réservée appartient au compte (parrainage) : refusée depuis une session verrouillée sur un profil invité.
    if (input.withInvite && me.lockedProfileId !== null) throw new UserApiError(403, 'profile_locked');
    const note = cleanShareNote(input.note);
    if (note.issues.length > 0) throw invalid(note.issues);
    const title = input.title ?? (await store().titleOfMedia(input.type, input.tmdbId));
    if (title === undefined) throw new UserApiError(400, 'title_required');
    const outcome = await store().createShareLink(
      me.accountId,
      me.pid,
      defined({
        type: input.type,
        tmdbId: input.tmdbId,
        title,
        poster: input.poster,
        pos: input.pos,
        note: note.note,
        withInvite: input.withInvite,
      }),
      Date.now(),
    );
    if (outcome.result === 'invite_quota_reached') throw new UserApiError(429, 'invite_quota_reached');
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    const url = `${new URL(c.req.url).origin}/t/${outcome.code}`;
    return sendJson(c, defined({ url, code: outcome.code, inviteCode: outcome.inviteCode }), 201);
  });

  /**
   * Lien public, sans session : `{ type, tmdbId, title, poster?, pos?, from: { handle, avatarColor }, note?, inviteCode? }`.
   * Aucun pid de l'auteur, aucune bibliothèque ; `pos` seulement pour un moment, `inviteCode` seulement tant qu'il est libre.
   * 404 `share_not_found` ; 410 `expired` au-delà de 30 jours ; 429 `rate_limited` par adresse IP (60 par minute, compté en
   * base) ; 400 `ip_required` si l'adresse du client est inconnue (les requêtes sans adresse ne sont pas mutualisées).
   */
  router.get('/social/share-links/:code', async (c) => {
    const ip = c.get('ip');
    if (ip === undefined || ip === '') throw new UserApiError(400, 'ip_required');
    const now = Date.now();
    const retryAfterSec = await store().consumePublicRead(ip, now);
    if (retryAfterSec !== undefined) throw new UserApiError(429, 'rate_limited', undefined, retryAfterSec);
    const code = String(c.req.param('code'));
    if (!SHARE_CODE.test(code)) throw new UserApiError(404, 'share_not_found');
    const view = await store().shareLinkByCode(code, now);
    if (view === undefined) throw new UserApiError(404, 'share_not_found');
    if (view === 'expired') throw new UserApiError(410, 'expired');
    return sendJson(c, view);
  });

  /**
   * Mes liens publics (profil agissant) : `{ links: [{ code, url, type, tmdbId, title, poster?, pos?, note?, inviteCode?,
   * createdAt, expiresAt, expired }] }`, les plus récents d'abord, expirés compris (`expired: true`).
   */
  router.get('/social/share-links', async (c) => {
    const me = await actor(c);
    const origin = new URL(c.req.url).origin;
    const links = await store().ownShareLinks(me.pid, Date.now());
    return sendJson(c, { links: links.map((link) => ({ ...link, url: `${origin}/t/${link.code}` })) });
  });

  /** Supprime mon lien public `:code` et libère l'invitation qu'il réservait. 204 ; 404 `share_not_found` (inconnu ou pas de moi). */
  router.delete('/social/share-links/:code', async (c) => {
    const me = await actor(c);
    const code = String(c.req.param('code'));
    if (!SHARE_CODE.test(code) || !(await store().deleteShareLink(me.pid, code))) throw new UserApiError(404, 'share_not_found');
    return sendEmpty(c, 204);
  });

  // Listes partagées

  /** Listes où je suis membre : `{ lists: [{ id, name, members, count }] }`, les plus récentes d'abord. */
  router.get('/social/lists', async (c) => {
    const me = await actor(c);
    return sendJson(c, { lists: await store().listsOf(me.pid, Date.now()) });
  });

  /**
   * Crée une liste (je suis propriétaire) avec des amis membres. 201 : la liste (`{ id, name, members, items }`).
   * 403 `not_friend`, 404 `profile_not_found`, 429 `list_limit_reached` (50 listes possédées), 429 `rate_limited` (10 créations
   * par heure et par profil).
   */
  router.post('/social/lists', async (c) => {
    const me = await actor(c);
    const input = parseWith(listCreateSchema, c.get('body'));
    const outcome = await store().createList(me.pid, input.name, input.members ?? [], Date.now());
    if (outcome.result === 'rate_limited') throw new UserApiError(429, 'rate_limited', undefined, outcome.retryAfterSec);
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, outcome.list.id);
    return sendJson(c, outcome.list, 201);
  });

  /** Une liste où je suis membre : `{ id, name, members, items }`. 404 `list_not_found` sinon (même réponse pour une liste absente). */
  router.get('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const list = await store().listDetail(me.pid, listIdOf(c), Date.now());
    if (list === undefined) throw new UserApiError(404, 'list_not_found');
    return sendJson(c, list);
  });

  /**
   * Renomme et change les membres (propriétaire seulement) : `{ name?, add?: pid[], remove?: pid[] }`. Un membre ajouté doit être
   * ami. 200 : la liste. 403 `owner_only`, 403 `not_friend`, 409 `too_many_members`.
   */
  router.put('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const input = parseWith(listUpdateSchema, c.get('body'));
    const patch = defined({ name: input.name, add: input.add, remove: input.remove });
    const outcome = await store().updateList(me.pid, id, patch, Date.now());
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendJson(c, outcome.list);
  });

  /** Supprime une liste (propriétaire seulement). 204. */
  router.delete('/social/lists/:id', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const outcome = await store().deleteList(me.pid, id);
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendEmpty(c, 204);
  });

  /** Ajoute un titre à la liste (tout membre). 201 `{ item }` ; 409 `item_exists`, 409 `list_full`. */
  router.post('/social/lists/:id/items', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const input = parseWith(listItemSchema, c.get('body'));
    const outcome = await store().addItem(me.pid, id, defined({ type: input.type, tmdbId: input.tmdbId, title: input.title, poster: input.poster }), Date.now());
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    // Activité « listed » : un événement par titre et par jour, titre et affiche de la liste.
    await recordActivityOf(
      backend,
      deps,
      me.pid,
      'listed',
      { type: input.type, tmdbId: input.tmdbId },
      defined({ title: input.title, poster: input.poster }),
      Date.now(),
    );
    return sendJson(c, { item: outcome.item }, 201);
  });

  /** Retire un titre de la liste (tout membre). 204 ; 404 `item_not_found`. */
  router.delete('/social/lists/:id/items/:type/:tmdbId', async (c) => {
    const me = await actor(c);
    const id = listIdOf(c);
    const key = listItemKeySchema.safeParse({ type: c.req.param('type'), tmdbId: c.req.param('tmdbId') });
    if (!key.success) throw new UserApiError(404, 'item_not_found');
    const outcome = await store().removeItem(me.pid, id, key.data.type, key.data.tmdbId);
    if (outcome.result !== 'ok') throw listFailure(outcome.result);
    announceList(outcome.audience, id);
    return sendEmpty(c, 204);
  });
}

/** Routes sociales v3 : préférences et relations (S2), conversations riches et groupes (S3a), partage et listes (S3b). */
export function registerSocialV3Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  registerPrefsRoutes(router, deps, backend);
  registerConvRoutes(router, deps, backend);
  registerShareRoutes(router, deps, backend);
}
