import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { signLiveTicket } from '../party/ticket.js';
import { createRateLimiter } from '../rate-limit.js';
import { parseHandle } from './social-handles.js';
import type { SocialV2Repo, UserBackend, UserRepo } from './repo.js';
import { assertProfileAccess, assertUnlocked, sessionOf } from './session.js';
import { friendLibraryQuery } from './social-validation.js';
import { emitSocialEvent } from './social-v2-events.js';
import { SOCIAL_LIVE_PATH } from './social-v2-live.js';
import type { FriendView, PresenceChange } from './social-v2-store.js';
import { historyQuerySchema, isPid, presenceSchema, requestSchema, statusSchema } from './social-v2-validation.js';
import { parseWith, UserApiError } from './validation.js';

/**
 * Routes sociales v2, montées sous `/user` : `/social/*` (contrat « Social v2 », docs/social-v2-contract.md).
 * Profil agissant : en-tête `X-Profile-Id` (convention de /user), qui doit appartenir au compte. Un profil protégé par PIN
 * exige en plus `X-Profile-Token`. Un profil enfant n'a aucune route sociale (403). Les routes du lot suivant (messages,
 * notes, live) s'ajoutent dans ce module ou dans un module voisin, en réutilisant `actorOf`.
 */

/** Profil agissant résolu pour une requête sociale. */
export interface Actor {
  accountId: string;
  /** Identifiant public du profil : le seul exposé aux autres comptes. */
  pid: string;
  handle: { name: string; tag: string; full: string };
  avatarColor: string;
  /** Profil auquel la session est verrouillée (invitation du foyer) : seul ce profil agit, sinon null. */
  lockedProfileId: string | null;
}

/**
 * Session et profil agissant (`X-Profile-Id`). Erreurs : 400 `profile_required` (en-tête absent), 404 `profile_not_found`,
 * 403 `kid_profile` (profil enfant), 403 `pin_required` (PIN non déverrouillé), 403 `profile_locked` (session verrouillée
 * sur un autre profil que celui de l'en-tête).
 */
export async function actorOf(c: Ctx, users: UserRepo, social: SocialV2Repo, secret: string): Promise<Actor> {
  const session = await sessionOf(users, c);
  const profileId = c.req.header('x-profile-id');
  if (profileId === undefined || profileId === '') throw new UserApiError(400, 'profile_required');
  assertProfileAccess(session, profileId);
  const profile = await users.findProfile(session.account.id, profileId);
  if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
  if (profile.isKid) throw new UserApiError(403, 'kid_profile');
  // Session verrouillée sur ce profil : pas de PIN à saisir (même règle que scopeOf).
  if (session.lockedProfileId === null) assertUnlocked(c, session, profile, secret);
  const identity = await social.identityOf(session.account.id, profile.id);
  if (identity === undefined || identity.pid === null || identity.handle === null) throw new UserApiError(404, 'profile_not_found');
  return {
    accountId: session.account.id,
    pid: identity.pid,
    handle: identity.handle,
    avatarColor: profile.avatarColor,
    lockedProfileId: session.lockedProfileId,
  };
}

/** Pid d'un paramètre de route. Un pid mal formé équivaut à un pid inconnu. */
export function pidParam(raw: string, notFound: string): string {
  if (!isPid(raw)) throw new UserApiError(404, notFound);
  return raw;
}

/** Tickets du flux temps réel délivrés par profil et par minute (au-delà : 429). */
const LIVE_TICKETS_PER_MINUTE = 20;
/** Demandes d'ami envoyées par profil et par heure (au-delà : 429 `rate_limited`). */
const FRIEND_REQUESTS_PER_HOUR = 20;

