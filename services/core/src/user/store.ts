import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type MediaType = 'movie' | 'series';
export const KID_MAX_AGES = [10, 12, 16, 18] as const;
export type KidMaxAge = (typeof KID_MAX_AGES)[number];
export type LibrarySort = 'added' | 'title';

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

/** Profil tel que vu par le client : jamais le hash du PIN. */
export interface Profile {
  id: string;
  name: string;
  avatarColor: string;
  isKid: boolean;
  kidMaxAge: KidMaxAge | null;
  hasPin: boolean;
  allowedCatalogs: string[];
  createdAt: string;
}

/** Profil avec son hash de PIN, usage serveur uniquement. */
export interface ProfileRecord extends Profile {
  accountId: string;
  pinHash: string | null;
}

export interface ProfileFields {
  name: string;
  avatarColor: string;
  isKid: boolean;
  kidMaxAge: KidMaxAge | null;
  pinHash: string | null;
  allowedCatalogs: string[];
}

export interface LibraryItem {
  type: MediaType;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
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

export type SettingsMap = Record<string, unknown>;

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  is_owner: number;
  created_at: string;
}

interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  avatar_color: string;
  is_kid: number;
  kid_max_age: number | null;
  pin_hash: string | null;
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

export interface AccountRecord extends Account {
  passwordHash: string;
}

export type CreateAccountResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'signup_disabled' | 'username_taken' };

function toAccount(row: Omit<AccountRow, "password_hash">): Account {
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
    isKid: row.is_kid === 1,
    kidMaxAge: row.kid_max_age === null ? null : (row.kid_max_age as KidMaxAge),
    hasPin: row.pin_hash !== null,
    pinHash: row.pin_hash,
    allowedCatalogs: parseCatalogs(row.allowed_catalogs),
    createdAt: row.created_at,
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
  constructor(private readonly db: DatabaseSync) {}

  /** Ferme la base (fichier libéré). Ne plus utiliser le store ensuite. */
  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Comptes

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
    return Number(row?.n ?? 0);
  }

  findAccountRecord(username: string): AccountRecord | undefined {
    const row = this.db
      .prepare('SELECT id, username, password_hash, is_owner, created_at FROM accounts WHERE username = ?')
      .get(username) as AccountRow | undefined;
    if (row === undefined) return undefined;
    return { ...toAccount(row), passwordHash: row.password_hash };
  }

  /**
   * Crée un compte. Le contrôle des droits (inscription ouverte ou premier compte) et l'unicité du nom sont faits
   * dans la même transaction que l'insertion : deux inscriptions simultanées ne peuvent pas créer deux « premiers » comptes.
   */
  createAccount(input: { username: string; passwordHash: string; allowSignup: boolean; now: string }): CreateAccountResult {
    return this.transaction((): CreateAccountResult => {
      const isFirst = this.countAccounts() === 0;
      if (!isFirst && !input.allowSignup) return { ok: false, reason: 'signup_disabled' };
      if (this.findAccountRecord(input.username) !== undefined) return { ok: false, reason: 'username_taken' };
      const account: Account = {
        id: randomUUID(),
        username: input.username,
        isOwner: isFirst,
        createdAt: input.now,
      };
      this.db
        .prepare('INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(account.id, account.username, input.passwordHash, isFirst ? 1 : 0, account.createdAt);
      return { ok: true, account };
    });
  }

  // Sessions

  createSession(accountId: string, tokenHash: string, createdAt: string, expiresAt: string): void {
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
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as Omit<AccountRow, "password_hash"> | undefined;
    return row === undefined ? undefined : toAccount(row);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(accountId: string, now: string): void {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND expires_at <= ?').run(accountId, now);
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
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, pin_hash, allowed_catalogs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        accountId,
        fields.name,
        fields.avatarColor,
        fields.isKid ? 1 : 0,
        fields.kidMaxAge,
        fields.pinHash,
        JSON.stringify(fields.allowedCatalogs),
        createdAt,
      );
  }

  updateProfile(accountId: string, profileId: string, fields: ProfileFields): void {
    this.db
      .prepare(
        `UPDATE profiles SET name = ?, avatar_color = ?, is_kid = ?, kid_max_age = ?, pin_hash = ?, allowed_catalogs = ?
         WHERE id = ? AND account_id = ?`,
      )
      .run(
        fields.name,
        fields.avatarColor,
        fields.isKid ? 1 : 0,
        fields.kidMaxAge,
        fields.pinHash,
        JSON.stringify(fields.allowedCatalogs),
        profileId,
        accountId,
      );
  }

  deleteProfile(accountId: string, profileId: string): boolean {
    return this.db.prepare('DELETE FROM profiles WHERE id = ? AND account_id = ?').run(profileId, accountId).changes > 0;
  }

  // Bibliothèque

  listLibrary(profileId: string, type: MediaType | undefined, sort: LibrarySort): LibraryItem[] {
    const order = sort === 'title' ? 'title COLLATE NOCASE, title_ref' : 'added_at DESC, title_ref';
    const typeClause = type === undefined ? '' : 'AND type = ?';
    const params: string[] = type === undefined ? [profileId] : [profileId, type];
    const rows = this.db
      .prepare(
        `SELECT type, title_ref, tmdb_id, imdb_id, title, poster, added_at FROM library_items
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
}
