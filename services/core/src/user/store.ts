import { randomUUID } from 'node:crypto';
import { readAppSettings } from './app-settings.js';
import {
  type HouseholdCreateResult,
  type HouseholdInviteRow,
  type HouseholdInviteView,
  type HouseholdInviteWrite,
  type HouseholdRedeemInput,
  type HouseholdRedeemResult,
  type ProfileLoginRecord,
} from './household.js';
import { storedUserAgent } from './session-device.js';
import { linkInvitedPrincipals, purgeSocialData, syncProfileIdentity } from './social-handles.js';
import { redeemInvite } from './social-store.js';
import type { SqlDb } from './sql.js';
import {
  accountHasProgress,
  countryCode,
  purgeTitleStarts,
  RETENTION_DAYS,
  recordTitleStart,
  shiftDay,
  type TitleStart,
  titleStartKey,
  topTitleStarts,
  utcDay,
} from './title-starts.js';

export type MediaType = 'movie' | 'series';
export const KID_MAX_AGES = [10, 12, 16, 18] as const;
export type KidMaxAge = (typeof KID_MAX_AGES)[number];
export type LibrarySort = 'added' | 'title';

/** Sessions simultanées par compte (libres) et par profil verrouillé : au-delà, la plus ancienne est supprimée. */
const MAX_SESSIONS_PER_ACCOUNT = 20;

/** Intervalle minimal entre deux écritures de la dernière activité d'une session (pas d'écriture à chaque requête). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

/** Référence d'un titre : `tmdb:<id>` si l'identifiant TMDB est connu, sinon `imdb:<tt…>`. */
export function titleRef(tmdbId: number | null, imdbId: string | null): string {
  if (tmdbId !== null) return `tmdb:${tmdbId}`;
  if (imdbId !== null) return `imdb:${imdbId}`;
  throw new Error('titleRef : identifiant TMDB ou IMDb requis');
}

export interface Account {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
}

export interface AccountRecord extends Account {
  passwordHash: string;
  /** Compte suspendu par l'administration : connexion et sessions refusées. */
  suspended: boolean;
}

/** Compte d'une session valide, et profil auquel la session est verrouillée (null = session libre). */
export type SessionAccount = Account & { lockedProfileId: string | null };

/** Profil tel que vu par le client : aucun secret, aucun compteur de PIN. */
export interface Profile {
  id: string;
  name: string;
  avatarColor: string;
  /** Avatar illustré (`dicebear:<style>:<graine>`), ou null : initiale sur la couleur. */
  avatar: string | null;
  isKid: boolean;
  kidMaxAge: KidMaxAge | null;
  hasPin: boolean;
  allowedCatalogs: string[];
  createdAt: string;
}

/** Profil avec ses champs internes (hash du PIN, compteurs de tentatives, version du PIN) : usage serveur uniquement. */
export interface ProfileRecord extends Profile {
  accountId: string;
  pinHash: string | null;
  pinVersion: number;
  pinFailures: number;
  pinLockedUntil: string | null;
}

export interface ProfileFields {
  name: string;
  avatarColor: string;
  avatar: string | null;
  isKid: boolean;
  kidMaxAge: KidMaxAge | null;
  pinHash: string | null;
  allowedCatalogs: string[];
}

export type ProfileEditableFields = Omit<ProfileFields, 'pinHash'>;

export interface LibraryItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
  /** Qui peut voir ce titre : « private » (défaut) ou « friends » (amis du compte). */
  visibility: 'private' | 'friends';
}

export interface LibraryWrite {
  profileId: string;
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
}

export interface ProgressItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  /** Saison et épisode ; 0 pour un film. */
  season: number;
  episode: number;
  positionSec: number;
  durationSec: number;
  updatedAt: string;
  finished: boolean;
  titleRef: string;
}

export interface ProgressWrite {
  profileId: string;
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  season: number;
  episode: number;
  positionSec: number;
  durationSec: number;
  updatedAt: string;
  finished: boolean;
  /**
   * Pays de la requête (écriture de l'application). Présent : la première progression du compte sur ce titre compte un
   * lancement (agrégat title_starts). Absent (import Stremio) : aucun lancement compté.
   */
  country?: string;
}

/** Un suivi peut aussi viser une personne (acteur, réalisateur) : pas de saison ni d'épisode. */
export type FollowType = MediaType | 'person';

/** Un titre de l'historique « vu » : `watched` compte le film (1) ou les épisodes vus hors saison 0. */
export interface WatchedTitleItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  watched: number;
  lastWatchedAt: string;
}

export interface WatchedWrite {
  profileId: string;
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  /** Épisodes visés ; un film a un seul élément (0, 0). */
  episodes: readonly { season: number; episode: number }[];
  watched: boolean;
  updatedAt: string;
}

export interface FollowItem {
  type: FollowType;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  followedAt: string;
  notify: boolean;
}

export interface FollowWrite extends Omit<FollowItem, 'followedAt'> {
  profileId: string;
  followedAt: string;
}

export interface RatingItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  title: string | null;
  /** Note sur 5, par pas de 0,5. */
  rating: number;
  ratedAt: string;
}

export interface RatingWrite extends Omit<RatingItem, 'ratedAt'> {
  profileId: string;
  ratedAt: string;
}

interface FollowRow {
  type: FollowType;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  poster: string | null;
  followed_at: string;
  notify: number;
}

interface RatingRow {
  type: MediaType;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string | null;
  rating: number;
  rated_at: string;
}

function toFollowItem(row: FollowRow): FollowItem {
  return {
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    title: row.title,
    poster: row.poster,
    followedAt: row.followed_at,
    notify: row.notify === 1,
  };
}

function toRatingItem(row: RatingRow): RatingItem {
  return {
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    title: row.title,
    rating: row.rating,
    ratedAt: row.rated_at,
  };
}

export type SettingsMap = Record<string, unknown>;

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  is_owner: number;
  created_at: string;
  suspended_at?: string | null;
}

interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  avatar_color: string;
  avatar?: string | null;
  is_kid: number;
  kid_max_age: number | null;
  pin_hash: string | null;
  pin_version: number;
  pin_failures: number;
  pin_locked_until: string | null;
  allowed_catalogs: string;
  created_at: string;
}