export function registerSocialV2Routes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const social = () => backend.socialV2();
  const actor = (c: Ctx) => actorOf(c, users(), social(), deps.secret);
  const liveTickets = createRateLimiter(LIVE_TICKETS_PER_MINUTE, 60_000);
  const friendRequests = createRateLimiter(FRIEND_REQUESTS_PER_HOUR, 3_600_000);

  /** Diffuse un changement de présence : une trame par vue distincte (préférences du profil vu appliquées par le store). */
  const announcePresence = (change: PresenceChange | undefined): void => {
    for (const delivery of change?.deliveries ?? []) {
      emitSocialEvent(deps.socialEvents, delivery.pids, { t: 'presence', friend: delivery.friend });
    }
  };

  /** Vue d'un ami (ou du foyer) telle que `viewer` la reçoit. Le lien vient d'être créé : absence = incohérence, 404. */
  const friendViewFor = async (viewer: string, subject: string): Promise<FriendView> => {
    const view = await social().friendViewOf(viewer, subject, Date.now());
    if (view === undefined) throw new UserApiError(404, 'friend_not_found');
    return view;
  };

  // Moi

  /** `{ pid, handle, status, avatarColor }` : le profil agissant et son statut choisi. */
  router.get('/social/me', async (c) => {
    const me = await actor(c);
    return sendJson(c, { pid: me.pid, handle: me.handle, status: await social().statusOf(me.pid), avatarColor: me.avatarColor });
  });

  /** Statut choisi (`online`, `away`, `dnd`, `invisible`). Diffusé aux amis et au foyer si la présence visible change. */
  router.put('/social/status', async (c) => {
    const me = await actor(c);
    const { status } = parseWith(statusSchema, c.get('body'));
    announcePresence(await social().setStatus(me.pid, status, Date.now()));
    return sendJson(c, { status });
  });

  // Amis et foyer

  /** `{ friends, household, incoming, outgoing }` vus depuis le profil agissant. */
  router.get('/social/friends', async (c) => {
    const me = await actor(c);
    return sendJson(c, await social().listFriends(me.pid, Date.now()));
  });

  /**
   * Demande par handle exact. 201 `{ request }` ; 200 `{ friend }` si l'autre avait déjà demandé (demande croisée).
   * 404 `handle_not_found`, 400 `self`, 409 `already_friends` (foyer compris) / `already_requested`, 429 `friend_limit_reached`.
   */
  router.post('/social/requests', async (c) => {
    const me = await actor(c);
    const { handle } = parseWith(requestSchema, c.get('body'));
    const parsed = parseHandle(handle);
    if (parsed === null) throw new UserApiError(400, 'invalid_body', ['handle:format']);
    const verdict = friendRequests(me.pid);
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const outcome = await social().requestFriend(me.pid, parsed.key, parsed.tag, Date.now());
    if (outcome.result === 'not_found') throw new UserApiError(404, 'handle_not_found');
    if (outcome.result === 'self') throw new UserApiError(400, 'self');
    if (outcome.result === 'already_friends') throw new UserApiError(409, 'already_friends');
    if (outcome.result === 'already_requested') throw new UserApiError(409, 'already_requested');
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'friend_limit_reached');
    if (outcome.result === 'accepted') {
      const toOther = await friendViewFor(outcome.other.pid, me.pid);
      const toMe = await friendViewFor(me.pid, outcome.other.pid);
      emitSocialEvent(deps.socialEvents, [outcome.other.pid], { t: 'friend', friend: toOther });
      emitSocialEvent(deps.socialEvents, [me.pid], { t: 'friend', friend: toMe });
      return sendJson(c, { friend: toMe }, 200);
    }
    emitSocialEvent(deps.socialEvents, [outcome.outgoing.pid], { t: 'request', request: outcome.incoming });
    return sendJson(c, { request: outcome.outgoing }, 201);
  });

  /** Accepte une demande reçue de `:pid`. `{ friend }`. */
  router.post('/social/requests/:pid/accept', async (c) => {
    const me = await actor(c);
    const otherPid = pidParam(String(c.req.param('pid')), 'request_not_found');
    const outcome = await social().acceptRequest(me.pid, otherPid, Date.now());
    if (outcome.result === 'not_found') throw new UserApiError(404, 'request_not_found');
    if (outcome.result === 'limit_reached') throw new UserApiError(429, 'friend_limit_reached');
    const toOther = await friendViewFor(outcome.other.pid, me.pid);
    const toMe = await friendViewFor(me.pid, outcome.other.pid);
    emitSocialEvent(deps.socialEvents, [outcome.other.pid], { t: 'friend', friend: toOther });
    emitSocialEvent(deps.socialEvents, [me.pid], { t: 'friend', friend: toMe });
    return sendJson(c, { friend: toMe });
  });

  /**
   * Refuse une demande reçue ou annule une demande envoyée au profil `:pid`. 204. L'autre profil, s'il est connecté, reçoit
   * `unfriend` avec mon pid pour retirer la demande de sa liste.
   */
  router.delete('/social/requests/:pid', async (c) => {
    const me = await actor(c);
    const otherPid = pidParam(String(c.req.param('pid')), 'request_not_found');
    if (!(await social().declineRequest(me.pid, otherPid))) throw new UserApiError(404, 'request_not_found');
    emitSocialEvent(deps.socialEvents, [otherPid], { t: 'unfriend', pid: me.pid });
    return sendEmpty(c, 204);
  });

  /** Retire un ami. 204. Le foyer ne se retire pas. */
  router.delete('/social/friends/:pid', async (c) => {
    const me = await actor(c);
    const otherPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    if (!(await social().removeFriend(me.pid, otherPid))) throw new UserApiError(404, 'friend_not_found');
    emitSocialEvent(deps.socialEvents, [otherPid], { t: 'unfriend', pid: me.pid });
    emitSocialEvent(deps.socialEvents, [me.pid], { t: 'unfriend', pid: otherPid });
    return sendEmpty(c, 204);
  });

  /**
   * Bibliothèque d'un ami ou d'un membre du foyer : `{ items, total, limit, offset }`. Un ami ne voit que les titres en
   * visibilité « friends ». Un profil sans lien (ou enfant, ou inconnu) reçoit le même 404 `friend_not_found`.
   */
  router.get('/social/friends/:pid/library', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const query = parseWith(friendLibraryQuery, queryParams(c));
    const page = await social().friendLibrary(me.pid, targetPid, query.type, query.limit, query.offset);
    if (page === undefined) throw new UserApiError(404, 'friend_not_found');
    return sendJson(c, { ...page, limit: query.limit, offset: query.offset });
  });

  /** Historique récent d'un ami ou d'un membre du foyer : `{ items }`, du plus récent au plus ancien (`?limit=`, 50 au plus). */
  router.get('/social/friends/:pid/history', async (c) => {
    const me = await actor(c);
    const targetPid = pidParam(String(c.req.param('pid')), 'friend_not_found');
    const query = parseWith(historyQuerySchema, queryParams(c));
    const outcome = await social().friendHistory(me.pid, targetPid, query.limit);
    if (outcome.result === 'unknown') throw new UserApiError(404, 'friend_not_found');
    if (outcome.result === 'hidden') throw new UserApiError(403, 'hidden');
    return sendJson(c, { items: outcome.items });
  });

  // Présence

  /**
   * Battement de cœur (toutes les 30 s environ, et à chaque lecture / pause / changement de média) : `watching` absent
   * ou `null` = en ligne. Hors ligne sans nouveau battement pendant 90 s. 204.
   */
  router.put('/social/presence', async (c) => {
    const me = await actor(c);
    const { watching } = parseWith(presenceSchema, c.get('body'));
    announcePresence(await social().heartbeat(me.pid, watching ?? null, Date.now()));
    return sendEmpty(c, 204);
  });

  /** Déconnexion : hors ligne immédiatement. 204. */
  router.delete('/social/presence', async (c) => {
    const me = await actor(c);
    announcePresence(await social().clearPresence(me.pid, Date.now()));
    return sendEmpty(c, 204);
  });

  // Flux temps réel

  /**
   * Ticket de 60 s pour ouvrir le flux temps réel du profil agissant : `{ wsPath }` (`/user/social/live?ticket=…`), à
   * suivre en WebSocket. Profil enfant : 403 `kid_profile`. 429 au-delà de 20 par minute et par profil.
   */
  router.post('/social/live-ticket', async (c) => {
    const me = await actor(c);
    const verdict = liveTickets(me.pid);
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const { ticket } = signLiveTicket(me.pid, me.accountId, Date.now(), deps.secret);
    return sendJson(c, { wsPath: `${SOCIAL_LIVE_PATH}?ticket=${ticket}` });
  });
}
