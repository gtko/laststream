import type { App } from '../http/app-env.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import type { AppDeps } from '../deps.js';
import { createRateLimiter } from '../rate-limit.js';
import { generateSessionToken, hashSecret, hashSessionToken } from './crypto.js';
import { isAllowedImageUrl } from './image-hosts.js';
import {
  generateHouseholdId,
  generateHouseholdToken,
  HOUSEHOLD_DEFAULT_TTL_HOURS,
  HOUSEHOLD_TOKEN_PATTERN,
  householdCheckStateOf,
  householdListSinceMs,
  householdStateOf,
  householdTtlMs,
} from './household.js';
import type { UserBackend } from './repo.js';
import { assertNotLocked, assertUnlocked, SESSION_TTL_MS, sessionOf } from './session.js';
import { householdCheckQuery, householdInviteSchema, householdRedeemSchema, LOGIN_NAME_PATTERN, parseWith, UserApiError } from './validation.js';

/** Vérification anonyme d'un lien : 30 par minute et par IP (la consommation, 10 par minute, passe par la limite « sensible »). */
const CHECK_PER_MINUTE = 30;
const LIMIT_WINDOW_MS = 60_000;
/** Mots de passe : mêmes bornes que l'inscription. */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Invitations sur un profil du foyer (contrat invitations v3, partie A). Création et gestion par un membre adulte du
 * compte ; consultation et consommation anonymes ; l'identifiant créé ouvre une session verrouillée sur le profil
 * (connexion : routes /user/login). Une session verrouillée ne gère ni les profils ni les invitations.
 * Les routes sont montées par routes.ts ; POST /household-invites/redeem est listée parmi les routes sensibles.
 */
