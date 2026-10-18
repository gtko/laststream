import { randomUUID } from 'node:crypto';
import type { ErrorHandler } from 'hono';
import { type App, type AppEnv, type Ctx, newApp } from '../http/app-env.js';
import { errorHandler } from '../http/common.js';
import { queryParams, sendEmpty, sendJson } from '../http/respond.js';
import { bootstrapToken, isSignupAllowed } from '../config/runtime-env.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { createLtContext, type LtContext } from '../lt/context.js';
import { createRateLimiter } from '../rate-limit.js';
import { isRecord } from '../sources/http.js';
import { openUserDb, userDbPath } from './db.js';
import {
  generateSessionToken,
  hashSecret,
  hashSessionToken,
  safeEqual,
  signProfileToken,
  verifyProfileToken,
  verifySecret,
} from './crypto.js';
import { continueWatching, normalizeProgress } from './progress.js';
import { importStremioLibrary, StremioImportError } from './stremio.js';
import {
  type Account,
  type FollowType,
  type KidMaxAge,
  type MediaType,
  type ProfileEditableFields,
  type ProfileFields,
  type ProfileRecord,
  publicProfile,
  titleRef,
  UserStore,
} from './store.js';
import {
  createProfileSchema,
  credentialsSchema,
  deleteAccountSchema,
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
} from './validation.js';

/** Session de connexion : 180 jours, renouvelée (rotation) par POST /user/refresh. */
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
const DEFAULT_KID_MAX_AGE: KidMaxAge = 12;
/** Blocage du PIN : après 5 tentatives échouées, 15 minutes sans vérification. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
const LIMIT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS = { read: 300, write: 120, sensitive: 10, loginPerUsername: 10, authPerIp: 10 } as const;
/** Connexion et inscription : tentatives par IP sur une fenêtre longue (freine la force brute). */
const AUTH_WINDOW_MS = 15 * 60_000;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_SETTINGS_PER_WRITE = 100;
const MAX_SETTING_BYTES = 4096;

/** Routes sensibles (identifiants, PIN, import) : limite serrée par IP. */
const SENSITIVE_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/register$/ },
  { method: 'POST', path: /^\/login$/ },
  { method: 'POST', path: /^\/password$/ },
  { method: 'DELETE', path: /^\/account$/ },
  { method: 'POST', path: /^\/profiles\/[^/]+\/unlock$/ },
  { method: 'POST', path: /^\/profiles\/[^/]+\/import\/stremio$/ },
];

/** Point de montage de l'API utilisateur. */
const USER_MOUNT = '/user';

const nowIso = (): string => new Date().toISOString();

function bearerToken(c: Ctx): string | undefined {
  const match = /^bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(c.req.header('authorization') ?? '');
  return match?.[1];
}

interface Session {
  /** Empreinte du jeton de session : identifie la session (stockée en base). */
  tokenHash: string;
  account: Account;
}

/** Session valide de la requête (jeton Bearer), ou 401. */
function sessionOf(store: UserStore, c: Ctx): Session {
  const token = bearerToken(c);
  if (token === undefined) throw new UserApiError(401, 'unauthorized');
  const tokenHash = hashSessionToken(token);
  const account = store.accountForSession(tokenHash, nowIso());
  if (account === undefined) throw new UserApiError(401, 'unauthorized');
  return { tokenHash, account };
}

function profileOf(store: UserStore, account: Account, c: Ctx): ProfileRecord {
  const profile = store.findProfile(account.id, String(c.req.param('id')));
  if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
  return profile;
}

interface Scope extends Session {
  profile: ProfileRecord;
}

/**
 * Session et profil de la requête. Si `unlock` et que le profil a un PIN, un jeton de profil valide est exigé
 * (en-tête X-Profile-Token) : lié à cette session et à la version courante du PIN, sinon 403 pin_required.
 */
function scopeOf(store: UserStore, c: Ctx, secret: string, unlock: boolean): Scope {
  const session = sessionOf(store, c);
  const profile = profileOf(store, session.account, c);
  if (unlock && profile.hasPin) {
    const token = c.req.header('x-profile-token');
    const valid =
      token !== undefined &&
      verifyProfileToken(
        token,
        { accountId: session.account.id, profileId: profile.id, sessionHash: session.tokenHash, pinVersion: profile.pinVersion },
        Date.now(),
        secret,
      );
    if (!valid) throw new UserApiError(403, 'pin_required');
  }
  return { ...session, profile };
}

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
    if (value !== null && Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SETTING_BYTES) {
      throw new UserApiError(400, 'invalid_body', ['valeur:trop_grande']);
    }
  }
  return entries;
}

