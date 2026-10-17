import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { isSignupAllowed } from '../config/runtime-env.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { createLtContext, type LtContext } from '../lt/context.js';
import { isRecord } from '../sources/http.js';
import { openUserDb, userDbPath } from './db.js';
import {
  generateSessionToken,
  hashSecret,
  hashSessionToken,
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
  type Profile,
  type ProfileFields,
  type ProfileRecord,
  type ProgressItem,
  titleRef,
  UserStore,
} from './store.js';
import {
  createProfileSchema,
  credentialsSchema,
  librarySortSchema,
  libraryWriteSchema,
  mediaTypeSchema,
  parseWith,
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
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_SETTINGS_PER_WRITE = 100;
const MAX_SETTING_BYTES = 4096;

const nowIso = (): string => new Date().toISOString();

function bearerToken(req: Request): string | undefined {
  const match = /^bearer\s+([A-Za-z0-9_-]{20,128})$/i.exec(req.get('authorization') ?? '');
  return match?.[1];
}

/** Session valide de la requête (jeton Bearer), ou 401. */
function sessionOf(store: UserStore, req: Request): { token: string; account: Account } {
  const token = bearerToken(req);
  const account = token === undefined ? undefined : store.accountForSession(hashSessionToken(token), nowIso());
  if (token === undefined || account === undefined) throw new UserApiError(401, 'unauthorized');
  return { token, account };
}

function profileOf(store: UserStore, account: Account, req: Request): ProfileRecord {
  const profile = store.findProfile(account.id, String(req.params.id));
  if (profile === undefined) throw new UserApiError(404, 'profile_not_found');
  return profile;
}

/** Profil avec PIN : modification et suppression exigent un déverrouillage récent (jeton de profil). */
function requireUnlockedIfProtected(req: Request, profile: ProfileRecord, accountId: string, secret: string): void {
  if (!profile.hasPin) return;
  const token = req.get('x-profile-token');
  if (token === undefined || !verifyProfileToken(token, accountId, profile.id, Date.now(), secret)) {
    throw new UserApiError(403, 'pin_required');
  }
}

function toPublicProfile(record: ProfileRecord): Profile {
  const { accountId: _accountId, pinHash: _pinHash, ...profile } = record;
  return profile;
}

function toProgressDto(item: ProgressItem) {
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
 * une application sans routes /user n'écrit jamais de fichier.
 */
export function registerUserRoutes(app: Express, deps: AppDeps): () => void {
  let store: UserStore | undefined;
  const db = (): UserStore => {
    if (store === undefined) store = new UserStore(openUserDb(deps.userDbPath ?? userDbPath()));
    return store;
  };
  const ctx: LtContext = createLtContext(deps);

  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Comptes et sessions

  router.post('/register', async (req, res) => {
    const body = parseWith(credentialsSchema, req.body);
    const users = db();
    const allowSignup = isSignupAllowed();
    if (!allowSignup && users.countAccounts() > 0) throw new UserApiError(403, 'signup_disabled');
    const passwordHash = await hashSecret(body.password);
    const result = users.createAccount({ username: body.username, passwordHash, allowSignup, now: nowIso() });
    if (!result.ok) throw new UserApiError(result.reason === 'username_taken' ? 409 : 403, result.reason);
    res.status(201).json({ account: result.account });
  });

  router.post('/login', async (req, res) => {
    const body = parseWith(credentialsSchema, req.body);
    const users = db();
    const record = users.findAccountRecord(body.username);
    // Même coût de calcul que pour un compte existant : le délai ne révèle pas si le nom existe.
    if (record === undefined) await hashSecret(body.password);
    const valid = record !== undefined && (await verifySecret(body.password, record.passwordHash));
    if (record === undefined || !valid) throw new UserApiError(401, 'invalid_credentials');
    const now = nowIso();
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    users.deleteExpiredSessions(record.id, now);
    users.createSession(record.id, hashSessionToken(token), now, expiresAt);
    res.json({ token, expiresAt });
  });

  router.post('/refresh', (req, res) => {
    const users = db();
    const session = sessionOf(users, req);
    const token = generateSessionToken();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const rotated = users.rotateSession(hashSessionToken(session.token), hashSessionToken(token), session.account.id, now, expiresAt);
    if (!rotated) throw new UserApiError(401, 'unauthorized');
    res.json({ token, expiresAt });
  });

  router.post('/logout', (req, res) => {
    const users = db();
    const session = sessionOf(users, req);
    users.deleteSession(hashSessionToken(session.token));
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    res.json({ account: sessionOf(db(), req).account });
  });

  // Profils

  router.get('/profiles', (req, res) => {
    const { account } = sessionOf(db(), req);
    res.json({ profiles: db().listProfiles(account.id).map(toPublicProfile) });
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
    res.status(201).json(toPublicProfile(created));
  });

  router.patch('/profiles/:id', async (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    requireUnlockedIfProtected(req, profile, account.id, deps.secret);
    const patch = parseWith(updateProfileSchema, req.body);
    const isKid = patch.isKid ?? profile.isKid;
    let pinHash = profile.pinHash;
    if (patch.pin !== undefined) pinHash = patch.pin === null ? null : await hashSecret(patch.pin);
    const fields: ProfileFields = {
      name: patch.name ?? profile.name,
      avatarColor: patch.avatarColor ?? profile.avatarColor,
      isKid,
      kidMaxAge: isKid ? (patch.kidMaxAge ?? profile.kidMaxAge ?? DEFAULT_KID_MAX_AGE) : null,
      pinHash,
      allowedCatalogs: patch.allowedCatalogs ?? profile.allowedCatalogs,
    };
    users.updateProfile(account.id, profile.id, fields);
    const updated = users.findProfile(account.id, profile.id);
    if (updated === undefined) throw new Error('profil introuvable après mise à jour');
    res.json(toPublicProfile(updated));
  });

  router.delete('/profiles/:id', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    requireUnlockedIfProtected(req, profile, account.id, deps.secret);
    users.deleteProfile(account.id, profile.id);
    res.status(204).end();
  });

  /** Déverrouillage par PIN : jeton court (10 minutes) lié à ce profil, requis pour modifier ou supprimer un profil protégé. */
  router.post('/profiles/:id/unlock', async (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    const { pin } = parseWith(pinSchema, req.body);
    if (profile.pinHash === null) throw new UserApiError(409, 'pin_not_set');
    if (!(await verifySecret(pin, profile.pinHash))) throw new UserApiError(403, 'invalid_pin');
    res.json(signProfileToken(account.id, profile.id, Date.now(), deps.secret));
  });

  // Bibliothèque

  router.get('/profiles/:id/library', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    const query = parseWith(librarySortSchema, req.query);
    res.json({ items: users.listLibrary(profile.id, query.type, query.sort) });
  });

  router.put('/profiles/:id/library/:type/:itemId', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
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
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    const type: MediaType = parseWith(mediaTypeSchema, req.params.type);
    const itemId = parseWith(titleIdParam, req.params.itemId);
    const key = titleKey(itemId, undefined);
    users.removeLibraryItem(profile.id, type, titleRef(key.tmdbId, key.imdbId));
    res.status(204).end();
  });

  // Progression

  router.put('/profiles/:id/progress', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
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
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    const items = continueWatching(users.latestProgressPerTitle(profile.id), (type, ref, season, episode) =>
      users.progressEpisode(profile.id, type, ref, season, episode),
    );
    res.json({ items });
  });

  router.get('/profiles/:id/progress/:type/:tmdbId', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    const type: MediaType = parseWith(mediaTypeSchema, req.params.type);
    const tmdbId = parseWith(tmdbIdParam, req.params.tmdbId);
    const items = users.progressForTitle(profile.id, type, `tmdb:${tmdbId}`);
    res.json({ items: items.map(toProgressDto) });
  });

  // Réglages

  router.get('/profiles/:id/settings', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    res.json({ settings: users.listSettings(profile.id) });
  });

  router.put('/profiles/:id/settings', (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
    users.writeSettings(profile.id, settingsEntries(req.body));
    res.json({ settings: users.listSettings(profile.id) });
  });

  // Import Stremio

  router.post('/profiles/:id/import/stremio', async (req, res) => {
    const users = db();
    const { account } = sessionOf(users, req);
    const profile = profileOf(users, account, req);
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
