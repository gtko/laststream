import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
  librarySortSchema,
  libraryWriteSchema,
  mediaTypeSchema,
  parseWith,
  passwordChangeSchema,
  pinSchema,
  progressWriteSchema,
  stremioImportSchema,
  titleIdParam,
  tmdbIdParam,
  updateProfileSchema,
  UserApiError,
} from './validation.js';

/** Session de connexion : 180 jours, renouvelée (rotation) par POST /user/refresh. */
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
const DEFAULT_KID_MAX_AGE: KidMaxAge = 12;
/** Blocage du PIN : après 5 tentatives échouées, 15 minutes sans vérification. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
const LIMIT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS = { read: 300, write: 120, sensitive: 10, loginPerUsername: 10 } as const;
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

const nowIso = (): string => new Date().toISOString();

function bearerToken(req: Request): string | undefined {
  const match = /^bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(req.get('authorization') ?? '');
  return match?.[1];
}

interface Session {
  /** Empreinte du jeton de session : identifie la session (stockée en base). */
  tokenHash: string;
  account: Account;
}

/** Session valide de la requête (jeton Bearer), ou 401. */
function sessionOf(store: UserStore, req: Request): Session {
  const token = bearerToken(req);
  if (token === undefined) throw new UserApiError(401, 'unauthorized');
  const tokenHash = hashSessionToken(token);
  const account = store.accountForSession(tokenHash, nowIso());
  if (account === undefined) throw new UserApiError(401, 'unauthorized');
  return { tokenHash, account };
}

