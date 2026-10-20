import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS } from '../src/user/migrations.js';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import type { SqlDb } from '../src/user/sql.js';

const tables = (db: SqlDb): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);

/** Versions présentes : 1 à 27, contiguës (social v2 en 14 à 17, social v3 en 18 à 23, administration en 24 à 26, invitations du foyer en 27). */
const EXPECTED_VERSIONS = Array.from({ length: 27 }, (_, i) => i + 1);

describe('migrations : v13 de main (title_starts) puis social v2 (14 à 17), social v3 (18 à 23), administration (24 à 26)', () => {
  it('numérotation continue, v13 = title_starts, social v2 en 14 à 17, social v3 en 18 à 23, annonces en 24, révocation d invitations en 25, sessions (user-agent, dernière activité) en 26', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(EXPECTED_VERSIONS);
    expect(MIGRATIONS[12]?.name).toMatch(/^lancements de titres par pays/);
    expect(MIGRATIONS.slice(13).map((m) => m.version)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
  });

  it('base déjà en v13 (déployée depuis main) : applique 14 à 27 sans toucher à title_starts', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 13));
    db.exec("INSERT INTO title_starts (day, country, key, n) VALUES ('2026-01-01', 'CH', 'movie|tt1', 3)");
    db.exec("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')");
    db.exec(
      "INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at) VALUES ('p1', 'a1', 'Greg', '#000000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z')",
    );
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(13);

    migrate(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => (r as { version: number }).version)).toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(27);
    expect(tables(db)).toEqual(
      expect.arrayContaining(['title_starts', 'profile_friendships', 'profile_presence', 'messages', 'notes', 'note_creations', 'live_ticket_nonces', 'share_links', 'shared_lists', 'announcements', 'inbox_dismissed']),
    );
    expect(db.prepare('SELECT n FROM title_starts').get()?.n).toBe(3);
    expect(String(db.prepare("SELECT pid FROM profiles WHERE id = 'p1'").get()?.pid)).toMatch(/\S/);
  });

  it('base vierge : 1 à 27', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(EXPECTED_VERSIONS.length);
    expect(tables(db)).toEqual(expect.arrayContaining(['title_starts', 'live_ticket_nonces']));
  });

  it('base v17 avec messages : la reconstruction de la table garde chaque message (kind text, destinataire, ordre)', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 17));
    db.exec("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01'), ('a2', 'bob', 'h', 0, '2026-01-01')");
    db.exec(
      "INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag) VALUES ('p1', 'a1', 'Alice', '#000000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', 'PPPPPPPPPPPPPPPP', 'Alice', 'alice', 'AAAA'), ('p2', 'a2', 'Bob', '#000000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', 'QQQQQQQQQQQQQQQQ', 'Bob', 'bob', 'BBBB')",
    );
    db.exec(
      `INSERT INTO messages (id, from_pid, to_pid, body, context, created_at, read_at) VALUES ('m1', 'PPPPPPPPPPPPPPPP', 'QQQQQQQQQQQQQQQQ', 'un', NULL, 1000, NULL), ('m2', 'QQQQQQQQQQQQQQQQ', 'PPPPPPPPPPPPPPPP', 'deux', '{"type":"movie","tmdbId":603}', 2000, 2500)`,
    );

    migrate(db);

    const rows = db.prepare('SELECT id, to_pid, group_id, kind, body, context, created_at, read_at FROM messages ORDER BY created_at').all();
    expect(rows).toEqual([
      { id: 'm1', to_pid: 'QQQQQQQQQQQQQQQQ', group_id: null, kind: 'text', body: 'un', context: null, created_at: 1000, read_at: null },
      { id: 'm2', to_pid: 'PPPPPPPPPPPPPPPP', group_id: null, kind: 'text', body: 'deux', context: '{"type":"movie","tmdbId":603}', created_at: 2000, read_at: 2500 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
  });
});
