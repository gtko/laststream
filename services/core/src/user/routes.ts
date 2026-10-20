import { randomUUID } from 'node:crypto';
import { type MaintenanceGate, maintenanceResponse } from '../admin/maintenance.js';
import type { ErrorHandler } from 'hono';
import { type App, type AppEnv, type Ctx, newApp } from '../http/app-env.js';
import { errorHandler } from '../http/common.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { bootstrapToken, isSignupAllowed } from '../config/runtime-env.js';
import { ConfigDecodeError, decodeConfig, decryptJson, encryptJson } from '../config/codec.js';
import { withServerServices } from '../config/server-services.js';
import { ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { createLtContext, type LtContext } from '../lt/context.js';
import { createRateLimiter } from '../rate-limit.js';
import { isRecord } from '../sources/http.js';
import {
  generateSessionToken,
  hashSecret,
  hashSessionToken,
  safeEqual,
  signProfileToken,
  verifySecret,
} from './crypto.js';
import { continueWatching, normalizeProgress } from './progress.js';
import { assertNotLocked, assertUnlocked, nowIso, profileOf, SESSION_TTL_MS, scopeOf, sessionOf } from './session.js';
import { registerHouseholdRoutes } from './household-routes.js';
import { countryCode } from './title-starts.js';
import { parseTvSources, TV_SOURCES_PURPOSE } from './tv-sources.js';
import { registerSocialRoutes } from './social-routes.js';
import { recordProgressActivity, registerSocialV2ActivityRoutes } from './social-v2-activity-routes.js';
import { registerSocialV2MessageRoutes } from './social-v2-messages-routes.js';
import { registerSocialV2NoteRoutes } from './social-v2-notes-routes.js';
import { registerSocialV2ProfileRoutes } from './social-v2-profile-routes.js';
import { registerSocialV2Routes } from './social-v2-routes.js';
import { registerSocialV3Routes } from './social-v3-routes.js';
import { registerDebridLinkRoutes } from './debrid-links.js';
import type { UserBackend, UserRepo } from './repo.js';
import { importStremioLibrary, StremioImportError } from './stremio.js';
import {
  type FollowType,
  type KidMaxAge,
  type MediaType,
  type ProfileEditableFields,
  type ProfileFields,
  publicProfile,
  titleRef,
} from './store.js';
import {
  createProfileSchema,
  loginSchema,
  registerSchema,
  deleteAccountSchema,
  passwordResetSchema,
  followTypeSchema,
  followWriteSchema,
  librarySortSchema,
  libraryWriteSchema,
  mediaTypeSchema,
  parseWith,
  passwordChangeSchema,
  pinSchema,
  progressWriteSchema,
  ratingsQuerySchema,
  ratingWriteSchema,
  stremioImportSchema,
  titleIdParam,
  tmdbIdParam,
  updateProfileSchema,
  UserApiError,
  watchedWriteSchema,
  assertAvatarAllowed,
} from './validation.js';

const DEFAULT_KID_MAX_AGE: KidMaxAge = 12;
/** Blocage du PIN : après 5 tentatives échouées, 5 minutes sans vérification. */
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 5 * 60_000;
const LIMIT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS = { read: 300, write: 120, sensitive: 10, loginPerUsername: 10, authPerIp: 10 } as const;
/** Connexion et inscription : tentatives par IP sur une fenêtre longue (freine la force brute). */
const AUTH_WINDOW_MS = 15 * 60_000;
/** Réglage de profil qui porte la configuration lastAddon chiffrée (sources, extensions, clés). */
const CONFIG_SETTING_KEY = 'lastaddonConfig';
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_SETTINGS_PER_WRITE = 100;
const MAX_SETTING_BYTES = 4096;

/** Routes sensibles (identifiants, PIN, import) : limite serrée par IP. */
const SENSITIVE_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/register$/ },
  { method: 'POST', path: /^\/login$/ },
  { method: 'POST', path: /^\/password$/ },
  { method: 'POST', path: /^\/password-reset$/ },
  { method: 'DELETE', path: /^\/account$/ },
  { method: 'POST', path: /^\/profiles\/[^/]+\/unlock$/ },
  { method: 'POST', path: /^\/profiles\/[^/]+\/import\/stremio$/ },
  { method: 'POST', path: /^\/household-invites\/redeem$/ },
];

/** Point de montage de l'API utilisateur. */
const USER_MOUNT = '/user';

function pinLocked(lockedUntil: string): UserApiError {
  const retryAfterSec = Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000));
  return new UserApiError(429, 'pin_locked', undefined, retryAfterSec);
}