export function registerHouseholdRoutes(router: App, deps: AppDeps, backend: UserBackend): void {
  const users = () => backend.users();
  const checkByIp = createRateLimiter(CHECK_PER_MINUTE, LIMIT_WINDOW_MS);

  /** Crée un lien pour un profil adulte non principal du compte. Le lien précédent du profil est révoqué. */
  router.post('/profiles/:id/household-invite', async (c) => {
    const store = users();
    const session = await sessionOf(store, c);
    assertNotLocked(session);
    const account = session.account;
    const target = await store.findProfile(account.id, String(c.req.param('id')));
    if (target === undefined) throw new UserApiError(404, 'profile_not_found');
    if (target.isKid) throw new UserApiError(400, 'kid_profile');
    if ((await backend.admin().mainProfileId(account.id)) === target.id) throw new UserApiError(400, 'principal_profile');
    // Créateur : un profil adulte du compte (en-tête X-Profile-Id), déverrouillé si son PIN l'exige.
    const actorId = c.req.header('x-profile-id');
    const actor = actorId === undefined ? undefined : await store.findProfile(account.id, actorId);
    if (actor === undefined || actor.isKid) throw new UserApiError(403, 'adult_profile_required');
    assertUnlocked(c, session, actor, deps.secret);
    const body = parseWith(householdInviteSchema, c.get('body'));
    const now = Date.now();
    const id = generateHouseholdId();
    const token = generateHouseholdToken();
    const expiresAt = now + householdTtlMs(body.ttlHours ?? HOUSEHOLD_DEFAULT_TTL_HOURS);
    const result = await store.createHouseholdInvite({
      id,
      tokenHash: hashSessionToken(token),
      accountId: account.id,
      profileId: target.id,
      createdByProfile: actor.id,
      createdAt: now,
      expiresAt,
    });
    if (!result.ok) throw new UserApiError(409, result.reason);
    // Le jeton clair ne sort qu'ici, une fois ; seule son empreinte est stockée.
    return sendJson(c, { id, token, expiresAt: iso(expiresAt) }, 201);
  });

  /**
   * Liens du compte créés sur les 30 derniers jours, avec leur état. `linkedProfileIds` : profils du compte qui ont déjà un
   * identifiant d'invité (sans limite de date).
   */
  router.get('/household-invites', async (c) => {
    const session = await sessionOf(users(), c);
    assertNotLocked(session);
    const now = Date.now();
    const rows = await users().listHouseholdInvites(session.account.id, householdListSinceMs(now));
    const linkedProfileIds = await users().linkedProfileIdsOf(session.account.id);
    return sendJson(c, {
      invites: rows.map((row) => ({
        id: row.id,
        profileId: row.profileId,
        profileName: row.profileName,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        state: householdStateOf(row, now),
        usedAt: row.usedAt === null ? undefined : iso(row.usedAt),
      })),
      linkedProfileIds,
    });
  });

  /**
   * Retire l'identifiant d'invité d'un profil (contrat A, « Routes ») : la connexion par cet identifiant n'est plus possible
   * et ses sessions verrouillées tombent, en une transaction. Créateur : profil adulte du compte (X-Profile-Id), déverrouillé
   * si son PIN l'exige. 404 `no_login` si le profil n'a pas d'identifiant.
   */
  router.delete('/profiles/:id/login', async (c) => {
    const store = users();
    const session = await sessionOf(store, c);
    assertNotLocked(session);
    const target = await store.findProfile(session.account.id, String(c.req.param('id')));
    if (target === undefined) throw new UserApiError(404, 'profile_not_found');
    const actorId = c.req.header('x-profile-id');
    const actor = actorId === undefined ? undefined : await store.findProfile(session.account.id, actorId);
    if (actor === undefined || actor.isKid) throw new UserApiError(403, 'adult_profile_required');
    assertUnlocked(c, session, actor, deps.secret);
    if (!(await store.deleteProfileLogin(session.account.id, target.id))) throw new UserApiError(404, 'no_login');
    return sendEmpty(c, 204);
  });

  /** Révoque un lien du compte. Un identifiant déjà créé à partir du lien reste valable. */
  router.delete('/household-invites/:id', async (c) => {
    const session = await sessionOf(users(), c);
    assertNotLocked(session);
    const result = await users().revokeHouseholdInvite(session.account.id, String(c.req.param('id')), Date.now());
    if (result === 'not_found') throw new UserApiError(404, 'invite_not_found');
    if (result === 'used') throw new UserApiError(409, 'invite_used');
    return sendEmpty(c, 204);
  });

  /** Ouverture d'un lien (anonyme) : état, profil invité, créateur et affiches. Ne consomme rien. */
  router.get('/household-invites/check', async (c) => {
    const verdict = checkByIp(c.get('ip') ?? 'inconnu');
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    const { token } = parseWith(householdCheckQuery, queryParams(c));
    const found = await users().householdInviteByTokenHash(hashSessionToken(token));
    if (found === undefined) return sendJson(c, { state: 'unknown', backdrops: [] });
    const state = householdCheckStateOf(found, Date.now());
    // Lien non utilisable (utilisé, révoqué, expiré) : seul l'état est renvoyé, ni nom, ni avatar, ni échéance.
    if (state !== 'ok') return sendJson(c, { state, backdrops: [] });
    // Affiches de la bibliothèque du créateur (12 au plus, hôtes d'image autorisés seulement) : pour un créateur encore présent.
    const backdrops =
      found.createdByProfile !== null && found.inviterName !== null
        ? (await users().householdBackdrops(found.createdByProfile, 60)).filter(isAllowedImageUrl).slice(0, 12)
        : [];
    return sendJson(c, {
      state,
      inviter:
        found.inviterName === null ? undefined : { name: found.inviterName, avatar: found.inviterAvatar, avatarColor: found.inviterAvatarColor },
      profile: { name: found.profileName, avatar: found.profileAvatar, avatarColor: found.profileAvatarColor },
      expiresAt: iso(found.expiresAt),
      backdrops,
    });
  });

  /**
   * Consommation d'un lien (anonyme, une seule fois) : crée l'identifiant et le mot de passe de l'invité, puis renvoie une
   * session verrouillée sur son profil. `name` renomme le profil.
   */
  router.post('/household-invites/redeem', async (c) => {
    const body = parseWith(householdRedeemSchema, c.get('body'));
    // Forme du jeton vérifiée avant tout calcul coûteux (scrypt) : un jeton mal formé ne correspond à aucun lien.
    if (!HOUSEHOLD_TOKEN_PATTERN.test(body.token)) throw new UserApiError(404, 'unknown');
    const login = body.login.trim().toLowerCase();
    if (!LOGIN_NAME_PATTERN.test(login)) throw new UserApiError(400, 'bad_login');
    if (body.password.length < PASSWORD_MIN || body.password.length > PASSWORD_MAX) throw new UserApiError(400, 'weak_password');
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const passwordHash = await hashSecret(body.password);
    const result = await users().redeemHouseholdInvite({
      tokenHash: hashSessionToken(body.token),
      login,
      passwordHash,
      name: body.name === undefined || body.name === '' ? null : body.name,
      sessionHash: hashSessionToken(token),
      now: Date.now(),
      sessionExpiresAt: expiresAt,
      userAgent: c.req.header('user-agent'),
    });
    if (!result.ok) {
      if (result.reason === 'unknown') throw new UserApiError(404, 'unknown');
      if (result.reason === 'login_taken') throw new UserApiError(409, 'login_taken');
      if (result.reason === 'account_suspended') throw new UserApiError(403, 'account_suspended');
      throw new UserApiError(410, result.reason);
    }
    return sendJson(c, { token, expiresAt, profileId: result.profileId }, 201);
  });
}