interface LibraryRow {
  type: MediaType;
  title_ref: string;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  poster: string | null;
  added_at: string;
  visibility: 'private' | 'friends';
}

interface ProgressRow {
  type: MediaType;
  title_ref: string;
  tmdb_id: number | null;
  imdb_id: string | null;
  season: number;
  episode: number;
  position_sec: number;
  duration_sec: number;
  updated_at: string;
  finished: number;
}

interface WatchedTitleRow {
  type: MediaType;
  tmdb_id: number | null;
  imdb_id: string | null;
  watched: number;
  last_watched_at: string;
}

interface SettingRow {
  key: string;
  value: string;
}

export type CreateAccountResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'signup_disabled' | 'username_taken' | 'invite_invalid' | 'invite_expired' | 'invites_closed' };

function toAccount(row: Omit<AccountRow, 'password_hash'>): Account {
  return { id: row.id, username: row.username, isOwner: row.is_owner === 1, createdAt: row.created_at };
}

function parseCatalogs(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toProfileRecord(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    avatarColor: row.avatar_color,
    avatar: row.avatar ?? null,
    isKid: row.is_kid === 1,
    kidMaxAge: row.kid_max_age === null ? null : (row.kid_max_age as KidMaxAge),
    hasPin: row.pin_hash !== null,
    pinHash: row.pin_hash,
    pinVersion: row.pin_version,
    pinFailures: row.pin_failures,
    pinLockedUntil: row.pin_locked_until,
    allowedCatalogs: parseCatalogs(row.allowed_catalogs),
    createdAt: row.created_at,
  };
}

/** Champs publics d'un profil (liste explicite : aucun champ interne ne sort du serveur). */
export function publicProfile(record: ProfileRecord): Profile {
  return {
    id: record.id,
    name: record.name,
    avatarColor: record.avatarColor,
    avatar: record.avatar,
    isKid: record.isKid,
    kidMaxAge: record.kidMaxAge,
    hasPin: record.hasPin,
    allowedCatalogs: record.allowedCatalogs,
    createdAt: record.createdAt,
  };
}

function toLibraryItem(row: LibraryRow): LibraryItem {
  return {
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    title: row.title,
    poster: row.poster,
    addedAt: row.added_at,
    visibility: row.visibility,
  };
}

function toProgressItem(row: ProgressRow): ProgressItem {
  return {
    type: row.type,
    tmdbId: row.tmdb_id,
    imdbId: row.imdb_id,
    season: row.season,
    episode: row.episode,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    updatedAt: row.updated_at,
    finished: row.finished === 1,
    titleRef: row.title_ref,
  };
}

/**
 * Accès aux données utilisateur (SQLite synchrone, node:sqlite). Toutes les requêtes sont paramétrées. Les écritures
 * multiples passent par `transaction`. Les jetons de session ne sont jamais stockés en clair : l'appelant fournit
 * leur empreinte.
 */
export class UserStore {
  /** Dernier jour pour lequel les lancements anciens ont été purgés (au plus une purge par jour). */
  private startsPurgedOn: string | undefined;

  constructor(private readonly db: SqlDb) {}

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  /** Ferme la base (fichier libéré). Ne plus utiliser le store ensuite. */
  close(): void {
    this.db.close();
  }

