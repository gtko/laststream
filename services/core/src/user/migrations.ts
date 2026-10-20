import { backfillProfileIdentities } from './social-handles.js';
import type { SqlDb } from './sql.js';

/** Migration versionnée. Les versions appliquées sont tracées dans `schema_migrations`. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /** Étape de données facultative, exécutée après `sql` dans la même transaction (ex. tirages aléatoires). */
  readonly run?: (db: SqlDb) => void;
}

/** Début de requête commun : profil principal de chaque compte (premier profil non enfant créé, pid déjà attribué). */
const PRINCIPAL_CTE = `
  WITH principal AS (
    SELECT a.id AS account_id,
      (SELECT p.pid FROM profiles p WHERE p.account_id = a.id AND p.is_kid = 0 ORDER BY p.created_at, p.id LIMIT 1) AS pid
    FROM accounts a
  )`;

/**
 * Reprise des données sociales vers les profils (après l'attribution des identités) : les amitiés compte↔compte
 * deviennent des amitiés entre profils principaux, la présence existante est rattachée au profil principal. Les
 * anciennes tables restent en place pour les routes de compatibilité. Horodatages : ms epoch (ISO 8601 UTC → julianday).
 */
const PROFILE_SOCIAL_BACKFILL_SQL = `
  ${PRINCIPAL_CTE}
  INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at)
  SELECT CASE WHEN lo.pid < hi.pid THEN lo.pid ELSE hi.pid END,
         CASE WHEN lo.pid < hi.pid THEN hi.pid ELSE lo.pid END,
         CASE WHEN f.requested_by = f.low_id THEN lo.pid ELSE hi.pid END,
         f.status,
         CAST(ROUND((julianday(f.created_at) - 2440587.5) * 86400000) AS INTEGER)
  FROM friendships f
  JOIN principal lo ON lo.account_id = f.low_id
  JOIN principal hi ON hi.account_id = f.high_id
  WHERE lo.pid IS NOT NULL AND hi.pid IS NOT NULL;

  ${PRINCIPAL_CTE}
  INSERT INTO profile_presence (profile_pid, status, watching, updated_at)
  SELECT pr.pid,
         CASE WHEN s.invisible = 1 THEN 'invisible' ELSE 'online' END,
         NULL,
         CAST(ROUND((julianday(s.seen_at) - 2440587.5) * 86400000) AS INTEGER)
  FROM presence s
  JOIN principal pr ON pr.account_id = s.account_id
  WHERE pr.pid IS NOT NULL;
`;

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
  {
    version: 8,
    name: 'administration : suspension des comptes, réglages globaux, journal d audit, réinitialisation de mot de passe, signalements',
    sql: `
      -- Compte suspendu : ne peut plus se connecter, ses sessions sont refusées. NULL = actif.
      ALTER TABLE accounts ADD COLUMN suspended_at TEXT;

      -- Réglages globaux (clé → JSON) : quota d'invitations par défaut, inscriptions par invitation, mode maintenance.
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Journal d'audit des actions d'administration (qui, quoi, quand). Jamais de secret dans detail.
      CREATE TABLE admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );

      -- Liens de réinitialisation de mot de passe : seule l'empreinte du jeton est stockée, usage unique.
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX password_resets_account ON password_resets(account_id);

      -- File des messages signalés dans les salons (alimentée par le salon au moment du signalement).
      CREATE TABLE party_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        by_name TEXT NOT NULL,
        against_id TEXT,
        against_name TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT,
        at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'deleted', 'suspended', 'ignored')),
        resolved_at TEXT,
        UNIQUE (room_id, message_id, by_name)
      );
      CREATE INDEX party_reports_status ON party_reports(status, id);
    `,
  },
  {
    version: 9,
    name: 'avatar illustré du profil (dicebear:<style>:<graine>), la couleur reste le repli',
    sql: `
      ALTER TABLE profiles ADD COLUMN avatar TEXT;
    `,
  },
  {
    version: 10,
    name: 'configuration lastAddon au niveau du compte (accounts.lastaddon_config), copiée depuis le profil principal',
    sql: `
      -- Configuration lastAddon chiffrée (JSON d'une chaîne) : lisible par tous les profils du compte, écrite par le principal seul.
      ALTER TABLE accounts ADD COLUMN lastaddon_config TEXT;

      -- Reprise de la valeur gardée jusqu'ici dans les réglages du profil principal (compte propriétaire : profil
      -- administrateur ; sinon plus ancien profil, repli compris).
      UPDATE accounts SET lastaddon_config = (
        SELECT s.value FROM settings s
        WHERE s.key = 'lastaddonConfig' AND s.profile_id = COALESCE(
          CASE WHEN accounts.is_owner = 1
            THEN (SELECT p.id FROM profiles p WHERE p.account_id = accounts.id AND p.id = (SELECT json_extract(value, '$') FROM app_settings WHERE key = 'admin_profile_id'))
          END,
          (SELECT p2.id FROM profiles p2 WHERE p2.account_id = accounts.id ORDER BY p2.created_at, p2.id LIMIT 1)
        )
      );
    `,
  },
  {
    version: 11,
    name: 'sources TV du compte (accounts.tv_sources), chiffrées côté serveur',
    sql: `
      -- Playlists M3U / guides XMLTV de l'utilisateur : JSON chiffré (AES-256-GCM, base64url), jamais en clair en base.
      ALTER TABLE accounts ADD COLUMN tv_sources TEXT;
    `,
  },
  {
    version: 12,
    name: 'index des fiches partagées (R2 meta/<type>/<tmdbId>.json), recherche par identifiant IMDb ou TVDB',
    sql: `
      -- Une ligne par fiche stockée dans R2 : contenu partagé entre tous les comptes, aucune donnée personnelle.
      -- etag : empreinte du contenu de la fiche ; une ligne n'est réécrite que si cette empreinte change.
      CREATE TABLE meta_index (
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        tmdb_id INTEGER NOT NULL,
        imdb_id TEXT,
        tvdb_id INTEGER,
        title TEXT NOT NULL,
        original_title TEXT,
        year INTEGER,
        status TEXT,
        updated_at TEXT NOT NULL,
        next_air_date TEXT,
        etag TEXT NOT NULL,
        PRIMARY KEY (type, tmdb_id)
      );
      CREATE INDEX meta_index_imdb ON meta_index (imdb_id);
      CREATE INDEX meta_index_tvdb ON meta_index (tvdb_id);
    `,
  },
  {
    version: 13,
    name: 'lancements de titres par pays et par jour (agrégat anonyme, sans donnée de compte, purge après 90 jours)',
    sql: `
      -- Une ligne par jour UTC, pays et titre (key = « type|référence », sans saison ni épisode). n : nombre de comptes
      -- dont c'est la première progression sur ce titre. Aucune clé étrangère : l'agrégat survit à la suppression d'un compte.
      CREATE TABLE title_starts (
        day TEXT NOT NULL,
        country TEXT NOT NULL,
        key TEXT NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (day, country, key)
      );
    `,
  },
  {
    version: 14,
    name: 'handles par profil (Nom#TAG, pid public), amitiés et présence par profil',
    sql: `
      -- Handle : nom normalisé (minuscules) + tag. Identifiant public : pid. Profils enfants : NULL.
      ALTER TABLE profiles ADD COLUMN handle_name TEXT;
      ALTER TABLE profiles ADD COLUMN handle_key TEXT;
      ALTER TABLE profiles ADD COLUMN handle_tag TEXT;
      ALTER TABLE profiles ADD COLUMN pid TEXT;
      CREATE UNIQUE INDEX profiles_handle ON profiles (handle_key, handle_tag);
      CREATE UNIQUE INDEX profiles_pid ON profiles (pid);

      -- Amitiés entre profils : une ligne par paire (low_pid < high_pid, donc une seule quel que soit le sens).
      -- requested_by = pid du demandeur. Supprimées avec le profil (clés étrangères sur pid).
      CREATE TABLE profile_friendships (
        low_pid TEXT NOT NULL REFERENCES profiles (pid) ON DELETE CASCADE,
        high_pid TEXT NOT NULL REFERENCES profiles (pid) ON DELETE CASCADE,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (low_pid, high_pid),
        CHECK (low_pid < high_pid),
        CHECK (requested_by IN (low_pid, high_pid))
      );
      CREATE INDEX profile_friendships_high ON profile_friendships (high_pid);

      -- Présence par profil : statut choisi, titre en cours (JSON, NULL = en ligne seulement), horodatage en ms.
      CREATE TABLE profile_presence (
        profile_pid TEXT PRIMARY KEY REFERENCES profiles (pid) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('online', 'away', 'dnd', 'invisible')),
        watching TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
    run: (db) => {
      backfillProfileIdentities(db);
      db.exec(PROFILE_SOCIAL_BACKFILL_SQL);
    },
  },
  {
    version: 15,
    name: 'messages entre profils et notes sur les titres',
    sql: `
      -- Messages entre profils amis ou du même foyer. Corps 1 à 1000 car. (contrôlé avant écriture), contexte JSON facultatif.
      -- read_at : lecture par le destinataire (NULL = non lu). Supprimés avec le profil.
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        from_pid TEXT NOT NULL REFERENCES profiles (pid) ON DELETE CASCADE,
        to_pid TEXT NOT NULL REFERENCES profiles (pid) ON DELETE CASCADE,
        body TEXT NOT NULL,
        context TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        CHECK (from_pid <> to_pid)
      );
      -- Conversation (les deux sens) ; quota d'envoi par expéditeur sur created_at.
      CREATE INDEX messages_pair ON messages (from_pid, to_pid, created_at);
      CREATE INDEX messages_sent ON messages (from_pid, created_at);

      -- Notes posées sur un titre à une position (saison et épisode à 0 pour un film). Texte ou emoji.
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        author_pid TEXT NOT NULL REFERENCES profiles (pid) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
        tmdb_id INTEGER NOT NULL,
        season INTEGER NOT NULL DEFAULT 0,
        episode INTEGER NOT NULL DEFAULT 0,
        pos REAL NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'emoji')),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX notes_media ON notes (type, tmdb_id, season, episode, pos);
      CREATE INDEX notes_author ON notes (author_pid, created_at);
    `,
  },
  {
    version: 16,
    name: 'journal des créations de notes (quota indépendant des suppressions)',
    sql: `
      -- Une ligne par note créée, purgée au-delà d'une minute (fenêtre du quota). Sans clé étrangère : la remise à zéro
      -- d'identité (pid vidé) ne doit pas être bloquée par ce journal, qui expire de lui-même.
      CREATE TABLE note_creations (
        author_pid TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX note_creations_author ON note_creations (author_pid, created_at);
    `,
  },
  {
    version: 17,
    name: 'nonces des tickets du flux temps réel (usage unique)',
    sql: `
      -- Un ticket du flux social n'ouvre qu'une connexion : son nonce est mémorisé jusqu'à son échéance (ms), puis purgé.
      CREATE TABLE live_ticket_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX live_ticket_nonces_expiry ON live_ticket_nonces (expires_at);
    `,
  },
  {
    version: 18,
    name: 'annonces (bandeau public, fenêtre de dates) et éléments de la boîte de contrôle écartés',
    sql: `
      -- Annonces publiées par le propriétaire. Dates ISO 8601 UTC normalisées à l'écriture ; NULL = sans borne.
      CREATE TABLE announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info', 'warning')),
        starts_at TEXT,
        ends_at TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX announcements_active ON announcements (active, starts_at, ends_at);

      -- Éléments de la boîte de contrôle écartés par l'administrateur : une clé stable par élément (« report:<id> »…).
      CREATE TABLE inbox_dismissed (
        key TEXT PRIMARY KEY,
        dismissed_at TEXT NOT NULL
      );
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
      migration.run?.(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
}
