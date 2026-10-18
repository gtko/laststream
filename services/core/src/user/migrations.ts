import type { SqlDb } from './sql.js';

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
  {
    version: 3,
    name: 'suivis (titres et personnes) et notes sur 5 par demi-étoiles',
    sql: `
      CREATE TABLE follows (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series', 'person')),
        title_ref TEXT NOT NULL,
        tmdb_id INTEGER,
        imdb_id TEXT,
        title TEXT NOT NULL,
        poster TEXT,
        followed_at TEXT NOT NULL,
        notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
        PRIMARY KEY (profile_id, type, title_ref)
      );

      CREATE TABLE ratings (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        title_ref TEXT NOT NULL,
        tmdb_id INTEGER,
        imdb_id TEXT,
        title TEXT,
        rating REAL NOT NULL CHECK (rating >= 0 AND rating <= 5 AND rating * 2 = CAST(rating * 2 AS INTEGER)),
        rated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, type, title_ref)
      );
    `,
  },
  {
    version: 4,
    name: 'titres masqués de « continuer à regarder » (réapparaissent à la prochaine progression)',
    sql: `
      CREATE TABLE continue_hidden (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        title_ref TEXT NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, type, title_ref)
      );
    `,
  },
  {
    version: 5,
    name: 'segments de saut proposés par la communauté (votes pour et contre, source)',
    sql: `
      CREATE TABLE skip_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imdb_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('intro', 'recap', 'credits', 'postcredits')),
        "start" REAL NOT NULL CHECK ("start" >= 0),
        "end" REAL NOT NULL CHECK ("end" > "start"),
        duration REAL NOT NULL CHECK (duration > 0),
        votes_up INTEGER NOT NULL DEFAULT 0 CHECK (votes_up >= 0),
        votes_down INTEGER NOT NULL DEFAULT 0 CHECK (votes_down >= 0),
        source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'inferred')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX skip_segments_episode ON skip_segments (imdb_id, season, episode, kind);
    `,
  },
  {
    version: 6,
    name: 'segments de saut détectés automatiquement (chapitres, empreinte audio) et empreintes par saison',
    sql: `
      CREATE TABLE skip_segments_v6 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imdb_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('intro', 'recap', 'credits', 'postcredits', 'preview')),
        "start" REAL NOT NULL CHECK ("start" >= 0),
        "end" REAL NOT NULL CHECK ("end" > "start"),
        duration REAL NOT NULL CHECK (duration > 0),
        votes_up INTEGER NOT NULL DEFAULT 0 CHECK (votes_up >= 0),
        votes_down INTEGER NOT NULL DEFAULT 0 CHECK (votes_down >= 0),
        source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'inferred', 'auto')),
        created_at TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        method TEXT
      );
      INSERT INTO skip_segments_v6 (id, imdb_id, season, episode, kind, "start", "end", duration, votes_up, votes_down, source, created_at)
        SELECT id, imdb_id, season, episode, kind, "start", "end", duration, votes_up, votes_down, source, created_at FROM skip_segments;
      DROP TABLE skip_segments;
      ALTER TABLE skip_segments_v6 RENAME TO skip_segments;
      CREATE INDEX skip_segments_episode ON skip_segments (imdb_id, season, episode, kind);

      CREATE TABLE skip_fingerprints (
        imdb_id TEXT NOT NULL,
        season INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('intro', 'credits')),
        method TEXT NOT NULL,
        fp BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (imdb_id, season, kind, method)
      );
    `,
  },
  {
    version: 7,
    name: 'fonctions sociales : parrainage, amis, présence, visibilité de la bibliothèque, titres masqués, index des salons',
    sql: `
      ALTER TABLE accounts ADD COLUMN invite_quota INTEGER NOT NULL DEFAULT 4 CHECK (invite_quota >= 0);

      -- Liens de parrainage. inviter_id NULL : invitation « système » créée par l'administration (aucune amitié à l'inscription).
      -- Un lien utilisé garde used_at même si le compte du filleul est supprimé (used_by passe alors à NULL).
      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        inviter_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        used_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        used_at TEXT
      );
      CREATE INDEX invites_inviter ON invites(inviter_id);

      -- Amitiés : une ligne par paire, ids ordonnés (low_id < high_id). requested_by = celui qui a demandé.
      CREATE TABLE friendships (
        low_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        high_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        PRIMARY KEY (low_id, high_id),
        CHECK (low_id < high_id)
      );
      CREATE INDEX friendships_high ON friendships(high_id);

      -- Présence : dernier battement de cœur, titre en cours (JSON) et mode invisible.
      CREATE TABLE presence (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        profile_id TEXT,
        seen_at TEXT NOT NULL,
        watching TEXT,
        invisible INTEGER NOT NULL DEFAULT 0 CHECK (invisible IN (0, 1))
      );

      ALTER TABLE library_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'friends'));
      CREATE INDEX library_items_visibility ON library_items(profile_id, visibility) WHERE visibility = 'friends';

      -- Titres masqués de l'accueil : clé « movie:550 » / « tv:1399 » (même clé que le client).
      CREATE TABLE hidden_titles (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        poster TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, key)
      );
      CREATE INDEX hidden_titles_order ON hidden_titles(profile_id, added_at DESC, key DESC);
      -- Profils dont les anciens morceaux de réglages (homeHidden0..11) ont déjà été importés.
      CREATE TABLE hidden_import (
        profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        imported_at TEXT NOT NULL
      );

      -- Index des salons de visionnage (le temps réel vit dans le Durable Object PartyRoom ; ici : annuaire).
      CREATE TABLE party_rooms (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        title TEXT NOT NULL,
        poster TEXT,
        language TEXT,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'series')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX party_rooms_public ON party_rooms(visibility, created_at DESC, id);
      CREATE INDEX party_rooms_host ON party_rooms(host_id);
    `,
  },
];

/**
 * Applique les migrations en attente, chacune dans sa propre transaction. Refuse une base plus récente que le code
 * (version inconnue) plutôt que de risquer une corruption.
 */
export function migrate(db: SqlDb, migrations: readonly Migration[] = MIGRATIONS): void {
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
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
}
