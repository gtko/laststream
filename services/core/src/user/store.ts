import { randomUUID } from 'node:crypto';
import { readAppSettings } from './app-settings.js';
import { redeemInvite } from './social-store.js';
import type { SqlDb } from './sql.js';

export type MediaType = 'movie' | 'series';
export const KID_MAX_AGES = [10, 12, 16, 18] as const;
export type KidMaxAge = (typeof KID_MAX_AGES)[number];
export type LibrarySort = 'added' | 'title';

/** Sessions simultanées par compte : au-delà, la plus ancienne est supprimée. */
export const MAX_SESSIONS_PER_ACCOUNT = 20;

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
}

/** Un suivi peut aussi viser une personne (acteur, réalisateur) : pas de saison ni d'épisode. */
export type FollowType = MediaType | 'person';

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

interface SettingRow {
  key: string;
  value: string;
}

export type CreateAccountResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'signup_disabled' | 'username_taken' | 'invite_invalid' | 'invites_closed' };

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
    now: string;
  }): CreateAccountResult {
    return this.transaction((): CreateAccountResult => {
      const isFirst = this.countAccounts() === 0;
      const invite = !isFirst && input.inviteCode !== undefined;
      if (!isFirst && !invite && !input.allowSignup) return { ok: false, reason: 'signup_disabled' };
      const settings = readAppSettings(this.db);
      // Inscriptions par lien fermées par l'administration (le tout premier compte n'est jamais concerné).
      if (invite && !settings.invitesOpen) return { ok: false, reason: 'invites_closed' };
      if (this.findAccountRecord(input.username) !== undefined) return { ok: false, reason: 'username_taken' };
      if (invite && input.inviteCode !== undefined) {
        const row = this.db.prepare('SELECT used_at FROM invites WHERE code = ?').get(input.inviteCode) as { used_at: string | null } | undefined;
        if (row === undefined || row.used_at !== null) return { ok: false, reason: 'invite_invalid' };
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
      if (invite && input.inviteCode !== undefined && !redeemInvite(this.db, input.inviteCode, account.id, input.now).ok) {
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
   * sessions : la plus ancienne (ordre d'insertion) est supprimée au-delà.
   */
  startSession(accountId: string, tokenHash: string, now: string, expiresAt: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?').run(accountId, now);
      this.createSession(accountId, tokenHash, now, expiresAt);
      this.db
        .prepare(
          `DELETE FROM sessions WHERE account_id = ? AND rowid NOT IN (
             SELECT rowid FROM sessions WHERE account_id = ? ORDER BY rowid DESC LIMIT ?)`,
        )
        .run(accountId, accountId, MAX_SESSIONS_PER_ACCOUNT);
    });
  }

  private createSession(accountId: string, tokenHash: string, createdAt: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, accountId, createdAt, expiresAt);
  }

  /** Compte lié à une session valide (non expirée), ou undefined. */
  accountForSession(tokenHash: string, now: string): Account | undefined {
    const row = this.db
      .prepare(
        `SELECT a.id, a.username, a.is_owner, a.created_at
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND a.suspended_at IS NULL`,
      )
      .get(tokenHash, now) as Omit<AccountRow, 'password_hash'> | undefined;
    return row === undefined ? undefined : toAccount(row);
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

  /** Rotation : remplace une session valide par une nouvelle. False si l'ancienne n'était plus valide. */
  rotateSession(oldHash: string, newHash: string, accountId: string, now: string, expiresAt: string): boolean {
    return this.transaction(() => {
      const removed = this.db
        .prepare('DELETE FROM sessions WHERE token_hash = ? AND account_id = ? AND expires_at > ?')
        .run(oldHash, accountId, now);
      if (removed.changes === 0) return false;
      this.createSession(accountId, newHash, now, expiresAt);
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
  }

  /**
   * Champs modifiables ; le PIN (haché, `null` pour le retirer) n'est touché que s'il est fourni, dans la même
   * transaction (voir setPin).
   */
  updateProfile(accountId: string, profileId: string, fields: ProfileEditableFields, pinHash?: string | null): void {
    this.transaction(() => {
      this.updateProfileFields(accountId, profileId, fields);
      if (pinHash !== undefined) this.setPin(accountId, profileId, pinHash);
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
    return this.db.prepare('DELETE FROM profiles WHERE id = ? AND account_id = ?').run(profileId, accountId).changes > 0;
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
   */
  upsertProgress(write: ProgressWrite): void {
    this.db
      .prepare(
        `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, type, title_ref, season, episode) DO UPDATE SET
           tmdb_id = COALESCE(excluded.tmdb_id, progress.tmdb_id),
           imdb_id = COALESCE(excluded.imdb_id, progress.imdb_id),
           position_sec = excluded.position_sec,
           duration_sec = excluded.duration_sec,
           updated_at = excluded.updated_at,
           finished = excluded.finished
         WHERE excluded.updated_at >= progress.updated_at`,
      )
      .run(
        write.profileId,
        write.type,
        titleRef(write.tmdbId, write.imdbId),
        write.tmdbId,
        write.imdbId,
        write.season,
        write.episode,
        write.positionSec,
        write.durationSec,
        write.updatedAt,
        write.finished ? 1 : 0,
      );
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
   * Marque des épisodes (ou un film) vus ou non vus, en une transaction. Vu : la ligne est créée si absente, sinon
   * passe à terminée, et sa position se règle sur la durée connue (0 si inconnue). Non vu : seules les lignes terminées
   * sont retirées, une lecture en cours n'est pas touchée. Idempotent.
   */
  setWatched(write: WatchedWrite): void {
    const ref = titleRef(write.tmdbId, write.imdbId);
    const mark = this.db.prepare(
      `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1)
       ON CONFLICT(profile_id, type, title_ref, season, episode) DO UPDATE SET
         tmdb_id = COALESCE(excluded.tmdb_id, progress.tmdb_id),
         imdb_id = COALESCE(excluded.imdb_id, progress.imdb_id),
         position_sec = CASE WHEN progress.duration_sec > 0 THEN progress.duration_sec ELSE 0 END,
         updated_at = excluded.updated_at,
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