  // Comptes

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
    return Number(row?.n ?? 0);
  }

  findAccountRecord(username: string): AccountRecord | undefined {
    const row = this.db
      .prepare('SELECT id, username, password_hash, is_owner, created_at, suspended_at FROM accounts WHERE username = ?')
      .get(username) as AccountRow | undefined;
    if (row === undefined) return undefined;
    return { ...toAccount(row), passwordHash: row.password_hash, suspended: row.suspended_at != null };
  }

  accountRecordById(accountId: string): AccountRecord | undefined {
    const row = this.db
      .prepare('SELECT id, username, password_hash, is_owner, created_at, suspended_at FROM accounts WHERE id = ?')
      .get(accountId) as AccountRow | undefined;
    if (row === undefined) return undefined;
    return { ...toAccount(row), passwordHash: row.password_hash, suspended: row.suspended_at != null };
  }

  /**
   * Crée un compte. Le contrôle des droits (inscription ouverte ou premier compte) et l'unicité du nom sont faits
   * dans la même transaction que l'insertion : deux inscriptions simultanées ne peuvent pas créer deux « premiers » comptes.
   */
  createAccount(input: {
    username: string;
    passwordHash: string;
    allowSignup: boolean;
    /** Code d'un lien de parrainage : consommé dans la même transaction, le filleul devient ami du parrain. */
    inviteCode?: string;
    /** Avec un lien : false = aucune amitié créée (ni compte, ni profils). Défaut : true. */
    autoFriend?: boolean;
    now: string;
  }): CreateAccountResult {
    return this.transaction((): CreateAccountResult => {
      const isFirst = this.countAccounts() === 0;
      const invite = !isFirst && input.inviteCode !== undefined;
      if (!isFirst && !invite && !input.allowSignup) return { ok: false, reason: 'signup_disabled' };
      const settings = readAppSettings(this.db);
      // Inscriptions par lien fermées par l'administration (le tout premier compte n'est jamais concerné).
      if (invite && !settings.invitesOpen) return { ok: false, reason: 'invites_closed' };
      // Un identifiant de profil du foyer (login d'invité) réserve aussi le nom : un seul espace de noms.
      if (this.findAccountRecord(input.username) !== undefined) return { ok: false, reason: 'username_taken' };
      if (this.db.prepare('SELECT 1 AS n FROM profile_logins WHERE login = ?').get(input.username) !== undefined) {
        return { ok: false, reason: 'username_taken' };
      }
      if (invite && input.inviteCode !== undefined) {
        // Lien inconnu, déjà utilisé ou révoqué par l'administration : refusé de la même façon.
        const row = this.db.prepare('SELECT used_at, revoked_at, expires_at FROM invites WHERE code = ?').get(input.inviteCode) as
          | { used_at: string | null; revoked_at: string | null; expires_at: number | null }
          | undefined;
        if (row === undefined || row.used_at !== null || row.revoked_at !== null) return { ok: false, reason: 'invite_invalid' };
        // Billet envoyé il y a plus de 14 jours et non utilisé : refusé (le propriétaire le libère à sa prochaine consultation).
        if (row.expires_at !== null && Number(row.expires_at) <= Date.parse(input.now)) return { ok: false, reason: 'invite_expired' };
      }
      const account: Account = {
        id: randomUUID(),
        username: input.username,
        isOwner: isFirst,
        createdAt: input.now,
      };
      this.db
        .prepare('INSERT INTO accounts (id, username, password_hash, is_owner, created_at, invite_quota) VALUES (?, ?, ?, ?, ?, ?)')
        .run(account.id, account.username, input.passwordHash, isFirst ? 1 : 0, account.createdAt, settings.inviteDefaultQuota);
      if (invite && input.inviteCode !== undefined && !redeemInvite(this.db, input.inviteCode, account.id, input.now, input.autoFriend !== false).ok) {
        throw new Error('lien de parrainage consommé en cours d\'inscription'); // annule la transaction (inatteignable : synchrone)
      }
      return { ok: true, account };
    });
  }

  /** Change le mot de passe et révoque toutes les sessions sauf celle qui le change (`keepHash`). */
  changePassword(accountId: string, passwordHash: string, keepHash: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, accountId);
      this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').run(accountId, keepHash);
    });
  }

  /** Supprime le compte et, en cascade, sessions, profils, bibliothèques, progressions et réglages. */
  deleteAccount(accountId: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  // Sessions

  /**
   * Ouvre une session. Les sessions expirées sont purgées et le compte garde au plus MAX_SESSIONS_PER_ACCOUNT
   * sessions : la plus ancienne (ordre d'insertion) est supprimée au-delà. `userAgent` (en-tête de la requête) est
   * conservé tronqué, pour la fiche administrateur.
   */
  /**
   * Ouvre une session. Les sessions expirées sont purgées et le compte garde au plus MAX_SESSIONS_PER_ACCOUNT
   * sessions : la plus ancienne (ordre d'insertion) est supprimée au-delà. `userAgent` (en-tête de la requête) est
   * conservé tronqué, pour la fiche administrateur. `profileId` : session verrouillée sur ce profil (invitation).
   */
  startSession(accountId: string, tokenHash: string, now: string, expiresAt: string, userAgent?: string | null, profileId?: string | null): void {
    this.transaction(() => this.openSession(accountId, tokenHash, now, expiresAt, userAgent, profileId ?? null));
  }

  /**
   * Corps de startSession, à appeler dans une transaction. Le plafond et l'éviction se comptent par (compte, profil
   * verrouillé) : une session libre (profile_id NULL) ne compte ni n'évince jamais une session verrouillée, et
   * réciproquement.
   */
  private openSession(accountId: string, tokenHash: string, now: string, expiresAt: string, userAgent: string | null | undefined, profileId: string | null): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?').run(accountId, now);
    this.createSession(accountId, tokenHash, now, expiresAt, userAgent, profileId);
    this.db
      .prepare(
        `DELETE FROM sessions WHERE account_id = ? AND profile_id IS ? AND rowid NOT IN (
           SELECT rowid FROM sessions WHERE account_id = ? AND profile_id IS ? ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(accountId, profileId, accountId, profileId, MAX_SESSIONS_PER_ACCOUNT);
  }

  private createSession(
    accountId: string,
    tokenHash: string,
    createdAt: string,
    expiresAt: string,
    userAgent?: string | null,
    profileId: string | null = null,
  ): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, user_agent, profile_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tokenHash, accountId, createdAt, expiresAt, storedUserAgent(userAgent), profileId);
  }

  /**
   * Compte lié à une session valide (non expirée), ou undefined, avec le profil verrouillé de la session. Met aussi la
   * dernière activité de la session à jour, au plus une fois toutes les SESSION_TOUCH_INTERVAL_MS. Une session
   * verrouillée sur un profil supprimé n'est plus valide.
   */
  accountForSession(tokenHash: string, now: string): SessionAccount | undefined {
    const row = this.db
      .prepare(
        `SELECT a.id, a.username, a.is_owner, a.created_at, s.last_seen_at, s.profile_id
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND a.suspended_at IS NULL
           AND (s.profile_id IS NULL OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = s.profile_id))`,
      )
      .get(tokenHash, now) as (Omit<AccountRow, 'password_hash'> & { last_seen_at: number | null; profile_id: string | null }) | undefined;
    if (row === undefined) return undefined;
    const nowMs = Date.parse(now);
    if (row.last_seen_at === null || nowMs - Number(row.last_seen_at) >= SESSION_TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowMs, tokenHash);
    }
    return { ...toAccount(row), lockedProfileId: row.profile_id ?? null };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Révoque toutes les autres sessions du compte (celle de `keepHash` reste ouverte). */
  deleteOtherSessions(accountId: string, keepHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').run(accountId, keepHash);
  }

  deleteAllSessions(accountId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
  }

  /** Révoque les sessions verrouillées sur un profil (et seulement celles-là) : « déconnecter partout » depuis ce profil. */
  deleteProfileSessions(accountId: string, profileId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND profile_id = ?').run(accountId, profileId);
  }

  /** Rotation : remplace une session valide par une nouvelle (qui garde son éventuel profil verrouillé). False si l'ancienne n'était plus valide. */
  rotateSession(oldHash: string, newHash: string, accountId: string, now: string, expiresAt: string, userAgent?: string | null): boolean {
    return this.transaction(() => {
      const old = this.db
        .prepare('SELECT profile_id FROM sessions WHERE token_hash = ? AND account_id = ? AND expires_at > ?')
        .get(oldHash, accountId, now) as { profile_id: string | null } | undefined;
      if (old === undefined) return false;
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ? AND account_id = ? AND expires_at > ?').run(oldHash, accountId, now);
      this.createSession(accountId, newHash, now, expiresAt, userAgent, old.profile_id ?? null);
      return true;
    });
  }

  // Profils

  listProfiles(accountId: string): ProfileRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM profiles WHERE account_id = ? ORDER BY created_at, id')
      .all(accountId) as unknown as ProfileRow[];
    return rows.map(toProfileRecord);
  }

  findProfile(accountId: string, profileId: string): ProfileRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM profiles WHERE id = ? AND account_id = ?')
      .get(profileId, accountId) as ProfileRow | undefined;
    return row === undefined ? undefined : toProfileRecord(row);
  }

  insertProfile(accountId: string, profileId: string, fields: ProfileFields, createdAt: string): void {
    this.transaction(() => {
      const adults = Number((this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ? AND is_kid = 0').get(accountId) as { n: number }).n);
      this.db
        .prepare(
          `INSERT INTO profiles (id, account_id, name, avatar_color, avatar, is_kid, kid_max_age, pin_hash, allowed_catalogs, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profileId,
          accountId,
          fields.name,
          fields.avatarColor,
          fields.avatar,
          fields.isKid ? 1 : 0,
          fields.kidMaxAge,
          fields.pinHash,
          JSON.stringify(fields.allowedCatalogs),
          createdAt,
        );
      syncProfileIdentity(this.db, accountId, profileId, fields.name, fields.isKid);
      // Premier profil adulte du compte = profil principal : c'est là que se posent les amitiés d'invitation (v2).
      if (!fields.isKid && adults === 0) linkInvitedPrincipals(this.db, accountId, Date.now());
    });
  }

  /**
   * Champs modifiables ; le PIN (haché, `null` pour le retirer) n'est touché que s'il est fourni, dans la même
   * transaction (voir setPin).
   */
  updateProfile(accountId: string, profileId: string, fields: ProfileEditableFields, pinHash?: string | null): void {
    this.transaction(() => {
      this.updateProfileFields(accountId, profileId, fields);
      if (pinHash !== undefined) this.setPin(accountId, profileId, pinHash);
      syncProfileIdentity(this.db, accountId, profileId, fields.name, fields.isKid);
      // Un profil enfant n'a pas d'identifiant d'invité : passer en enfant retire le login et les sessions verrouillées.
      if (fields.isKid) this.removeProfileLogin(profileId);
    });
  }

  /**
   * Retire l'identifiant d'invité d'un profil et toutes ses sessions verrouillées. Renvoie vrai si un identifiant existait.
   * À appeler dans une transaction.
   */
  private removeProfileLogin(profileId: string): boolean {
    this.db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(profileId);
    return Number(this.db.prepare('DELETE FROM profile_logins WHERE profile_id = ?').run(profileId).changes) > 0;
  }

  /**
   * Supprime l'identifiant d'invité d'un profil du compte, avec ses sessions verrouillées, en une transaction. Le lien du
   * foyer déjà utilisé reste utilisé. False (rien écrit) si le profil n'a pas d'identifiant.
   */
  deleteProfileLogin(accountId: string, profileId: string): boolean {
    return this.transaction((): boolean => {
      const row = this.db.prepare('SELECT 1 AS n FROM profile_logins WHERE profile_id = ? AND account_id = ?').get(profileId, accountId);
      if (row === undefined) return false;
      return this.removeProfileLogin(profileId);
    });
  }

  private updateProfileFields(accountId: string, profileId: string, fields: ProfileEditableFields): void {
    this.db
      .prepare(
        `UPDATE profiles SET name = ?, avatar_color = ?, avatar = ?, is_kid = ?, kid_max_age = ?, allowed_catalogs = ?
         WHERE id = ? AND account_id = ?`,
      )
      .run(
        fields.name,
        fields.avatarColor,
        fields.avatar,
        fields.isKid ? 1 : 0,
        fields.kidMaxAge,
        JSON.stringify(fields.allowedCatalogs),
        profileId,
        accountId,
      );
  }

  /**
   * Pose ou retire le PIN. Incrémente la version du PIN (les jetons de profil émis avant deviennent invalides) et
   * remet à zéro les tentatives et le blocage.
   */
  setPin(accountId: string, profileId: string, pinHash: string | null): void {
    this.db
      .prepare(
        `UPDATE profiles SET pin_hash = ?, pin_version = pin_version + 1, pin_failures = 0, pin_locked_until = NULL
         WHERE id = ? AND account_id = ?`,
      )
      .run(pinHash, profileId, accountId);
  }

  /**
   * Réserve une tentative de PIN, avant toute vérification. Renvoie l'échéance du blocage si le profil est bloqué
   * (rien n'est alors compté ni vérifié). Sinon compte la tentative ; à `maxFailures`, bloque jusqu'à `lockedUntil`.
   */
  reservePinAttempt(profileId: string, now: string, lockedUntil: string, maxFailures: number): string | null {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT pin_failures, pin_locked_until FROM profiles WHERE id = ?')
        .get(profileId) as { pin_failures: number; pin_locked_until: string | null } | undefined;
      if (row === undefined) return null;
      if (row.pin_locked_until !== null && row.pin_locked_until > now) return row.pin_locked_until;
      const failures = row.pin_failures + 1;
      if (failures >= maxFailures) {
        this.db.prepare('UPDATE profiles SET pin_failures = 0, pin_locked_until = ? WHERE id = ?').run(lockedUntil, profileId);
      } else {
        this.db.prepare('UPDATE profiles SET pin_failures = ? WHERE id = ?').run(failures, profileId);
      }
      return null;
    });
  }

  /** Échéance du blocage du PIN si elle est dans le futur, sinon null. */
  pinLockedUntil(profileId: string, now: string): string | null {
    const row = this.db.prepare('SELECT pin_locked_until FROM profiles WHERE id = ?').get(profileId) as
      | { pin_locked_until: string | null }
      | undefined;
    if (row === undefined || row.pin_locked_until === null || row.pin_locked_until <= now) return null;
    return row.pin_locked_until;
  }

  /** Déverrouillage réussi : compteur et blocage remis à zéro. */
  resetPinAttempts(profileId: string): void {
    this.db.prepare('UPDATE profiles SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?').run(profileId);
  }

  deleteProfile(accountId: string, profileId: string): boolean {
    return this.transaction(() => {
      // Profil supprimé : ses données sociales sont retirées explicitement (amitiés legacy compte↔compte, relations, groupes
      // vides supprimés et propriété transmise, listes, liens publics et invitation réservée), avant la ligne du profil. Les
      // clés étrangères sur pid (ON DELETE CASCADE) cascaderaient aussi, mais ne règlent ni les groupes ni les invitations.
      const row = this.db.prepare('SELECT pid FROM profiles WHERE id = ? AND account_id = ?').get(profileId, accountId) as
        | { pid: string | null }
        | undefined;
      if (row === undefined) return false;
      if (row.pid) purgeSocialData(this.db, row.pid);
      // Login du profil (invité du foyer) et sessions verrouillées dessus : retirés avec lui (sessions : pas de clé étrangère).
      this.db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(profileId);
      this.db.prepare('DELETE FROM profile_logins WHERE profile_id = ?').run(profileId);
      return this.db.prepare('DELETE FROM profiles WHERE id = ? AND account_id = ?').run(profileId, accountId).changes > 0;
    });
  }

  // Invitations sur un profil du foyer (migration 27) : le jeton clair n'arrive jamais ici, seule son empreinte est reçue.

  /**
   * Crée un lien pour un profil. Le lien actif précédent du profil (non utilisé, non révoqué, non expiré) est révoqué dans
   * la même transaction. Refus `profile_has_login` si le profil a déjà un identifiant : rien n'est écrit.
   */
  createHouseholdInvite(write: HouseholdInviteWrite): HouseholdCreateResult {
    return this.transaction((): HouseholdCreateResult => {
      if (this.db.prepare('SELECT 1 AS n FROM profile_logins WHERE profile_id = ?').get(write.profileId) !== undefined) {
        return { ok: false, reason: 'profile_has_login' };
      }
      this.db
        .prepare('UPDATE household_invites SET revoked_at = ? WHERE profile_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .run(write.createdAt, write.profileId, write.createdAt);
      this.db
        .prepare(
          `INSERT INTO household_invites (id, token_hash, account_id, profile_id, created_by_profile, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(write.id, write.tokenHash, write.accountId, write.profileId, write.createdByProfile, write.createdAt, write.expiresAt);
      return { ok: true };
    });
  }

  /** Liens du compte créés depuis `since` (ms), les plus récents d'abord, avec le nom du profil invité. */
  listHouseholdInvites(accountId: string, since: number): HouseholdInviteRow[] {
    const rows = this.db
      .prepare(
        `SELECT h.id, h.profile_id, p.name AS profile_name, h.created_at, h.expires_at, h.used_at, h.revoked_at
         FROM household_invites h JOIN profiles p ON p.id = h.profile_id
         WHERE h.account_id = ? AND h.created_at >= ?
         ORDER BY h.created_at DESC, h.id`,
      )
      .all(accountId, since) as unknown as {
      id: string;
      profile_id: string;
      profile_name: string;
      created_at: number;
      expires_at: number;
      used_at: number | null;
      revoked_at: number | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      profileId: row.profile_id,
      profileName: row.profile_name,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }

  /** Révoque un lien du compte (pose revoked_at ; un login déjà créé reste valable). `used` si le lien a servi. */
  revokeHouseholdInvite(accountId: string, inviteId: string, now: number): 'ok' | 'not_found' | 'used' {
    return this.transaction((): 'ok' | 'not_found' | 'used' => {
      const row = this.db.prepare('SELECT used_at, revoked_at FROM household_invites WHERE id = ? AND account_id = ?').get(inviteId, accountId) as
        | { used_at: number | null; revoked_at: number | null }
        | undefined;
      if (row === undefined) return 'not_found';
      if (row.used_at !== null) return 'used';
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE household_invites SET revoked_at = ? WHERE id = ?').run(now, inviteId);
      }
      return 'ok';
    });
  }

  /** Lien vu par l'empreinte de son jeton, avec le profil invité et le créateur (même compte). Undefined si inconnu. */
  householdInviteByTokenHash(tokenHash: string): HouseholdInviteView | undefined {
    const row = this.db
      .prepare(
        `SELECT h.id, h.account_id, h.profile_id, h.created_by_profile, h.expires_at, h.used_at, h.revoked_at,
                p.name AS profile_name, p.avatar AS profile_avatar, p.avatar_color AS profile_color,
                c.name AS inviter_name, c.avatar AS inviter_avatar, c.avatar_color AS inviter_color
         FROM household_invites h
         JOIN profiles p ON p.id = h.profile_id
         LEFT JOIN profiles c ON c.id = h.created_by_profile AND c.account_id = h.account_id
         WHERE h.token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          id: string;
          account_id: string;
          profile_id: string;
          created_by_profile: string | null;
          expires_at: number;
          used_at: number | null;
          revoked_at: number | null;
          profile_name: string;
          profile_avatar: string | null;
          profile_color: string;
          inviter_name: string | null;
          inviter_avatar: string | null;
          inviter_color: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      accountId: row.account_id,
      profileId: row.profile_id,
      profileName: row.profile_name,
      profileAvatar: row.profile_avatar ?? null,
      profileAvatarColor: row.profile_color,
      createdByProfile: row.created_by_profile,
      inviterName: row.inviter_name,
      inviterAvatar: row.inviter_avatar ?? null,
      inviterAvatarColor: row.inviter_color,
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at === null ? null : Number(row.used_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    };
  }

  /** Jusqu'à `limit` affiches non vides de la bibliothèque du profil (les plus récemment ajoutées d'abord). */
  householdBackdrops(profileId: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT poster FROM library_items
         WHERE profile_id = ? AND removed = 0 AND poster IS NOT NULL AND poster <> ''
         ORDER BY added_at DESC, title_ref LIMIT ?`,
      )
      .all(profileId, limit) as { poster: string }[];
    return rows.map((row) => row.poster);
  }

  /** Profils du compte qui ont un identifiant d'invité (sans limite de date). */
  linkedProfileIdsOf(accountId: string): string[] {
    const rows = this.db.prepare('SELECT profile_id FROM profile_logins WHERE account_id = ? ORDER BY created_at, profile_id').all(accountId) as {
      profile_id: string;
    }[];
    return rows.map((row) => row.profile_id);
  }

  /** Identifiant de connexion de l'invité d'un profil, ou undefined si le profil n'en a pas. */
  loginOfProfile(profileId: string): string | undefined {
    const row = this.db.prepare('SELECT login FROM profile_logins WHERE profile_id = ?').get(profileId) as { login: string } | undefined;
    return row?.login;
  }

  /** Login de profil (identifiant de l'invité) : identifiants, compte et profil. Undefined si aucun. */
  profileLoginRecord(login: string): ProfileLoginRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT pl.login, pl.password_hash, pl.account_id, pl.profile_id, a.is_owner, a.suspended_at
         FROM profile_logins pl JOIN accounts a ON a.id = pl.account_id
         WHERE pl.login = ?`,
      )
      .get(login) as
      | { login: string; password_hash: string; account_id: string; profile_id: string; is_owner: number; suspended_at: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      login: row.login,
      passwordHash: row.password_hash,
      accountId: row.account_id,
      profileId: row.profile_id,
      isOwner: Number(row.is_owner) === 1,
      suspended: row.suspended_at != null,
    };
  }

  /**
   * Consommation d'un lien (transaction unique) : vérifie l'état, refuse un identifiant déjà pris (compte ou login de
   * profil), crée le login, marque le lien utilisé et ouvre la session verrouillée sur le profil. Un nom donné renomme le
   * profil. Rien n'est écrit en cas de refus.
   */
  redeemHouseholdInvite(input: HouseholdRedeemInput): HouseholdRedeemResult {
    return this.transaction((): HouseholdRedeemResult => {
      const row = this.db
        .prepare(
          `SELECT h.id, h.account_id, h.profile_id, h.expires_at, h.used_at, h.revoked_at, a.suspended_at
           FROM household_invites h JOIN accounts a ON a.id = h.account_id
           WHERE h.token_hash = ?`,
        )
        .get(input.tokenHash) as
        | {
            id: string;
            account_id: string;
            profile_id: string;
            expires_at: number;
            used_at: number | null;
            revoked_at: number | null;
            suspended_at: string | null;
          }
        | undefined;
      if (row === undefined) return { ok: false, reason: 'unknown' };
      if (row.used_at !== null) return { ok: false, reason: 'used' };
      if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (Number(row.expires_at) <= input.now) return { ok: false, reason: 'expired' };
      if (row.suspended_at != null) return { ok: false, reason: 'account_suspended' };
      const taken = this.db
        .prepare('SELECT 1 AS n FROM accounts WHERE username = ? UNION ALL SELECT 1 AS n FROM profile_logins WHERE login = ?')
        .get(input.login, input.login);
      if (taken !== undefined) return { ok: false, reason: 'login_taken' };
      // Défensif : un profil ne reçoit qu'un identifiant (la création d'un lien le refuse déjà).
      if (this.db.prepare('SELECT 1 AS n FROM profile_logins WHERE profile_id = ?').get(row.profile_id) !== undefined) {
        return { ok: false, reason: 'used' };
      }
      const consumed = this.db
        .prepare('UPDATE household_invites SET used_at = ?, used_login = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
        .run(input.now, input.login, row.id);
      if (consumed.changes === 0) return { ok: false, reason: 'used' };
      this.db
        .prepare('INSERT INTO profile_logins (login, password_hash, account_id, profile_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.login, input.passwordHash, row.account_id, row.profile_id, input.now);
      if (input.name !== null) {
        this.db.prepare('UPDATE profiles SET name = ? WHERE id = ? AND account_id = ?').run(input.name, row.profile_id, row.account_id);
        syncProfileIdentity(this.db, row.account_id, row.profile_id, input.name, false);
      }
      this.openSession(
        row.account_id,
        input.sessionHash,
        new Date(input.now).toISOString(),
        input.sessionExpiresAt,
        input.userAgent,
        row.profile_id,
      );
      return { ok: true, accountId: row.account_id, profileId: row.profile_id };
    });
  }

  // Bibliothèque

  /** Import en bloc (bibliothèque et progression) en une seule transaction. */
  importMany(library: readonly LibraryWrite[], progress: readonly ProgressWrite[]): void {
    this.transaction(() => {
      for (const write of library) this.upsertLibraryItem(write);
      for (const write of progress) this.upsertProgress(write);
    });
  }

  listLibrary(profileId: string, type: MediaType | undefined, sort: LibrarySort): LibraryItem[] {
    const order = sort === 'title' ? 'title COLLATE NOCASE, title_ref' : 'added_at DESC, title_ref';
    const typeClause = type === undefined ? '' : 'AND type = ?';
    const params: string[] = type === undefined ? [profileId] : [profileId, type];
    const rows = this.db
      .prepare(
        `SELECT type, title_ref, tmdb_id, imdb_id, title, poster, added_at, visibility FROM library_items
         WHERE profile_id = ? AND removed = 0 ${typeClause} ORDER BY ${order}`,
      )
      .all(...params) as unknown as LibraryRow[];
    return rows.map(toLibraryItem);
  }

  /** Ajoute ou met à jour un titre. Un titre retiré puis rajouté reçoit une nouvelle date d'ajout. */
  upsertLibraryItem(write: LibraryWrite): void {
    this.db
      .prepare(
        `INSERT INTO library_items (profile_id, type, title_ref, tmdb_id, imdb_id, title, poster, added_at, removed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(profile_id, type, title_ref) DO UPDATE SET
           tmdb_id = COALESCE(excluded.tmdb_id, library_items.tmdb_id),
           imdb_id = COALESCE(excluded.imdb_id, library_items.imdb_id),
           title = excluded.title,
           poster = excluded.poster,
           added_at = CASE WHEN library_items.removed = 1 THEN excluded.added_at ELSE library_items.added_at END,
           removed = 0`,
      )
      .run(
        write.profileId,
        write.type,
        titleRef(write.tmdbId, write.imdbId),
        write.tmdbId,
        write.imdbId,
        write.title,
        write.poster,
        write.addedAt,
      );
  }

  /** Retire un titre de la bibliothèque (suppression logique : `removed = 1`). */
  removeLibraryItem(profileId: string, type: MediaType, ref: string): void {
    this.db
      .prepare('UPDATE library_items SET removed = 1 WHERE profile_id = ? AND type = ? AND title_ref = ?')
      .run(profileId, type, ref);
  }

  // Progression

  /**
   * Enregistre une progression. Une écriture plus ancienne que la ligne existante est ignorée (un import Stremio
   * ne remplace jamais une lecture plus récente faite dans l'application).
   * Avec un pays (écriture de l'application), une première progression du compte sur ce titre compte un lancement dans
   * `title_starts`. Le test « première » précède l'écriture dans le même tour synchrone : rien ne s'intercale.
   */
  upsertProgress(write: ProgressWrite): void {
    const ref = titleRef(write.tmdbId, write.imdbId);
    const country = write.country === undefined ? undefined : countryCode(write.country);
    const starts = country !== undefined && !accountHasProgress(this.db, write.profileId, write.type, ref);
    this.db
      .prepare(
        `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished, manual)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(profile_id, type, title_ref, season, episode) DO UPDATE SET
           tmdb_id = COALESCE(excluded.tmdb_id, progress.tmdb_id),
           imdb_id = COALESCE(excluded.imdb_id, progress.imdb_id),
           position_sec = excluded.position_sec,
           duration_sec = excluded.duration_sec,
           updated_at = excluded.updated_at,
           finished = excluded.finished,
           manual = 0
         WHERE excluded.updated_at >= progress.updated_at`,
      )
      .run(
        write.profileId,
        write.type,
        ref,
        write.tmdbId,
        write.imdbId,
        write.season,
        write.episode,
        write.positionSec,
        write.durationSec,
        write.updatedAt,
        write.finished ? 1 : 0,
      );
    if (country !== undefined && starts) {
      const day = utcDay(write.updatedAt);
      if (day !== this.startsPurgedOn) {
        purgeTitleStarts(this.db, shiftDay(day, -RETENTION_DAYS));
        this.startsPurgedOn = day;
      }
      recordTitleStart(this.db, day, country, titleStartKey(write.type, ref));
    }
  }

  /**
   * Titres les plus lancés dans un pays depuis un jour (AAAA-MM-JJ, inclus), `n` cumulé sur la période. Seuls les titres
   * à MIN_STARTS lancements ou plus sont renvoyés (anonymat), du plus lancé au moins lancé.
   */
  topStarts(country: string, sinceDay: string, limit: number): TitleStart[] {
    return topTitleStarts(this.db, countryCode(country), sinceDay, limit);
  }

  progressForTitle(profileId: string, type: MediaType, ref: string): ProgressItem[] {
    const rows = this.db
      .prepare('SELECT * FROM progress WHERE profile_id = ? AND type = ? AND title_ref = ? ORDER BY season, episode')
      .all(profileId, type, ref) as unknown as ProgressRow[];
    return rows.map(toProgressItem);
  }

  progressEpisode(profileId: string, type: MediaType, ref: string, season: number, episode: number): ProgressItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM progress WHERE profile_id = ? AND type = ? AND title_ref = ? AND season = ? AND episode = ?')
      .get(profileId, type, ref, season, episode) as ProgressRow | undefined;
    return row === undefined ? undefined : toProgressItem(row);
  }

  /** Dernière progression de chaque titre (une ligne par titre), la plus récente d'abord. */
  latestProgressPerTitle(profileId: string): ProgressItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT p.*, ROW_NUMBER() OVER (
             PARTITION BY p.type, p.title_ref
             ORDER BY p.updated_at DESC, p.season DESC, p.episode DESC
           ) AS rn
           FROM progress p WHERE p.profile_id = ?
         ) WHERE rn = 1 ORDER BY updated_at DESC`,
      )
      .all(profileId) as unknown as ProgressRow[];
    return rows.map(toProgressItem);
  }

  /**
   * Historique « vu » du profil : une ligne par titre ayant au moins un film ou un épisode terminé (hors saison 0).
   * Les plus récemment terminés d'abord. Une lecture en cours (non terminée) n'y figure pas.
   */
  watchedTitles(profileId: string): WatchedTitleItem[] {
    const rows = this.db
      .prepare(
        `SELECT type, MAX(tmdb_id) AS tmdb_id, MAX(imdb_id) AS imdb_id,
           SUM(CASE WHEN type = 'movie' OR season > 0 THEN 1 ELSE 0 END) AS watched,
           MAX(updated_at) AS last_watched_at
         FROM progress WHERE profile_id = ? AND finished = 1
         GROUP BY type, title_ref
         HAVING SUM(CASE WHEN type = 'movie' OR season > 0 THEN 1 ELSE 0 END) > 0
         ORDER BY last_watched_at DESC`,
      )
      .all(profileId) as unknown as WatchedTitleRow[];
    return rows.map((row) => ({
      type: row.type,
      tmdbId: row.tmdb_id,
      imdbId: row.imdb_id,
      watched: Number(row.watched),
      lastWatchedAt: row.last_watched_at,
    }));
  }

  /**
   * Marque des épisodes (ou un film) vus ou non vus, en une transaction. Vu : la ligne est créée si absente, sinon
   * passe à terminée, et sa position se règle sur la durée connue (0 si inconnue). Non vu : seules les lignes terminées
   * sont retirées, une lecture en cours n'est pas touchée. Idempotent.
   * Un marquage est manuel (`manual`) : il n'alimente pas l'historique des amis. Une ligne déjà terminée par une vraie
   * lecture garde son statut réel et sa date (le re-marquage n'en fait pas un visionnage récent) ; une lecture en cours
   * marquée vue devient un marquage manuel.
   */
  setWatched(write: WatchedWrite): void {
    const ref = titleRef(write.tmdbId, write.imdbId);
    const mark = this.db.prepare(
      `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished, manual)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, 1)
       ON CONFLICT(profile_id, type, title_ref, season, episode) DO UPDATE SET
         tmdb_id = COALESCE(excluded.tmdb_id, progress.tmdb_id),
         imdb_id = COALESCE(excluded.imdb_id, progress.imdb_id),
         position_sec = CASE WHEN progress.duration_sec > 0 THEN progress.duration_sec ELSE 0 END,
         updated_at = CASE WHEN progress.finished = 1 THEN progress.updated_at ELSE excluded.updated_at END,
         manual = CASE WHEN progress.finished = 1 THEN progress.manual ELSE 1 END,
         finished = 1`,
    );
    const unmark = this.db.prepare(
      'DELETE FROM progress WHERE profile_id = ? AND type = ? AND title_ref = ? AND season = ? AND episode = ? AND finished = 1',
    );
    this.transaction(() => {
      for (const { season, episode } of write.episodes) {
        if (write.watched) {
          mark.run(write.profileId, write.type, ref, write.tmdbId, write.imdbId, season, episode, write.updatedAt);
        } else {
          unmark.run(write.profileId, write.type, ref, season, episode);
        }
      }
    });
  }

  // Suivis

  listFollows(profileId: string): FollowItem[] {
    const rows = this.db
      .prepare('SELECT type, tmdb_id, imdb_id, title, poster, followed_at, notify FROM follows WHERE profile_id = ? ORDER BY followed_at DESC, title_ref')
      .all(profileId) as unknown as FollowRow[];
    return rows.map(toFollowItem);
  }

  /** Suit un titre ou une personne. Un suivi existant garde sa date ; titre, affiche et notification sont mis à jour. */
  upsertFollow(write: FollowWrite): void {
    this.db
      .prepare(
        `INSERT INTO follows (profile_id, type, title_ref, tmdb_id, imdb_id, title, poster, followed_at, notify)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, type, title_ref) DO UPDATE SET
           tmdb_id = COALESCE(excluded.tmdb_id, follows.tmdb_id),
           imdb_id = COALESCE(excluded.imdb_id, follows.imdb_id),
           title = excluded.title,
           poster = excluded.poster,
           notify = excluded.notify`,
      )
      .run(
        write.profileId,
        write.type,
        titleRef(write.tmdbId, write.imdbId),
        write.tmdbId,
        write.imdbId,
        write.title,
        write.poster,
        write.followedAt,
        write.notify ? 1 : 0,
      );
  }

  removeFollow(profileId: string, type: FollowType, ref: string): void {
    this.db.prepare('DELETE FROM follows WHERE profile_id = ? AND type = ? AND title_ref = ?').run(profileId, type, ref);
  }

  // Notes

  listRatings(profileId: string, type: MediaType | undefined): RatingItem[] {
    const typeClause = type === undefined ? '' : 'AND type = ?';
    const params: string[] = type === undefined ? [profileId] : [profileId, type];
    const rows = this.db
      .prepare(`SELECT type, tmdb_id, imdb_id, title, rating, rated_at FROM ratings WHERE profile_id = ? ${typeClause} ORDER BY rated_at DESC, title_ref`)
      .all(...params) as unknown as RatingRow[];
    return rows.map(toRatingItem);
  }

  /** Note un titre (remplace la note précédente). Le titre déjà connu est conservé si l'écriture n'en donne pas. */
  upsertRating(write: RatingWrite): void {
    this.db
      .prepare(
        `INSERT INTO ratings (profile_id, type, title_ref, tmdb_id, imdb_id, title, rating, rated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, type, title_ref) DO UPDATE SET
           tmdb_id = COALESCE(excluded.tmdb_id, ratings.tmdb_id),
           imdb_id = COALESCE(excluded.imdb_id, ratings.imdb_id),
           title = COALESCE(excluded.title, ratings.title),
           rating = excluded.rating,
           rated_at = excluded.rated_at`,
      )
      .run(
        write.profileId,
        write.type,
        titleRef(write.tmdbId, write.imdbId),
        write.tmdbId,
        write.imdbId,
        write.title,
        write.rating,
        write.ratedAt,
      );
  }

  removeRating(profileId: string, type: MediaType, ref: string): void {
    this.db.prepare('DELETE FROM ratings WHERE profile_id = ? AND type = ? AND title_ref = ?').run(profileId, type, ref);
  }

  // Continuer à regarder : titres masqués

  /** Date de masquage par titre, clé `type|titleRef`. Un titre masqué réapparaît dès qu'il a une progression plus récente. */
  hiddenContinue(profileId: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT type, title_ref, hidden_at FROM continue_hidden WHERE profile_id = ?')
      .all(profileId) as { type: string; title_ref: string; hidden_at: string }[];
    return new Map(rows.map((row) => [`${row.type}|${row.title_ref}`, row.hidden_at]));
  }

  hideContinue(profileId: string, type: MediaType, ref: string, hiddenAt: string): void {
    this.db
      .prepare(
        `INSERT INTO continue_hidden (profile_id, type, title_ref, hidden_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, type, title_ref) DO UPDATE SET hidden_at = excluded.hidden_at`,
      )
      .run(profileId, type, ref, hiddenAt);
  }

  // Réglages

  listSettings(profileId: string): SettingsMap {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE profile_id = ? ORDER BY key').all(profileId) as unknown as SettingRow[];
    const settings: SettingsMap = {};
    for (const row of rows) settings[row.key] = JSON.parse(row.value) as unknown;
    return settings;
  }

  /** Fusionne des réglages : `null` supprime la clé, toute autre valeur remplace l'existante. */
  writeSettings(profileId: string, entries: readonly [string, unknown][]): void {
    this.transaction(() => {
      for (const [key, value] of entries) {
        if (value === null) {
          this.db.prepare('DELETE FROM settings WHERE profile_id = ? AND key = ?').run(profileId, key);
        } else {
          this.db
            .prepare(
              `INSERT INTO settings (profile_id, key, value) VALUES (?, ?, ?)
               ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`,
            )
            .run(profileId, key, JSON.stringify(value));
        }
      }
    });
  }

  /** Configuration lastAddon chiffrée du compte (chaîne opaque), ou null si le compte n'en a pas. */
  getAccountConfig(accountId: string): string | null {
    const row = this.db.prepare('SELECT lastaddon_config AS v FROM accounts WHERE id = ?').get(accountId) as { v: string | null } | undefined;
    if (row === undefined || row.v === null) return null;
    const value = JSON.parse(row.v) as unknown;
    return typeof value === 'string' ? value : null;
  }

  /** Enregistre (ou, avec null, supprime) la configuration lastAddon chiffrée du compte. */
  setAccountConfig(accountId: string, value: string | null): void {
    this.db.prepare('UPDATE accounts SET lastaddon_config = ? WHERE id = ?').run(value === null ? null : JSON.stringify(value), accountId);
  }

  /** Sources TV chiffrées du compte (chaîne opaque base64url), ou null si le compte n'en a pas. */
  getTvSources(accountId: string): string | null {
    const row = this.db.prepare('SELECT tv_sources AS v FROM accounts WHERE id = ?').get(accountId) as { v: string | null } | undefined;
    return row?.v ?? null;
  }

  /** Enregistre (ou, avec null, supprime) les sources TV chiffrées du compte. */
  setTvSources(accountId: string, value: string | null): void {
    this.db.prepare('UPDATE accounts SET tv_sources = ? WHERE id = ?').run(value, accountId);
  }
}