function toProgressDto(item: { type: MediaType; tmdbId: number | null; imdbId: string | null; season: number; episode: number; positionSec: number; durationSec: number; updatedAt: string; finished: boolean }) {
  const series = item.type === 'series';
  return {
    type: item.type,
    tmdbId: item.tmdbId,
    imdbId: item.imdbId,
    season: series ? item.season : null,
    episode: series ? item.episode : null,
    positionSec: item.positionSec,
    durationSec: item.durationSec,
    updatedAt: item.updatedAt,
    finished: item.finished,
  };
}

/** Identifiant d'un titre de bibliothèque : `tt…` (IMDb seul) ou chiffres (TMDB, IMDb optionnel dans le corps). */
function titleKey(rawId: string, bodyImdbId: string | undefined): { tmdbId: number | null; imdbId: string | null } {
  if (rawId.startsWith('tt')) return { tmdbId: null, imdbId: rawId };
  return { tmdbId: parseWith(tmdbIdParam, rawId), imdbId: bodyImdbId ?? null };
}

/** Réglages : objet clé → valeur JSON ; `null` supprime la clé. Clés et tailles bornées. */
function settingsEntries(body: unknown): [string, unknown][] {
  if (!isRecord(body)) throw new UserApiError(400, 'invalid_body', ['(racine):objet_attendu']);
  const entries = Object.entries(body);
  if (entries.length > MAX_SETTINGS_PER_WRITE) throw new UserApiError(400, 'invalid_body', ['(racine):trop_de_cles']);
  for (const [key, value] of entries) {
    if (!SETTING_KEY.test(key)) throw new UserApiError(400, 'invalid_body', ['cle:invalide']);
    if (value !== null && new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SETTING_BYTES) {
      throw new UserApiError(400, 'invalid_body', ['valeur:trop_grande']);
    }
  }
  return entries;
}

/** Jeton TMDB d'une configuration encodée (import Stremio : résolution des identifiants). */
function tmdbTokenOf(encoded: string, secret: string, allowPlain: boolean): string | undefined {
  try {
    return withServerServices(decodeConfig(encoded, secret, { allowPlain })).services.tmdbToken;
  } catch (err) {
    if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) throw new UserApiError(400, 'invalid_config');
    throw err;
  }
}

/** Erreurs de l'API utilisateur : `{ error: code }` (+ `issues`), Retry-After pour les limites. Les autres erreurs vont à l'application. */
export const userErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof UserApiError) {
    if (err.retryAfterSec !== undefined) c.header('Retry-After', String(err.retryAfterSec));
    return sendJson(c, err.issues === undefined ? { error: err.code } : { error: err.code, issues: err.issues }, err.status as 400);
  }
  return errorHandler(err, c);
};

/**
 * API des données utilisateur, montée sous /user. Les données passent par `backend` (SQLite local sous Node, Durable
 * Object sous Workers), ouvert au premier appel : une application sans appel /user n'écrit jamais de fichier.
 */
