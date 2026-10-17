import type { DatabaseSync } from 'node:sqlite';

/** Migration versionnée. Les versions appliquées sont tracées dans `schema_migrations`. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Schéma des données utilisateur. `title_ref` identifie un titre : `tmdb:<id>` quand l'identifiant TMDB est connu,
 * sinon `imdb:<tt…>` (import Stremio sans jeton TMDB). Les films ont season = episode = 0.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'comptes, sessions, profils, bibliothèque, progression, réglages',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_account ON sessions(account_id);

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        is_kid INTEGER NOT NULL DEFAULT 0 CHECK (is_kid IN (0, 1)),
        kid_max_age INTEGER CHECK (kid_max_age IN (10, 12, 16, 18)),
        pin_hash TEXT,
        allowed_catalogs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX profiles_account ON profiles(account_id);

      CREATE TABLE library_items (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        title_ref TEXT NOT NULL,
        tmdb_id INTEGER,
        imdb_id TEXT,
        title TEXT NOT NULL,
        poster TEXT,
        added_at TEXT NOT NULL,
        removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
        PRIMARY KEY (profile_id, type, title_ref)
      );

      CREATE TABLE progress (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        title_ref TEXT NOT NULL,
        tmdb_id INTEGER,
        imdb_id TEXT,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        position_sec REAL NOT NULL,
        duration_sec REAL NOT NULL,
        updated_at TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
        PRIMARY KEY (profile_id, type, title_ref, season, episode)
      );
      CREATE INDEX progress_updated ON progress(profile_id, updated_at);

      CREATE TABLE settings (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (profile_id, key)
      );
    `,
  },
  {
    version: 2,
    name: 'verrouillage PIN : tentatives, blocage temporaire, version du PIN',
    sql: `
      ALTER TABLE profiles ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE profiles ADD COLUMN pin_locked_until TEXT;
      ALTER TABLE profiles ADD COLUMN pin_version INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

/**
 * Applique les migrations en attente, chacune dans sa propre transaction. Refuse une base plus récente que le code
 * (version inconnue) plutôt que de risquer une corruption.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  const known = new Set(migrations.map((migration) => migration.version));
  if ([...applied].some((version) => !known.has(version))) {
    throw new Error('Base de données utilisateur : version de schéma inconnue (base plus récente que lastAddon)');
  }
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
