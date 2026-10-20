import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS } from '../src/user/migrations.js';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import type { SqlDb } from '../src/user/sql.js';

const tables = (db: SqlDb): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);

describe('migrations : v13 de main (title_starts) puis social v2 (14 à 20)', () => {
  it('numérotation continue, v13 = title_starts, social v2 en 14 à 17, annonces en 18, révocation d invitations en 19, sessions (user-agent, dernière activité) en 20', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    expect(MIGRATIONS[12]?.name).toMatch(/^lancements de titres par pays/);
    expect(MIGRATIONS.slice(13).map((m) => m.version)).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('base déjà en v13 (déployée depuis main) : applique 14 à 20 sans toucher à title_starts', () => {
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
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(20);
    expect(tables(db)).toEqual(expect.arrayContaining(['title_starts', 'profile_friendships', 'profile_presence', 'messages', 'notes', 'note_creations', 'live_ticket_nonces']));
    expect(db.prepare('SELECT n FROM title_starts').get()?.n).toBe(3);
    expect(String(db.prepare("SELECT pid FROM profiles WHERE id = 'p1'").get()?.pid)).toMatch(/\S/);
  });

  it('base vierge : 1 à 20', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(20);
    expect(tables(db)).toEqual(expect.arrayContaining(['title_starts', 'live_ticket_nonces', 'announcements', 'inbox_dismissed']));
  });
});