function profileOf(store: UserStore, account: Account, req: Request): ProfileRecord {
  const profile = store.findProfile(account.id, String(req.params.id));
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
function scopeOf(store: UserStore, req: Request, secret: string, unlock: boolean): Scope {
  const session = sessionOf(store, req);
  const profile = profileOf(store, session.account, req);
  if (unlock && profile.hasPin) {
    const token = req.get('x-profile-token');
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

/**
 * API des données utilisateur, montée sous /user. La base SQLite s'ouvre au premier appel (pas au démarrage) :
 * une application sans routes /user n'écrit jamais de fichier. Renvoie la fermeture de la base.
 */
export function registerUserRoutes(app: Express, deps: AppDeps): () => void {
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

  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Limites par IP : lectures, écritures, routes sensibles (préflights OPTIONS exclus).
  router.use((req, _res, next) => {
    if (req.method === 'OPTIONS') return next();
    const sensitive = SENSITIVE_ROUTES.some((route) => route.method === req.method && route.path.test(req.path));
    const kind = sensitive ? 'sensitive' : req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
    const verdict = limiters[kind](req.ip ?? 'inconnu');
    if (!verdict.allowed) return next(new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec));
    next();
  });

  // Comptes et sessions

  router.post('/register', async (req, res) => {
    const body = parseWith(credentialsSchema, req.body);
    const users = db();
    const allowSignup = isSignupAllowed();
    const isFirst = users.countAccounts() === 0;
    if (!isFirst && !allowSignup) throw new UserApiError(403, 'signup_disabled');
    // Premier compte : jeton d'amorçage exigé si LASTADDON_BOOTSTRAP_TOKEN est défini.
    const required = bootstrapToken();
    if (isFirst && required !== undefined && !safeEqual(req.get('x-bootstrap-token') ?? '', required)) {
      throw new UserApiError(403, 'bootstrap_token_invalid');
    }
    const passwordHash = await hashSecret(body.password);
    const result = users.createAccount({ username: body.username, passwordHash, allowSignup, now: nowIso() });
    if (!result.ok) throw new UserApiError(result.reason === 'username_taken' ? 409 : 403, result.reason);
    res.status(201).json({ account: result.account });
  });

  router.post('/login', async (req, res) => {
    const body = parseWith(credentialsSchema, req.body);
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
    res.json({ token, expiresAt });
  });

  router.post('/refresh', (req, res) => {
    const users = db();
    const session = sessionOf(users, req);
    const token = generateSessionToken();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const rotated = users.rotateSession(session.tokenHash, hashSessionToken(token), session.account.id, now, expiresAt);
    if (!rotated) throw new UserApiError(401, 'unauthorized');
    res.json({ token, expiresAt });
  });

  router.post('/logout', (req, res) => {
    const users = db();
    users.deleteSession(sessionOf(users, req).tokenHash);
    res.status(204).end();
  });

  router.post('/logout-all', (req, res) => {
    const users = db();
    users.deleteAllSessions(sessionOf(users, req).account.id);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    res.json({ account: sessionOf(db(), req).account });
  });

  /** Change le mot de passe ; révoque les autres sessions. Le mot de passe actuel est exigé. */
  router.post('/password', async (req, res) => {
    const users = db();
    const session = sessionOf(users, req);
    const body = parseWith(passwordChangeSchema, req.body);
    const record = users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.current, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    users.changePassword(session.account.id, await hashSecret(body.next), session.tokenHash);
    res.status(204).end();
  });

  /** Supprime le compte et toutes ses données. Le mot de passe est exigé. */
  router.delete('/account', async (req, res) => {
    const users = db();
    const session = sessionOf(users, req);
    const body = parseWith(deleteAccountSchema, req.body);
    const record = users.accountRecordById(session.account.id);
    if (record === undefined || !(await verifySecret(body.password, record.passwordHash))) {
      throw new UserApiError(403, 'invalid_password');
    }
    users.deleteAccount(session.account.id);
    res.status(204).end();
  });

  // Profils

  router.get('/profiles', (req, res) => {
    const { account } = sessionOf(db(), req);
    res.json({ profiles: db().listProfiles(account.id).map(publicProfile) });
  });

  router.post('/profiles', async (req, res) => {
    const { account } = sessionOf(db(), req);
    const body = parseWith(createProfileSchema, req.body);
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
    res.status(201).json(publicProfile(created));
  });

  router.patch('/profiles/:id', async (req, res) => {
    const users = db();
    const { account, profile } = scopeOf(users, req, deps.secret, true);
    const patch = parseWith(updateProfileSchema, req.body);
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
    res.json(publicProfile(updated));
  });

  router.delete('/profiles/:id', (req, res) => {
    const users = db();
    const { account, profile } = scopeOf(users, req, deps.secret, true);
    users.deleteProfile(account.id, profile.id);
    res.status(204).end();
  });

  /**
   * Déverrouillage par PIN : jeton de profil (30 jours), lié à la session et à la version du PIN. Cinq échecs
   * bloquent le profil 15 minutes : pendant le blocage, le PIN n'est même pas vérifié (429 pin_locked).
   */
  router.post('/profiles/:id/unlock', async (req, res) => {
    const users = db();
    const { account, profile, tokenHash } = scopeOf(users, req, deps.secret, false);
    const { pin } = parseWith(pinSchema, req.body);
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
      res.json(signProfileToken(claims, Date.now(), deps.secret));
      return;
    }
    const lockedNow = users.pinLockedUntil(profile.id, nowIso());
    if (lockedNow !== null) throw pinLocked(lockedNow);
    throw new UserApiError(403, 'invalid_pin');
  });

  /**
   * Verrouillage explicite, appelé par le client au changement de profil. Sans effet côté serveur : le jeton reste
   * valable jusqu'à déconnexion, changement de PIN ou expiration. Le profil doit appartenir au compte.
   */
  router.post('/profiles/:id/lock', (req, res) => {
    scopeOf(db(), req, deps.secret, false);
    res.status(204).end();
  });

  // Bibliothèque

  router.get('/profiles/:id/library', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const query = parseWith(librarySortSchema, req.query);
    res.json({ items: users.listLibrary(profile.id, query.type, query.sort) });
  });

  router.put('/profiles/:id/library/:type/:itemId', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, req.params.type);
    const itemId = parseWith(titleIdParam, req.params.itemId);
    const body = parseWith(libraryWriteSchema, req.body);
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
    res.status(204).end();
  });

  router.delete('/profiles/:id/library/:type/:itemId', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, req.params.type);
    const itemId = parseWith(titleIdParam, req.params.itemId);
    const key = titleKey(itemId, undefined);
    users.removeLibraryItem(profile.id, type, titleRef(key.tmdbId, key.imdbId));
    res.status(204).end();
  });

  // Progression

  router.put('/profiles/:id/progress', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const normalized = normalizeProgress(parseWith(progressWriteSchema, req.body));
    users.upsertProgress({ profileId: profile.id, ...normalized, updatedAt: nowIso() });
    const saved = users.progressEpisode(
      profile.id,
      normalized.type,
      titleRef(normalized.tmdbId, normalized.imdbId),
      normalized.season,
      normalized.episode,
    );
    if (saved === undefined) throw new Error('progression introuvable après écriture');
    res.json({ item: toProgressDto(saved) });
  });

  router.get('/profiles/:id/continue', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const items = continueWatching(users.latestProgressPerTitle(profile.id), (type, ref, season, episode) =>
      users.progressEpisode(profile.id, type, ref, season, episode),
    );
    res.json({ items });
  });

  router.get('/profiles/:id/progress/:type/:tmdbId', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const type: MediaType = parseWith(mediaTypeSchema, req.params.type);
    const tmdbId = parseWith(tmdbIdParam, req.params.tmdbId);
    const items = users.progressForTitle(profile.id, type, `tmdb:${tmdbId}`);
    res.json({ items: items.map(toProgressDto) });
  });

  // Réglages

  router.get('/profiles/:id/settings', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    res.json({ settings: users.listSettings(profile.id) });
  });

  router.put('/profiles/:id/settings', (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    users.writeSettings(profile.id, settingsEntries(req.body));
    res.json({ settings: users.listSettings(profile.id) });
  });

  // Import Stremio

  router.post('/profiles/:id/import/stremio', async (req, res) => {
    const users = db();
    const { profile } = scopeOf(users, req, deps.secret, true);
    const body = parseWith(stremioImportSchema, req.body);
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
      res.json(result);
    } catch (err) {
      if (err instanceof StremioImportError) {
        throw new UserApiError(err.code === 'stremio_login_failed' ? 422 : 502, err.code);
      }
      throw err;
    }
  });

  router.use((_req, _res, next) => next(new UserApiError(404, 'not_found')));
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof UserApiError) {
      if (err.retryAfterSec !== undefined) res.setHeader('Retry-After', String(err.retryAfterSec));
      res.status(err.status).json(err.issues === undefined ? { error: err.code } : { error: err.code, issues: err.issues });
      return;
    }
    next(err);
  });

  app.use('/user', router);
  return () => {
    store?.close();
    store = undefined;
  };
}