/** Jeton TMDB d'une configuration encodée (import Stremio : résolution des identifiants). */
function tmdbTokenOf(encoded: string, secret: string, allowPlain: boolean): string | undefined {
  try {
    return decodeConfig(encoded, secret, { allowPlain }).services.tmdbToken;
  } catch (err) {
    if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) throw new UserApiError(400, 'invalid_config');
    throw err;
  }
}

/** Erreurs de l'API utilisateur : `{ error: code }` (+ `issues`), Retry-After pour les limites. Les autres erreurs vont à l'application. */
const userErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof UserApiError) {
    if (err.retryAfterSec !== undefined) c.header('Retry-After', String(err.retryAfterSec));
    return sendJson(c, err.issues === undefined ? { error: err.code } : { error: err.code, issues: err.issues }, err.status as 400);
  }
  return errorHandler(err, c);
};

/**
 * API des données utilisateur, montée sous /user. La base SQLite s'ouvre au premier appel (pas au démarrage) :
 * une application sans routes /user n'écrit jamais de fichier. Renvoie la fermeture de la base.
 */
export function registerUserRoutes(app: App, deps: AppDeps): () => void {
  let store: UserStore | undefined;
  const db = (): UserStore => {
    if (store === undefined) store = new UserStore(openUserDb(deps.userDbPath ?? userDbPath()));
    return store;
  };
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
    if (c.req.method === 'POST' && (path === '/login' || path === '/register')) {
      const auth = authByIp(ip);
      if (!auth.allowed) throw new UserApiError(429, 'rate_limited', undefined, auth.retryAfterSec);
    }
    await next();
  });

  // Comptes et sessions

  router.post('/register', async (c) => {
    const body = parseWith(credentialsSchema, c.get('body'));
    const users = db();
    const allowSignup = isSignupAllowed();
    const isFirst = users.countAccounts() === 0;
    if (!isFirst && !allowSignup) throw new UserApiError(403, 'signup_disabled');
    // Premier compte : jeton d'amorçage exigé si LASTADDON_BOOTSTRAP_TOKEN est défini.
    const required = bootstrapToken();
    if (isFirst && required !== undefined && !safeEqual(c.req.header('x-bootstrap-token') ?? '', required)) {
      throw new UserApiError(403, 'bootstrap_token_invalid');
    }
    const passwordHash = await hashSecret(body.password);
    const result = users.createAccount({ username: body.username, passwordHash, allowSignup, now: nowIso() });
    if (!result.ok) throw new UserApiError(result.reason === 'username_taken' ? 409 : 403, result.reason);
    return sendJson(c, { account: result.account }, 201);
  });

  router.post('/login', async (c) => {
    const body = parseWith(credentialsSchema, c.get('body'));
    const byUser = loginByUsername(body.username);
    if (!byUser.allowed) throw new UserApiError(429, 'rate_limited', undefined, byUser.retryAfterSec);
    const users = db();
    const record = users.findAccountRecord(body.username);
    // Même coût de calcul que pour un compte existant : le délai ne révèle pas si le nom existe.
    if (record === undefined) await hashSecret(body.password);
    const valid = record !== undefined && (await verifySecret(body.password, record.passwordHash));
    if (record === undefined || !valid) throw new UserApiError(401, 'invalid_credentials');
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    users.startSession(record.id, hashSessionToken(token), nowIso(), expiresAt);
    return sendJson(c, { token, expiresAt });
  });

  router.post('/refresh', (c) => {
    const users = db();
    const session = sessionOf(users, c);
    const token = generateSessionToken();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const rotated = users.rotateSession(session.tokenHash, hashSessionToken(token), session.account.id, now, expiresAt);
    if (!rotated) throw new UserApiError(401, 'unauthorized');
    return sendJson(c, { token, expiresAt });
  });

  router.post('/logout', (c) => {
    const users = db();
    users.deleteSession(sessionOf(users, c).tokenHash);
    return sendEmpty(c, 204);
  });

  router.post('/logout-all', (c) => {
    const users = db();
    users.deleteAllSessions(sessionOf(users, c).account.id);
    return sendEmpty(c, 204);
  });

  router.get('/me', (c) => {
    return sendJson(c, { account: sessionOf(db(), c).account });
  });

  /** Change le mot de passe ; révoque les autres sessions. Le mot de passe actuel est exigé. */
  router.post('/password', async (c) => {
    const users = db();
    const session = sessionOf(users, c);
    const body = parseWith(passwordChangeSchema, c.get('body'));
    const record = users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.current, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    users.changePassword(session.account.id, await hashSecret(body.next), session.tokenHash);
    return sendEmpty(c, 204);
  });

  /** Supprime le compte et toutes ses données. Le mot de passe est exigé. */
  router.delete('/account', async (c) => {
    const users = db();
    const session = sessionOf(users, c);
    const body = parseWith(deleteAccountSchema, c.get('body'));
    const record = users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.password, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    users.deleteAccount(session.account.id);
    return sendEmpty(c, 204);
  });

  // Profils

  router.get('/profiles', (c) => {
    const { account } = sessionOf(db(), c);
    return sendJson(c, { profiles: db().listProfiles(account.id).map(publicProfile) });
  });

  router.post('/profiles', async (c) => {
    const { account } = sessionOf(db(), c);
    const body = parseWith(createProfileSchema, c.get('body'));
    const isKid = body.isKid;
    const fields: ProfileFields = {
      name: body.name,
      avatarColor: body.avatarColor,
      isKid,
      kidMaxAge: isKid ? (body.kidMaxAge ?? DEFAULT_KID_MAX_AGE) : null,
      pinHash: body.pin === undefined ? null : await hashSecret(body.pin),
      allowedCatalogs: body.allowedCatalogs,
    };
    const profileId = randomUUID();
    db().insertProfile(account.id, profileId, fields, nowIso());
    const created = db().findProfile(account.id, profileId);
    if (created === undefined) throw new Error('profil introuvable après création');
    return sendJson(c, publicProfile(created), 201);
  });

  router.patch('/profiles/:id', async (c) => {
    const users = db();
    const { account, profile } = scopeOf(users, c, deps.secret, true);
    const patch = parseWith(updateProfileSchema, c.get('body'));
    const isKid = patch.isKid ?? profile.isKid;
    const fields: ProfileEditableFields = {
      name: patch.name ?? profile.name,
      avatarColor: patch.avatarColor ?? profile.avatarColor,
      isKid,
      kidMaxAge: isKid ? (patch.kidMaxAge ?? profile.kidMaxAge ?? DEFAULT_KID_MAX_AGE) : null,
      allowedCatalogs: patch.allowedCatalogs ?? profile.allowedCatalogs,
    };
    const newPinHash = patch.pin === undefined ? undefined : patch.pin === null ? null : await hashSecret(patch.pin);
    users.transaction(() => {
      users.updateProfile(account.id, profile.id, fields);
      if (newPinHash !== undefined) users.setPin(account.id, profile.id, newPinHash);
    });
    const updated = users.findProfile(account.id, profile.id);
    if (updated === undefined) throw new Error('profil introuvable après mise à jour');
    return sendJson(c, publicProfile(updated));
  });

  router.delete('/profiles/:id', (c) => {
    const users = db();
    const { account, profile } = scopeOf(users, c, deps.secret, true);
    users.deleteProfile(account.id, profile.id);
    return sendEmpty(c, 204);
  });

  /**
   * Déverrouillage par PIN : jeton de profil (30 jours), lié à la session et à la version du PIN. Cinq échecs
   * bloquent le profil 15 minutes : pendant le blocage, le PIN n'est même pas vérifié (429 pin_locked).
   */
  router.post('/profiles/:id/unlock', async (c) => {
    const users = db();
    const { account, profile, tokenHash } = scopeOf(users, c, deps.secret, false);
    const { pin } = parseWith(pinSchema, c.get('body'));
    const pinHash = profile.pinHash;
    if (pinHash === null) throw new UserApiError(409, 'pin_not_set');
    const blockedUntil = users.reservePinAttempt(
      profile.id,
      nowIso(),
      new Date(Date.now() + PIN_LOCK_MS).toISOString(),
      PIN_MAX_FAILURES,
    );
    if (blockedUntil !== null) throw pinLocked(blockedUntil);
    if (await verifySecret(pin, pinHash)) {
      users.resetPinAttempts(profile.id);
      const claims = { accountId: account.id, profileId: profile.id, sessionHash: tokenHash, pinVersion: profile.pinVersion };
      return sendJson(c, signProfileToken(claims, Date.now(), deps.secret));
    }
    const lockedNow = users.pinLockedUntil(profile.id, nowIso());
    if (lockedNow !== null) throw pinLocked(lockedNow);
    throw new UserApiError(403, 'invalid_pin');
  });

  /**
   * Verrouillage explicite, appelé par le client au changement de profil. Sans effet côté serveur : le jeton reste
   * valable jusqu'à déconnexion, changement de PIN ou expiration. Le profil doit appartenir au compte.
   */
  router.post('/profiles/:id/lock', (c) => {
    scopeOf(db(), c, deps.secret, false);
    return sendEmpty(c, 204);
  });

  // Bibliothèque

  router.get('/profiles/:id/library', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const query = parseWith(librarySortSchema, queryParams(c));
    return sendJson(c, { items: users.listLibrary(profile.id, query.type, query.sort) });
  });

  router.put('/profiles/:id/library/:type/:itemId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const itemId = parseWith(titleIdParam, c.req.param('itemId'));
    const body = parseWith(libraryWriteSchema, c.get('body'));
    const key = titleKey(itemId, body.imdbId);
    users.upsertLibraryItem({
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

  router.delete('/profiles/:id/library/:type/:itemId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const itemId = parseWith(titleIdParam, c.req.param('itemId'));
    const key = titleKey(itemId, undefined);
    users.removeLibraryItem(profile.id, type, titleRef(key.tmdbId, key.imdbId));
    return sendEmpty(c, 204);
  });

  // Progression

  router.put('/profiles/:id/progress', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const normalized = normalizeProgress(parseWith(progressWriteSchema, c.get('body')));
    users.upsertProgress({ profileId: profile.id, ...normalized, updatedAt: nowIso() });
    const saved = users.progressEpisode(
      profile.id,
      normalized.type,
      titleRef(normalized.tmdbId, normalized.imdbId),
      normalized.season,
      normalized.episode,
    );
    if (saved === undefined) throw new Error('progression introuvable après écriture');
    return sendJson(c, { item: toProgressDto(saved) });
  });

  router.get('/profiles/:id/continue', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const hidden = users.hiddenContinue(profile.id);
    // Un titre masqué ne revient que si sa progression la plus récente est postérieure au masquage.
    const latest = users.latestProgressPerTitle(profile.id).filter((row) => {
      const hiddenAt = hidden.get(`${row.type}|${row.titleRef}`);
      return hiddenAt === undefined || row.updatedAt > hiddenAt;
    });
    const items = continueWatching(latest, (type, ref, season, episode) =>
      users.progressEpisode(profile.id, type, ref, season, episode),
    );
    return sendJson(c, { items });
  });

  /** Masque un titre de « continuer à regarder » sans toucher à la progression ni aux vus. Il réapparaît à la prochaine progression. */
  router.delete('/profiles/:id/continue/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    users.hideContinue(profile.id, type, titleRef(tmdbId, null), nowIso());
    return sendEmpty(c, 204);
  });

  router.get('/profiles/:id/progress/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const items = users.progressForTitle(profile.id, type, `tmdb:${tmdbId}`);
    return sendJson(c, { items: items.map(toProgressDto) });
  });

  /**
   * Vu / non vu : un film (saison et épisode à 0) ou des épisodes listés. Les épisodes non listés ne sont jamais
   * touchés ; la saison 0 (spéciaux) n'est écrite que si elle figure explicitement dans `episodes`.
   */
  router.put('/profiles/:id/watched', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const body = parseWith(watchedWriteSchema, c.get('body'));
    users.setWatched({
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

  /** `{ movie }` pour un film ; `{ episodes }` pour une série (épisodes avec progression, vus ou en cours). */
  router.get('/profiles/:id/watched/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const rows = users.progressForTitle(profile.id, type, titleRef(tmdbId, null));
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

  router.get('/profiles/:id/follows', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    return sendJson(c, { items: users.listFollows(profile.id) });
  });

  router.put('/profiles/:id/follows/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: FollowType = parseWith(followTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const body = parseWith(followWriteSchema, c.get('body'));
    users.upsertFollow({
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

  router.delete('/profiles/:id/follows/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: FollowType = parseWith(followTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    users.removeFollow(profile.id, type, titleRef(tmdbId, null));
    return sendEmpty(c, 204);
  });

  // Notes sur 5 (demi-étoiles)

  router.get('/profiles/:id/ratings', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const query = parseWith(ratingsQuerySchema, queryParams(c));
    return sendJson(c, { items: users.listRatings(profile.id, query.type) });
  });

  router.put('/profiles/:id/ratings/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    const body = parseWith(ratingWriteSchema, c.get('body'));
    users.upsertRating({
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

  router.delete('/profiles/:id/ratings/:type/:tmdbId', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, c.req.param('type'));
    const tmdbId = parseWith(tmdbIdParam, c.req.param('tmdbId'));
    users.removeRating(profile.id, type, titleRef(tmdbId, null));
    return sendEmpty(c, 204);
  });

  // Réglages

  router.get('/profiles/:id/settings', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    return sendJson(c, { settings: users.listSettings(profile.id) });
  });

  router.put('/profiles/:id/settings', (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
    users.writeSettings(profile.id, settingsEntries(c.get('body')));
    return sendJson(c, { settings: users.listSettings(profile.id) });
  });

  // Import Stremio

  router.post('/profiles/:id/import/stremio', async (c) => {
    const users = db();
    const { profile } = scopeOf(users, c, deps.secret, true);
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

  router.all('*', () => {
    throw new UserApiError(404, 'not_found');
  });
  router.onError(userErrorHandler);

  app.route(USER_MOUNT, router);
  return () => {
    store?.close();
    store = undefined;
  };
}
