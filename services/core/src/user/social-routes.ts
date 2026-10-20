import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import type { UserBackend } from './repo.js';
import { assertNotLocked, nowIso, scopeOf, sessionOf } from './session.js';
import { MAX_HIDDEN_PER_PROFILE } from './social-store.js';
import {
  bulkVisibilitySchema,
  friendLibraryQuery,
  hiddenQuery,
  hiddenRemoveSchema,
  hiddenWriteSchema,
  inviteCodeQuery,
  inviteQuotaSchema,
  inviteSentSchema,
  inviteTicketSchema,
  usernameParam,
  visibilitySchema,
} from './social-validation.js';
import { titleRef } from './store.js';
import { mediaTypeSchema, parseWith, tmdbIdParam, titleIdParam, UserApiError } from './validation.js';

/**
 * Routes sociales de l'API /user : liens de parrainage, bibliothèque d'un ami (par pseudo), visibilité de la bibliothèque, titres masqués.
 * Toutes exigent une session ; les routes par profil exigent aussi le déverrouillage du profil (PIN) comme le reste.
 */
export function registerSocialRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const social = () => backend.social();

  /**
   * Session d'un compte, sans verrou : le parrainage et les amis sont au niveau du compte. Une session verrouillée sur un
   * profil invité reçoit 403 profile_locked (les routes sociales au niveau profil, elles, restent ouvertes à ce profil).
   */
  const openAccountSession = async (c: Ctx) => {
    const session = await sessionOf(users(), c);
    assertNotLocked(session);
    return session;
  };

  // Parrainage

  /** Les liens du compte (créés à la volée jusqu'au quota) : code, état libre / envoyé / utilisé, pseudo du filleul. */
  router.get('/invites', async (c) => {
    const { account } = await openAccountSession(c);
    return sendJson(c, await social().listInvites(account.id, nowIso()));
  });

  /**
   * Vérifie un lien avant l'inscription (sans session) : `{ valid: true, inviter, message, picks, expiresAt, number }`, ou
   * `{ valid: false, reason }` (`expired`, `used`, `revoked`, `unknown`).
   */
  router.get('/invites/check', async (c) => {
    const { code } = parseWith(inviteCodeQuery, queryParams(c));
    return sendJson(c, await social().inviteInfo(code, nowIso()));
  });

  /**
   * Message (280 caractères au plus) et coups de cœur (3 au plus) d'un billet du propriétaire ; un champ absent reste
   * inchangé, `''` ou `[]` efface. 409 `invite_used` si le billet est utilisé.
   */
  router.put('/invites/:id', async (c) => {
    const { account } = await openAccountSession(c);
    const body = parseWith(inviteTicketSchema, c.get('body'));
    const result = await social().updateTicket(account.id, String(c.req.param('id')), body);
    if (result.result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result.result === 'used') throw new UserApiError(409, 'invite_used');
    return sendJson(c, { invite: result.invite });
  });

  /** Marque le billet « envoyé » : l'échéance est posée à maintenant + 14 jours. `sent: false` le remet libre. */
  router.put('/invites/:id/sent', async (c) => {
    const { account } = await openAccountSession(c);
    const { sent } = parseWith(inviteSentSchema, c.get('body'));
    const result = await social().setInviteSent(account.id, String(c.req.param('id')), sent, nowIso());
    if (result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result === 'used') throw new UserApiError(409, 'invite_used');
    return sendEmpty(c, 204);
  });

  /**
   * Régénère un lien non utilisé : l'ancien code est mort, l'emplacement reçoit un nouveau lien libre. 409 si le lien a été
   * révoqué par l'administration (il ne se régénère pas).
   */
  router.delete('/invites/:id', async (c) => {
    const { account } = await openAccountSession(c);
    const result = await social().revokeInvite(account.id, String(c.req.param('id')), nowIso());
    if (result.result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result.result === 'used') throw new UserApiError(409, 'invite_used');
    if (result.result === 'revoked') throw new UserApiError(409, 'invite_revoked');
    if (result.result !== 'ok') throw new UserApiError(404, 'invite_not_found');
    return sendJson(c, { invite: result.invite });
  });

  /** Quota de liens d'un compte : propriétaire uniquement. */
  router.put('/accounts/:username/invite-quota', async (c) => {
    const session = await sessionOf(users(), c);
    assertNotLocked(session);
    const { account } = session;
    if (!account.isOwner) throw new UserApiError(403, 'owner_only');
    const username = parseWith(usernameParam, c.req.param('username'));
    const { quota } = parseWith(inviteQuotaSchema, c.get('body'));
    const updated = await social().setInviteQuota(username, quota);
    if (updated === undefined) throw new UserApiError(404, 'account_not_found');
    return sendJson(c, updated);
  });

  // Amis : les listes, demandes et présence passent par /user/social (v2, par pid) ; seule la lecture de bibliothèque
  // par pseudo reste, tant que l'app déployée l'appelle (à retirer après déploiement de l'app, voir docs/social.md).

  /** Bibliothèque visible d'un ami (titres en visibilité « friends » des profils non enfants), paginée. */
  router.get('/friends/:username/library', async (c) => {
    const { account } = await openAccountSession(c);
    const username = parseWith(usernameParam, c.req.param('username'));
    const query = parseWith(friendLibraryQuery, queryParams(c));
    const page = await social().friendLibrary(account.id, username, query.type, query.limit, query.offset);
    // Même réponse pour un pseudo inconnu et pour un inconnu non ami : on ne révèle pas l'existence des comptes.
    if (page === undefined) throw new UserApiError(404, 'friend_not_found');
    return sendJson(c, { ...page, limit: query.limit, offset: query.offset });
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
}