export function registerUserRoutes(app: App, deps: AppDeps, backend: UserBackend, maintenance?: MaintenanceGate): void {
  const db = (): UserRepo => backend.users();
  const ctx: LtContext = createLtContext(deps);
  const limits = { ...DEFAULT_LIMITS, ...deps.userRateLimits };
  const limiters = {
    read: createRateLimiter(limits.read, LIMIT_WINDOW_MS),
    write: createRateLimiter(limits.write, LIMIT_WINDOW_MS),
    sensitive: createRateLimiter(limits.sensitive, LIMIT_WINDOW_MS),
  };
  const loginByUsername = createRateLimiter(limits.loginPerUsername, LIMIT_WINDOW_MS);
  const authByIp = createRateLimiter(limits.authPerIp, AUTH_WINDOW_MS);

  const router = newApp();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // Limites par IP : lectures, écritures, routes sensibles (préflights OPTIONS exclus).
  router.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }
    // Chemin relatif au montage (/user).
    const path = c.req.path.slice(USER_MOUNT.length) || '/';
    const sensitive = SENSITIVE_ROUTES.some((route) => route.method === c.req.method && route.path.test(path));
    const kind = sensitive ? 'sensitive' : c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write';
    const ip = c.get('ip') ?? 'inconnu';
    const verdict = limiters[kind](ip);
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    if (c.req.method === 'POST' && (path === '/login' || path === '/register' || path === '/password-reset')) {
      if (deps.authLimiter === undefined) {
        const auth = authByIp(ip);
        if (!auth.allowed) throw new UserApiError(429, 'rate_limited', undefined, auth.retryAfterSec);
      } else if (!(await deps.authLimiter.byIp(ip))) {
        throw new UserApiError(429, 'rate_limited', undefined, deps.authLimiter.retryAfterSec);
      }
    }
    await next();
  });

  // Comptes et sessions

  router.post('/register', async (c) => {
    const body = parseWith(registerSchema, c.get('body'));
    const users = db();
    const allowSignup = isSignupAllowed();
    const isFirst = (await users.countAccounts()) === 0;
    // Inscription par lien de parrainage uniquement (LASTADDON_ALLOW_SIGNUP=1 : inscription ouverte, réservée aux serveurs perso).
    if (!isFirst && !allowSignup && body.invite === undefined) throw new UserApiError(403, 'signup_disabled');
    // Premier compte : jeton d'amorçage exigé si LASTADDON_BOOTSTRAP_TOKEN est défini.
    const required = bootstrapToken();
    if (isFirst && required !== undefined && !safeEqual(c.req.header('x-bootstrap-token') ?? '', required)) {
      throw new UserApiError(403, 'bootstrap_token_invalid');
    }
    const passwordHash = await hashSecret(body.password);
    const result = await users.createAccount({
      username: body.username,
      passwordHash,
      allowSignup,
      inviteCode: body.invite,
      autoFriend: body.autoFriend,
      now: nowIso(),
    });
    if (!result.ok) {
      const status = result.reason === 'username_taken' ? 409 : result.reason === 'invite_expired' ? 410 : 403;
      throw new UserApiError(status, result.reason);
    }
    return sendJson(c, { account: result.account }, 201);
  });

  /** Ouvre une session (libre, ou verrouillée sur un profil invité du foyer) et renvoie son jeton. */
  async function issueSession(c: Ctx, users: UserRepo, accountId: string, profileId: string | null = null) {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await users.startSession(accountId, hashSessionToken(token), nowIso(), expiresAt, c.req.header('user-agent'), profileId);
    return sendJson(c, { token, expiresAt });
  }

  router.post('/login', async (c) => {
    const body = parseWith(loginSchema, c.get('body'));
    if (deps.authLimiter === undefined) {
      const byUser = loginByUsername(body.username);
      if (!byUser.allowed) throw new UserApiError(429, 'rate_limited', undefined, byUser.retryAfterSec);
    } else if (!(await deps.authLimiter.byUsername(body.username.toLowerCase()))) {
      throw new UserApiError(429, 'rate_limited', undefined, deps.authLimiter.retryAfterSec);
    }
    const users = db();
    const record = await users.findAccountRecord(body.username);
    if (record !== undefined) {
      const valid = await verifySecret(body.password, record.passwordHash);
      if (!valid) throw new UserApiError(401, 'invalid_credentials');
      // Compte suspendu par l'administration (révélé seulement à qui connaît le mot de passe).
      if (record.suspended) throw new UserApiError(403, 'account_suspended');
      // Maintenance : seul le propriétaire peut se connecter (pour rouvrir le service depuis /admin).
      if (!record.isOwner && maintenance !== undefined) {
        const state = await maintenance.current();
        if (state.enabled) return maintenanceResponse(c, state);
      }
      return issueSession(c, users, record.id);
    }
    // Pas de compte à ce nom : identifiant d'invité du foyer (session verrouillée sur son profil). Même coût de calcul
    // que pour un compte existant : le délai ne révèle pas si le nom existe.
    const invited = await users.profileLoginRecord(body.username);
    if (invited === undefined) {
      await hashSecret(body.password);
      throw new UserApiError(401, 'invalid_credentials');
    }
    if (!(await verifySecret(body.password, invited.passwordHash))) throw new UserApiError(401, 'invalid_credentials');
    if (invited.suspended) throw new UserApiError(403, 'account_suspended');
    // Maintenance : tout identifiant d'invité attend la fin de la maintenance (seul le propriétaire se connecte).
    if (maintenance !== undefined) {
      const state = await maintenance.current();
      if (state.enabled) return maintenanceResponse(c, state);
    }
    return issueSession(c, users, invited.accountId, invited.profileId);
  });

  /** Réinitialisation du mot de passe par lien à usage unique (émis par l'administration, valable 24 h) ; révoque toutes les sessions. */
  router.post('/password-reset', async (c) => {
    const body = parseWith(passwordResetSchema, c.get('body'));
    const result = await backend.admin().redeemPasswordReset(hashSessionToken(body.token), nowIso(), await hashSecret(body.password));
    if (result === undefined) throw new UserApiError(400, 'reset_invalid');
    await backend.admin().addAudit({ at: nowIso(), actorId: result.accountId, actor: result.username, action: 'password_reset_used', target: result.username, detail: null });
    return sendEmpty(c, 204);
  });

  /** Informations publiques pour l'écran d'inscription (aucune autre donnée) : serveur vide, inscription sur invitation, maintenance. */
  router.get('/signup-info', async (c) => {
    const empty = (await db().countAccounts()) === 0;
    const state = maintenance === undefined ? undefined : await maintenance.current();
    return sendJson(c, { serverEmpty: empty, inviteOnly: !isSignupAllowed(), maintenance: state?.enabled === true });
  });

  router.post('/refresh', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    const token = generateSessionToken();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const rotated = await users.rotateSession(session.tokenHash, hashSessionToken(token), session.account.id, now, expiresAt, c.req.header('user-agent'));
    if (!rotated) throw new UserApiError(401, 'unauthorized');
    return sendJson(c, { token, expiresAt });
  });

  router.post('/logout', async (c) => {
    const users = db();
    await users.deleteSession((await sessionOf(users, c)).tokenHash);
    return sendEmpty(c, 204);
  });

  /**
   * Déconnecte les autres sessions du compte. Depuis une session verrouillée sur un profil invité, seules les sessions de ce
   * profil sont révoquées (l'hôte et les autres profils ne sont pas touchés).
   */
  router.post('/logout-all', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    if (session.lockedProfileId !== null) await users.deleteProfileSessions(session.account.id, session.lockedProfileId);
    else await users.deleteAllSessions(session.account.id);
    return sendEmpty(c, 204);
  });

  /**
   * `lockedProfileId` : profil auquel la session est verrouillée (invitation du foyer), sinon null. Une session verrouillée
   * ne voit pas le pseudo du compte hôte : son identifiant de connexion d'invité en tient lieu (rôle membre, pas de propriété).
   */
  router.get('/me', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    if (session.lockedProfileId !== null) {
      const profile = await users.findProfile(session.account.id, session.lockedProfileId);
      const login = await users.loginOfProfile(session.lockedProfileId);
      return sendJson(c, {
        account: {
          id: session.account.id,
          username: login ?? '',
          isOwner: false,
          createdAt: profile?.createdAt ?? session.account.createdAt,
          role: 'member',
        },
        lockedProfileId: session.lockedProfileId,
      });
    }
    return sendJson(c, {
      account: { ...session.account, role: session.account.isOwner ? 'owner' : 'member' },
      lockedProfileId: null,
    });
  });

  /** Change le mot de passe ; révoque les autres sessions. Le mot de passe actuel est exigé. */
  router.post('/password', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    assertNotLocked(session);
    const body = parseWith(passwordChangeSchema, c.get('body'));
    const record = await users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.current, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    await users.changePassword(session.account.id, await hashSecret(body.next), session.tokenHash);
    return sendEmpty(c, 204);
  });

  /** Supprime le compte et toutes ses données. Le mot de passe est exigé. */
  router.delete('/account', async (c) => {
    const users = db();
    const session = await sessionOf(users, c);
    assertNotLocked(session);
    const body = parseWith(deleteAccountSchema, c.get('body'));
    const record = await users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.password, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    await users.deleteAccount(session.account.id);
    return sendEmpty(c, 204);
  });

  // Profils

  router.get('/profiles', async (c) => {
    const session = await sessionOf(db(), c);
    const { account } = session;
    const locked = session.lockedProfileId;
    // Profil administrateur : annoncé au seul compte propriétaire (l'administration exige ce profil), jamais à une session invitée.
    const adminId = account.isOwner && locked === null ? await backend.admin().adminProfileId() : null;
    // Profil principal : seul à gérer la configuration (sources, extensions, clés) ; les autres profils n'ont que leurs préférences.
    // Session verrouillée sur un profil invité : seul ce profil est listé, sans rôle de principal.
    const mainId = locked === null ? await backend.admin().mainProfileId(account.id) : null;
    const visible = (await db().listProfiles(account.id)).filter((p) => locked === null || p.id === locked);
    const profiles = visible.map((p) => ({
      ...publicProfile(p),
      isAdminProfile: adminId !== null && p.id === adminId,
      isMainProfile: mainId !== null && p.id === mainId,
    }));
    return sendJson(c, { profiles });
  });

  /**
   * Gestion des profils (création, modification, suppression) : réservée au profil principal du compte. La requête doit
   * porter X-Profile-Id = profil principal (et son jeton de PIN s'il en a un). Seule exception : un compte sans aucun
   * profil peut créer le premier (qui devient le principal).
   */
  async function managerOf(users: UserRepo, c: Ctx, allowFirst: boolean) {
    const session = await sessionOf(users, c);
    // Session verrouillée sur un profil invité : aucune gestion de profils, même pour le premier.
    assertNotLocked(session);
    if (allowFirst && (await users.listProfiles(session.account.id)).length === 0) return session;
    const mainId = await backend.admin().mainProfileId(session.account.id);
    const actorId = c.req.header('x-profile-id');
    if (mainId === null || actorId === undefined || actorId !== mainId) throw new UserApiError(403, 'main_profile_required');
    const actor = await users.findProfile(session.account.id, actorId);
    if (actor === undefined) throw new UserApiError(403, 'main_profile_required');
    assertUnlocked(c, session, actor, deps.secret);
    return session;
  }

  router.post('/profiles', async (c) => {
    const { account } = await managerOf(db(), c, true);
    const body = parseWith(createProfileSchema, c.get('body'));
    const isKid = body.isKid;
    assertAvatarAllowed(body.avatar, isKid);
    const fields: ProfileFields = {
      name: body.name,
      avatarColor: body.avatarColor,
      avatar: body.avatar ?? null,
      isKid,
      kidMaxAge: isKid ? (body.kidMaxAge ?? DEFAULT_KID_MAX_AGE) : null,
      pinHash: body.pin === undefined ? null : await hashSecret(body.pin),
      allowedCatalogs: body.allowedCatalogs,
    };
    const profileId = randomUUID();
    await db().insertProfile(account.id, profileId, fields, nowIso());
    const created = await db().findProfile(account.id, profileId);
    if (created === undefined) throw new Error('profil introuvable après création');
    return sendJson(c, publicProfile(created), 201);
  });

  router.patch('/profiles/:id', async (c) => {
    const users = db();
    const rawBody = c.get('body');
    const keys = rawBody !== null && typeof rawBody === 'object' ? Object.keys(rawBody) : [];
    const session = await sessionOf(users, c);
    assertNotLocked(session);
    const profile = await profileOf(users, session.account, c);
    const account = session.account;
    // Exception : un profil adulte change son propre code PIN (jeton de son profil exigé) ; le reste passe par le principal.
    const ownPinOnly = !profile.isKid && keys.length === 1 && keys[0] === 'pin' && c.req.header('x-profile-id') === profile.id;
    if (ownPinOnly) assertUnlocked(c, session, profile, deps.secret);
    else await managerOf(users, c, false);
    const patch = parseWith(updateProfileSchema, rawBody);
    const isKid = patch.isKid ?? profile.isKid;
    const fields: ProfileEditableFields = {
      name: patch.name ?? profile.name,
      avatarColor: patch.avatarColor ?? profile.avatarColor,
      avatar: patch.avatar === undefined ? profile.avatar : patch.avatar,
      isKid,
      kidMaxAge: isKid ? (patch.kidMaxAge ?? profile.kidMaxAge ?? DEFAULT_KID_MAX_AGE) : null,
      allowedCatalogs: patch.allowedCatalogs ?? profile.allowedCatalogs,
    };
    // Avatar `col:` : vérifié quand il change ou quand le profil devient enfant (un avatar déjà en place reste sinon intact).
    if (patch.avatar !== undefined || (isKid && !profile.isKid)) assertAvatarAllowed(fields.avatar, isKid);
    const newPinHash = patch.pin === undefined ? undefined : patch.pin === null ? null : await hashSecret(patch.pin);
    await users.updateProfile(account.id, profile.id, fields, newPinHash);
    const updated = await users.findProfile(account.id, profile.id);
    if (updated === undefined) throw new Error('profil introuvable après mise à jour');
    return sendJson(c, publicProfile(updated));
  });

  router.delete('/profiles/:id', async (c) => {
    const users = db();
    const session = await managerOf(users, c, false);
    const profile = await profileOf(users, session.account, c);
    await users.deleteProfile(session.account.id, profile.id);
    return sendEmpty(c, 204);
  });

  /**
   * Déverrouillage par PIN : jeton de profil (30 jours), lié à la session et à la version du PIN. Cinq échecs
   * bloquent le profil 5 minutes : pendant le blocage, le PIN n'est même pas vérifié (429 pin_locked).
   */
  router.post('/profiles/:id/unlock', async (c) => {
    const users = db();
    const { account, profile, tokenHash } = await scopeOf(users, c, deps.secret, false);
    const { pin } = parseWith(pinSchema, c.get('body'));
    const pinHash = profile.pinHash;
    if (pinHash === null) throw new UserApiError(409, 'pin_not_set');
    const blockedUntil = await users.reservePinAttempt(
      profile.id,
      nowIso(),
      new Date(Date.now() + PIN_LOCK_MS).toISOString(),
      PIN_MAX_FAILURES,
    );
    if (blockedUntil !== null) throw pinLocked(blockedUntil);
    if (await verifySecret(pin, pinHash)) {
      await users.resetPinAttempts(profile.id);
      const claims = { accountId: account.id, profileId: profile.id, sessionHash: tokenHash, pinVersion: profile.pinVersion };
      return sendJson(c, signProfileToken(claims, Date.now(), deps.secret));
    }
    const lockedNow = await users.pinLockedUntil(profile.id, nowIso());
    if (lockedNow !== null) throw pinLocked(lockedNow);
    throw new UserApiError(403, 'invalid_pin');
  });

  /**
   * Verrouillage explicite, appelé par le client au changement de profil. Sans effet côté serveur : le jeton reste
   * valable jusqu'à déconnexion, changement de PIN ou expiration. Le profil doit appartenir au compte.
   */
  router.post('/profiles/:id/lock', async (c) => {
    await scopeOf(db(), c, deps.secret, false);
    return sendEmpty(c, 204);
  });

  // Bibliothèque

  router.get('/profiles/:id/library', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const query = parseWith(librarySortSchema, queryParams(c));
    return sendJson(c, { items: await users.listLibrary(profile.id, query.type, query.sort) });
  });

  router.put('/profiles/:id/library/:type/:itemId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const itemId = parseWith(titleIdParam, c.req.param('itemId'));
    const body = parseWith(libraryWriteSchema, c.get('body'));
    const key = titleKey(itemId, body.imdbId);
    await users.upsertLibraryItem({
      profileId: profile.id,
      type,
      tmdbId: key.tmdbId,
      imdbId: key.imdbId,
      title: body.title,
      poster: body.poster ?? null,
      addedAt: nowIso(),
    });
    return sendEmpty(c, 204);
  });

  router.delete('/profiles/:id/library/:type/:itemId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const itemId = parseWith(titleIdParam, c.req.param('itemId'));
    const key = titleKey(itemId, undefined);
    await users.removeLibraryItem(profile.id, type, titleRef(key.tmdbId, key.imdbId));
    return sendEmpty(c, 204);
  });

  // Progression

  router.put('/profiles/:id/progress', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const normalized = normalizeProgress(parseWith(progressWriteSchema, c.get('body')));
    const ref = titleRef(normalized.tmdbId, normalized.imdbId);
    const before = await users.progressEpisode(profile.id, normalized.type, ref, normalized.season, normalized.episode);
    await users.upsertProgress({ profileId: profile.id, ...normalized, updatedAt: nowIso(), country: countryCode(c.env?.country) });
    const saved = await users.progressEpisode(profile.id, normalized.type, ref, normalized.season, normalized.episode);
    if (saved === undefined) throw new Error('progression introuvable après écriture');
    // Activité (S5) : débuts et fins de lecture. Un titre sans identifiant TMDB n'en produit pas.
    if (normalized.tmdbId !== null) {
      const media = { type: normalized.type, tmdbId: normalized.tmdbId, season: normalized.season, episode: normalized.episode };
      await recordProgressActivity(backend, deps, profile, media, before, saved, Date.now());
    }
    return sendJson(c, { item: toProgressDto(saved) });
  });

  router.get('/profiles/:id/continue', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const hidden = await users.hiddenContinue(profile.id);
    // Un titre masqué ne revient que si sa progression la plus récente est postérieure au masquage.
    const latest = (await users.latestProgressPerTitle(profile.id)).filter((row) => {
      const hiddenAt = hidden.get(`${row.type}|${row.titleRef}`);
      return hiddenAt === undefined || row.updatedAt > hiddenAt;
    });
    const items = await continueWatching(latest, (type, ref, season, episode) =>
      users.progressEpisode(profile.id, type, ref, season, episode),
    );
    return sendJson(c, { items });
  });

  /** Masque un titre de « continuer à regarder » sans toucher à la progression ni aux vus. Il réapparaît à la prochaine progression. */
  router.delete('/profiles/:id/continue/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    await users.hideContinue(profile.id, type, titleRef(tmdbId, null), nowIso());
    return sendEmpty(c, 204);
  });

  router.get('/profiles/:id/progress/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const items = await users.progressForTitle(profile.id, type, `tmdb:${tmdbId}`);
    return sendJson(c, { items: items.map(toProgressDto) });
  });

  /**
   * Vu / non vu : un film (saison et épisode à 0) ou des épisodes listés. Les épisodes non listés ne sont jamais
   * touchés ; la saison 0 (spéciaux) n'est écrite que si elle figure explicitement dans `episodes`.
   */
  router.put('/profiles/:id/watched', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const body = parseWith(watchedWriteSchema, c.get('body'));
    await users.setWatched({
      profileId: profile.id,
      type: body.type,
      tmdbId: body.tmdbId ?? null,
      imdbId: body.imdbId ?? null,
      episodes: body.type === 'movie' ? [{ season: 0, episode: 0 }] : body.episodes,
      watched: body.watched,
      updatedAt: nowIso(),
    });
    return sendEmpty(c, 204);
  });

  /** Historique « vu » du profil : films et séries vus (`watched` = films ou épisodes vus), les plus récents d'abord. */
  router.get('/profiles/:id/watched', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const items = await users.watchedTitles(profile.id);
    return sendJson(c, {
      items: items.map((item) => ({
        type: item.type,
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        watched: item.watched,
        lastWatchedAt: item.lastWatchedAt,
      })),
    });
  });

  /** `{ movie }` pour un film ; `{ episodes }` pour une série (épisodes avec progression, vus ou en cours). */
  router.get('/profiles/:id/watched/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const rows = await users.progressForTitle(profile.id, type, titleRef(tmdbId, null));
    if (type === 'movie') {
      return sendJson(c, { movie: rows.some((row) => row.finished) });
    }
    return sendJson(c, {
      episodes: rows.map((row) => ({
        season: row.season,
        episode: row.episode,
        finished: row.finished,
        positionSec: row.positionSec,
        durationSec: row.durationSec,
      })),
    });
  });

  // Suivis

  router.get('/profiles/:id/follows', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    return sendJson(c, { items: await users.listFollows(profile.id) });
  });

  router.put('/profiles/:id/follows/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: FollowType = parseWith(followTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const body = parseWith(followWriteSchema, c.get('body'));
    await users.upsertFollow({
      profileId: profile.id,
      type,
      tmdbId,
      imdbId: body.imdbId ?? null,
      title: body.title,
      poster: body.poster ?? null,
      notify: body.notify,
      followedAt: nowIso(),
    });
    return sendEmpty(c, 204);
  });

  router.delete('/profiles/:id/follows/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: FollowType = parseWith(followTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    await users.removeFollow(profile.id, type, titleRef(tmdbId, null));
    return sendEmpty(c, 204);
  });

  // Notes sur 5 (demi-étoiles)

  router.get('/profiles/:id/ratings', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const query = parseWith(ratingsQuerySchema, queryParams(c));
    return sendJson(c, { items: await users.listRatings(profile.id, query.type) });
  });

  router.put('/profiles/:id/ratings/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const body = parseWith(ratingWriteSchema, c.get('body'));
    await users.upsertRating({
      profileId: profile.id,
      type,
      tmdbId,
      imdbId: body.imdbId ?? null,
      title: body.title ?? null,
      rating: body.rating,
      ratedAt: nowIso(),
    });
    return sendEmpty(c, 204);
  });

  router.delete('/profiles/:id/ratings/:type/:tmdbId', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    await users.removeRating(profile.id, type, titleRef(tmdbId, null));
    return sendEmpty(c, 204);
  });

  // Configuration lastAddon du compte (sources, extensions, clés) : chaîne chiffrée opaque. Lue par tout profil du compte
  // (même enfant, sans PIN : l'en-tête X-Profile-Id est facultatif), écrite par le seul profil principal.

  router.get('/account/config', async (c) => {
    const users = db();
    const { account } = await sessionOf(users, c);
    const actor = c.req.header('x-profile-id');
    if (actor !== undefined && (await users.findProfile(account.id, actor)) === undefined) throw new UserApiError(404, 'profile_not_found');
    let config = await users.getAccountConfig(account.id);
    if (config === null) {
      // Compatibilité (une version) : ancienne clé dans les réglages du profil principal.
      const mainId = await backend.admin().mainProfileId(account.id);
      const legacy = mainId === null ? undefined : (await users.listSettings(mainId))[CONFIG_SETTING_KEY];
      config = typeof legacy === 'string' ? legacy : null;
    }
    return sendJson(c, { config });
  });

  router.put('/account/config', async (c) => {
    const users = db();
    const session = await managerOf(users, c, false);
    const body = c.get('body');
    const config = isRecord(body) ? body.config : undefined;
    if (config !== null && typeof config !== 'string') throw new UserApiError(400, 'invalid_body', ['config:chaine_attendue']);
    if (config !== null && new TextEncoder().encode(config).byteLength > MAX_SETTING_BYTES) throw new UserApiError(400, 'invalid_body', ['config:trop_grande']);
    await users.setAccountConfig(session.account.id, config);
    // Anciennes versions de l'app : la clé du profil principal reste alimentée le temps d'une version.
    await users.writeSettings(String(c.req.header('x-profile-id')), [[CONFIG_SETTING_KEY, config]]);
    return sendJson(c, { config });
  });

  // Sources TV du compte (playlists M3U, guides XMLTV) : JSON chiffré côté serveur, rendu en clair au seul compte
  // (no-store), lu par tout profil, écrit par le principal. Le serveur ne télécharge jamais ces URL et ne les journalise pas.

  router.get('/account/tv-sources', async (c) => {
    const users = db();
    const { account } = await sessionOf(users, c);
    const actor = c.req.header('x-profile-id');
    if (actor !== undefined && (await users.findProfile(account.id, actor)) === undefined) throw new UserApiError(404, 'profile_not_found');
    const stored = await users.getTvSources(account.id);
    let lists: unknown = null;
    if (stored !== null) {
      try {
        lists = decryptJson(stored, deps.secret, TV_SOURCES_PURPOSE);
      } catch {
        throw new UserApiError(500, 'tv_sources_unreadable');
      }
    }
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { lists });
  });

  router.put('/account/tv-sources', async (c) => {
    const users = db();
    const session = await managerOf(users, c, false);
    const body = c.get('body');
    const lists = parseTvSources(isRecord(body) ? body.lists : undefined);
    await users.setTvSources(session.account.id, lists === null ? null : encryptJson(lists, deps.secret, TV_SOURCES_PURPOSE));
    c.header('Cache-Control', 'no-store');
    return sendJson(c, { ok: true });
  });

  // Réglages

  router.get('/profiles/:id/settings', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    return sendJson(c, { settings: await users.listSettings(profile.id) });
  });

  router.put('/profiles/:id/settings', async (c) => {
    const users = db();
    const { profile, account } = await scopeOf(users, c, deps.secret, true);
    const entries = settingsEntries(c.get('body'));
    // La configuration lastAddon (sources, extensions, clés) ne s'écrit que depuis le profil principal du compte.
    if (entries.some(([key]) => key === CONFIG_SETTING_KEY) && (await backend.admin().mainProfileId(account.id)) !== profile.id) {
      throw new UserApiError(403, 'main_profile_required');
    }
    await users.writeSettings(profile.id, entries);
    // Ancienne voie d'écriture (apps non mises à jour) : la valeur rejoint aussi le niveau compte.
    const legacy = entries.find(([key]) => key === CONFIG_SETTING_KEY);
    if (legacy !== undefined) await users.setAccountConfig(account.id, typeof legacy[1] === 'string' ? legacy[1] : null);
    return sendJson(c, { settings: await users.listSettings(profile.id) });
  });

  // Import Stremio

  router.post('/profiles/:id/import/stremio', async (c) => {
    const users = db();
    const { profile } = await scopeOf(users, c, deps.secret, true);
    const body = parseWith(stremioImportSchema, c.get('body'));
    const tmdbToken = body.config === undefined ? undefined : tmdbTokenOf(body.config, deps.secret, deps.allowPlain);
    try {
      const result = await importStremioLibrary({
        store: users,
        ctx,
        profileId: profile.id,
        email: body.email,
        password: body.password,
        tmdbToken,
        now: nowIso(),
      });
      return sendJson(c, result);
    } catch (err) {
      if (err instanceof StremioImportError) {
        throw new UserApiError(err.code === 'stremio_login_failed' ? 422 : 502, err.code);
      }
      throw err;
    }
  });

  registerSocialRoutes(router, deps, backend);
  registerSocialV2Routes(router, deps, backend);
  registerSocialV2ProfileRoutes(router, deps, backend);
  registerSocialV2MessageRoutes(router, deps, backend);
  registerSocialV2NoteRoutes(router, deps, backend);
  registerSocialV3Routes(router, deps, backend);
  registerSocialV2ActivityRoutes(router, deps, backend);
  registerDebridLinkRoutes(router, deps, backend);
  registerHouseholdRoutes(router, deps, backend);

  router.all('*', () => {
    throw new UserApiError(404, 'not_found');
  });
  router.onError(userErrorHandler);

  app.route(USER_MOUNT, router);
}
