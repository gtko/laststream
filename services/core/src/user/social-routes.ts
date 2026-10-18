import type { App } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { nowIso, scopeOf, sessionOf } from './session.js';
import { MAX_HIDDEN_PER_PROFILE, type WatchingNow } from './social-store.js';
import {
  bulkVisibilitySchema,
  friendLibraryQuery,
  friendRequestSchema,
  hiddenKeyParam,
  hiddenQuery,
  hiddenRemoveSchema,
  hiddenWriteSchema,
  inviteCodeQuery,
  inviteQuotaSchema,
  inviteSentSchema,
  presenceSchema,
  usernameParam,
  visibilitySchema,
} from './social-validation.js';
import { titleRef } from './store.js';
import { mediaTypeSchema, parseWith, tmdbIdParam, titleIdParam, UserApiError } from './validation.js';

/**
 * Routes sociales de l'API /user : liens de parrainage, amis, présence, visibilité de la bibliothèque, titres masqués.
 * Toutes exigent une session ; les routes par profil exigent aussi le déverrouillage du profil (PIN) comme le reste.
 */
export function registerSocialRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const social = () => backend.social();

  // Parrainage

  /** Les liens du compte (créés à la volée jusqu'au quota) : code, état libre / envoyé / utilisé, pseudo du filleul. */
  router.get('/invites', async (c) => {
    const { account } = await sessionOf(users(), c);
    return sendJson(c, await social().listInvites(account.id, nowIso()));
  });

  /** Vérifie un lien avant l'inscription (sans session) : `{ valid, inviter }`. */
  router.get('/invites/check', async (c) => {
    const { code } = parseWith(inviteCodeQuery, queryParams(c));
    return sendJson(c, await social().inviteInfo(code));
  });

  router.put('/invites/:id/sent', async (c) => {
    const { account } = await sessionOf(users(), c);
    const { sent } = parseWith(inviteSentSchema, c.get('body'));
    const result = await social().setInviteSent(account.id, String(c.req.param('id')), sent, nowIso());
    if (result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result === 'used') throw new UserApiError(409, 'invite_used');
    return sendEmpty(c, 204);
  });

  /** Révoque un lien non utilisé : l'ancien code est mort, l'emplacement reçoit un nouveau lien libre. */
  router.delete('/invites/:id', async (c) => {
    const { account } = await sessionOf(users(), c);
    const result = await social().revokeInvite(account.id, String(c.req.param('id')), nowIso());
    if (result.result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result.result === 'used') throw new UserApiError(409, 'invite_used');
    if (result.result !== 'ok') throw new UserApiError(404, 'invite_not_found');
    return sendJson(c, { invite: result.invite });
  });

  /** Quota de liens d'un compte : propriétaire uniquement. */
  router.put('/accounts/:username/invite-quota', async (c) => {
    const { account } = await sessionOf(users(), c);
    if (!account.isOwner) throw new UserApiError(403, 'owner_only');
    const username = parseWith(usernameParam, c.req.param('username'));
    const { quota } = parseWith(inviteQuotaSchema, c.get('body'));
    const updated = await social().setInviteQuota(username, quota);
    if (updated === undefined) throw new UserApiError(404, 'account_not_found');
    return sendJson(c, updated);
  });

  // Amis

  /** `{ friends, incoming, outgoing }` : amis avec statut (online / watching / offline), demandes reçues et envoyées. */
  router.get('/friends', async (c) => {
    const { account } = await sessionOf(users(), c);
    return sendJson(c, await social().listFriends(account.id, nowIso()));
  });

  /** Demande par pseudo exact. Si la personne avait déjà demandé, l'amitié est acceptée (`status: accepted`). */
  router.post('/friends/requests', async (c) => {
    const { account } = await sessionOf(users(), c);
    const { username } = parseWith(friendRequestSchema, c.get('body'));
    const result = await social().requestFriend(account.id, username, nowIso());
    switch (result) {
      case 'not_found':
        throw new UserApiError(404, 'user_not_found');
      case 'self':
        throw new UserApiError(400, 'cannot_befriend_self');
      case 'already_friends':
        throw new UserApiError(409, 'already_friends');
      case 'already_pending':
        throw new UserApiError(409, 'request_pending');
      case 'limit_reached':
        throw new UserApiError(429, 'friend_limit_reached');
      default:
        return sendJson(c, { status: result }, result === 'sent' ? 201 : 200);
    }
  });

  router.post('/friends/requests/:username/accept', async (c) => {
    const { account } = await sessionOf(users(), c);
    const username = parseWith(usernameParam, c.req.param('username'));
    const result = await social().acceptFriend(account.id, username, nowIso());
    if (result === 'not_found') throw new UserApiError(404, 'request_not_found');
    if (result === 'limit_reached') throw new UserApiError(429, 'friend_limit_reached');
    return sendEmpty(c, 204);
  });

  /** Refuse une demande reçue ou annule une demande envoyée. */
  router.delete('/friends/requests/:username', async (c) => {
    const { account } = await sessionOf(users(), c);
    const username = parseWith(usernameParam, c.req.param('username'));
    if (!(await social().declineFriend(account.id, username))) throw new UserApiError(404, 'request_not_found');
    return sendEmpty(c, 204);
  });

  router.delete('/friends/:username', async (c) => {
    const { account } = await sessionOf(users(), c);
    const username = parseWith(usernameParam, c.req.param('username'));
    if (!(await social().removeFriend(account.id, username))) throw new UserApiError(404, 'friend_not_found');
    return sendEmpty(c, 204);
  });

  /** Bibliothèque visible d'un ami (titres en visibilité « friends » des profils non enfants), paginée. */
  router.get('/friends/:username/library', async (c) => {
    const { account } = await sessionOf(users(), c);
    const username = parseWith(usernameParam, c.req.param('username'));
    const query = parseWith(friendLibraryQuery, queryParams(c));
    const page = await social().friendLibrary(account.id, username, query.type, query.limit, query.offset);
    // Même réponse pour un pseudo inconnu et pour un inconnu non ami : on ne révèle pas l'existence des comptes.
    if (page === undefined) throw new UserApiError(404, 'friend_not_found');
    return sendJson(c, { ...page, limit: query.limit, offset: query.offset });
  });

  // Présence

  /**
   * Battement de cœur léger (toutes les 30 à 60 s) : « en ligne » pendant 90 s, avec le titre en cours si `watching`.
   * Un profil enfant n'annonce jamais de titre. `invisible: true` apparaît hors ligne.
   */
  router.put('/presence', async (c) => {
    const { account } = await sessionOf(users(), c);
    const body = parseWith(presenceSchema, c.get('body'));
    let profileId: string | null = null;
    let watching: WatchingNow | null = null;
    if (body.profileId !== undefined) {
      const profile = await users().findProfile(account.id, body.profileId);
      if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
      profileId = profile.id;
      if (!profile.isKid && body.watching != null) {
        if (body.watching.tmdbId === undefined && body.watching.imdbId === undefined) {
          throw new UserApiError(400, 'invalid_body', ['watching:tmdbId_ou_imdbId_requis']);
        }
        watching = {
          type: body.watching.type,
          tmdbId: body.watching.tmdbId ?? null,
          imdbId: body.watching.imdbId ?? null,
          title: body.watching.title,
          season: body.watching.type === 'series' ? (body.watching.season ?? null) : null,
          episode: body.watching.type === 'series' ? (body.watching.episode ?? null) : null,
        };
      }
    }
    await social().setPresence(account.id, profileId, watching, body.invisible, nowIso());
    return sendEmpty(c, 204);
  });

  /** Se déclarer hors ligne (fermeture de l'application). */
  router.delete('/presence', async (c) => {
    const { account } = await sessionOf(users(), c);
    await social().clearPresence(account.id);
    return sendEmpty(c, 204);
  });

  // Visibilité de la bibliothèque (privée par défaut ; les profils enfants ne partagent rien)

  router.put('/profiles/:id/library/visibility', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const body = parseWith(bulkVisibilitySchema, c.get('body'));
    if (profile.isKid && body.visibility === 'friends') throw new UserApiError(403, 'kid_profile');
    return sendJson(c, { updated: await social().setAllLibraryVisibility(profile.id, body.type, body.visibility) });
  });

  router.put('/profiles/:id/library/:type/:itemId/visibility', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const type = parseWith(mediaTypeSchema, c.req.param('type'));
    const itemId = parseWith(titleIdParam, c.req.param('itemId'));
    const { visibility } = parseWith(visibilitySchema, c.get('body'));
    if (profile.isKid && visibility === 'friends') throw new UserApiError(403, 'kid_profile');
    const ref = itemId.startsWith('tt') ? titleRef(null, itemId) : titleRef(parseWith(tmdbIdParam, itemId), null);
    if (!(await social().setLibraryVisibility(profile.id, type, ref, visibility))) throw new UserApiError(404, 'library_item_not_found');
    return sendEmpty(c, 204);
  });

  // Titres masqués (table par profil ; remplace les réglages homeHidden0..11)

  /**
   * `{ items, total, nextCursor }` : du plus récent au plus ancien. `?q=` filtre par titre, `?limit=` (500 au plus),
   * `?cursor=` reprend après `nextCursor`. Au premier accès, les anciens morceaux de réglages sont importés.
   */
  router.get('/profiles/:id/hidden', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const query = parseWith(hiddenQuery, queryParams(c));
    return sendJson(c, await social().listHidden(profile.id, { q: query.q, limit: query.limit, cursor: query.cursor }, nowIso()));
  });

  /** Masque des titres (500 par appel, 20 000 par profil) ; un titre déjà masqué garde sa date. */
  router.put('/profiles/:id/hidden', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const body = parseWith(hiddenWriteSchema, c.get('body'));
    const now = Date.now();
    const total = await social().hideTitles(
      profile.id,
      body.entries.map((entry) => ({ key: entry.key, title: entry.title, poster: entry.poster, addedAt: entry.addedAt ?? now })),
      nowIso(),
    );
    if (total === null) throw new UserApiError(409, 'hidden_limit_reached', [`max:${MAX_HIDDEN_PER_PROFILE}`]);
    return sendJson(c, { total });
  });

  /** Réaffiche des titres (500 clés par appel). */
  router.post('/profiles/:id/hidden/remove', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const { keys } = parseWith(hiddenRemoveSchema, c.get('body'));
    return sendJson(c, { removed: await social().unhideTitles(profile.id, keys, nowIso()) });
  });

  router.delete('/profiles/:id/hidden/:key', async (c) => {
    const { profile } = await scopeOf(users(), c, deps.secret, true);
    const key = parseWith(hiddenKeyParam, c.req.param('key'));
    await social().unhideTitles(profile.id, [key], nowIso());
    return sendEmpty(c, 204);
  });
}
