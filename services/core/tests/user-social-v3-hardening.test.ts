import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openUserDb, wrapSqlite } from '../src/platform/node/user-db.js';
import { MIGRATIONS, migrate } from '../src/user/migrations.js';
import { syncProfileIdentity } from '../src/user/social-handles.js';
import { SocialV3Store } from '../src/user/social-v3-store.js';
import type { SqlDb } from '../src/user/sql.js';
import { UserStore } from '../src/user/store.js';

/**
 * Durcissement social v3 testé contre SQLite Node directement (hors runtime Workers) : identité retirée sans résidu, migration
 * 23, limites persistantes, expiration des liens publics. Les cas HTTP sont dans social-v3-hardening.test.ts.
 */

const START = Date.parse('2026-05-01T10:00:00.000Z');
const DAY = 24 * 3_600_000;

/** Base Node avec deux ou trois profils adultes (pid PID1…), sans passer par HTTP. */
function seeded(count = 3): SqlDb {
  const db = openUserDb(':memory:');
  for (let n = 1; n <= count; n += 1) {
    db.exec(`INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a${n}', 'user${n}', 'h', ${n === 1 ? 1 : 0}, '2026-01-01')`);
    db.exec(
      `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
       VALUES ('p${n}', 'a${n}', 'User${n}', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:0${n}.000Z', 'PID${n}AAAAAAAAAAAA', 'User${n}', 'user${n}', 'A7K${n}')`,
    );
  }
  return db;
}

const countOf = (db: SqlDb, table: string): number => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);

describe('1. identité retirée : tables et groupes (base directe)', () => {
  it('passage en enfant avec activité, lien (invitation réservée), liste et éléments : aucune erreur de clé étrangère, invitation libérée', () => {
    const db = seeded(2);
    const v3 = new SocialV3Store(db);
    const created = v3.createShareLink('a1', 'PID1AAAAAAAAAAAA', { type: 'movie', tmdbId: 603, title: 'Matrix', withInvite: true }, START);
    expect(created.result).toBe('ok');
    db.exec("INSERT INTO activity (id, pid, kind, type, tmdb_id, title, day, at) VALUES ('x1', 'PID1AAAAAAAAAAAA', 'started', 'movie', 603, 'Matrix', '2026-05-01', 1)");
    const list = v3.createList('PID1AAAAAAAAAAAA', 'Liste', [], START);
    expect(list.result).toBe('ok');
    if (list.result !== 'ok') return;
    expect(v3.addItem('PID1AAAAAAAAAAAA', list.list.id, { type: 'movie', tmdbId: 1, title: 'A' }, START).result).toBe('ok');
    // Un élément ajouté par ce profil dans la liste d'un autre.
    db.exec("INSERT INTO shared_lists (id, owner_pid, name, created_at) VALUES ('other', 'PID2AAAAAAAAAAAA', 'L2', 1)");
    db.exec("INSERT INTO shared_list_members (list_id, pid) VALUES ('other', 'PID2AAAAAAAAAAAA'), ('other', 'PID1AAAAAAAAAAAA')");
    db.exec("INSERT INTO shared_list_items (list_id, type, tmdb_id, title, added_by, added_at) VALUES ('other', 'movie', 2, 'B', 'PID1AAAAAAAAAAAA', 1)");

    expect(() => syncProfileIdentity(db, 'a1', 'p1', 'User1', true)).not.toThrow();

    for (const table of ['activity', 'share_links', 'shared_list_items', 'shared_list_members']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'activity' ? 'pid' : table === 'share_links' ? 'author_pid' : table === 'shared_list_items' ? 'added_by' : 'pid'} = 'PID1AAAAAAAAAAAA'`).get()?.n).toBe(0);
    }
    expect(countOf(db, 'shared_lists')).toBe(1);
    expect(db.prepare("SELECT pid FROM profiles WHERE id = 'p1'").get()?.pid).toBeNull();
    const invite = db.prepare('SELECT sent_at FROM invites WHERE inviter_id = ?').get('a1');
    expect(invite?.sent_at).toBeNull();
  });

  it('suppression de profil : groupe devenu vide supprimé, propriété transmise au plus ancien membre', () => {
    const db = seeded(3);
    db.exec("INSERT INTO social_groups (id, name, created_by, created_at) VALUES ('solo', 'Seul', 'PID1AAAAAAAAAAAA', 1), ('trio', 'Trio', 'PID1AAAAAAAAAAAA', 1)");
    db.exec(
      `INSERT INTO social_group_members (group_id, pid, joined_at, read_at) VALUES
         ('solo', 'PID1AAAAAAAAAAAA', 1, 1),
         ('trio', 'PID1AAAAAAAAAAAA', 1, 1), ('trio', 'PID3AAAAAAAAAAAA', 3, 3), ('trio', 'PID2AAAAAAAAAAAA', 2, 2)`,
    );
    expect(new UserStore(db).deleteProfile('a1', 'p1')).toBe(true);
    expect(db.prepare("SELECT id FROM social_groups WHERE id = 'solo'").get()).toBeUndefined();
    expect(db.prepare("SELECT created_by FROM social_groups WHERE id = 'trio'").get()?.created_by).toBe('PID2AAAAAAAAAAAA');
  });

  it('migration 23 : groupe sans membre supprimé, propriétaire parti remplacé par le plus ancien membre', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 22));
    db.exec("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'u1', 'h', 1, '2026-01-01'), ('a2', 'u2', 'h', 0, '2026-01-01')");
    for (const n of [1, 2]) {
      db.exec(
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
         VALUES ('p${n}', 'a${n}', 'U${n}', '#f00', 0, NULL, '[]', '2026-01-02', 'PID${n}AAAAAAAAAAAA', 'U${n}', 'u${n}', 'A7K${n}')`,
      );
    }
    db.exec("INSERT INTO social_groups (id, name, created_by, created_at) VALUES ('g1', 'G', 'GONE', 1), ('g2', 'Vide', 'GONE', 1)");
    db.exec("INSERT INTO social_group_members (group_id, pid, joined_at, read_at) VALUES ('g1', 'PID2AAAAAAAAAAAA', 5, 5), ('g1', 'PID1AAAAAAAAAAAA', 9, 9)");
    migrate(db);
    expect(db.prepare("SELECT id FROM social_groups WHERE id = 'g2'").get()).toBeUndefined();
    expect(db.prepare("SELECT created_by FROM social_groups WHERE id = 'g1'").get()?.created_by).toBe('PID2AAAAAAAAAAAA');
  });
});

describe('5. limites de débit persistantes (base directe)', () => {
  it('les limites sont comptées en base : une autre instance du store partage le compteur', () => {
    const db = seeded(1);
    const first = new SocialV3Store(db);
    const second = new SocialV3Store(db);
    for (let n = 0; n < 60; n += 1) expect(first.consumePublicRead('203.0.113.9', START)).toBeUndefined();
    expect(second.consumePublicRead('203.0.113.9', START)).toBeGreaterThan(0);
    expect(second.consumePublicRead('203.0.113.10', START)).toBeUndefined();
    // Seul un condensat de l'adresse est conservé.
    const keys = db.prepare('SELECT DISTINCT key FROM rate_hits').all().map((row) => String(row.key));
    expect(keys.every((key) => !key.includes('203.0.113'))).toBe(true);
  });
});

describe('8. liens publics : expiration (base directe)', () => {
  it('base directe : un lien expiré rend son emplacement d’invitation, qui sert à un nouveau lien', () => {
    const db = seeded(1);
    const store = new SocialV3Store(db);
    const input = { type: 'movie' as const, tmdbId: 1, title: 'A', withInvite: true };
    const first = store.createShareLink('a1', 'PID1AAAAAAAAAAAA', input, START);
    expect(first.result).toBe('ok');
    if (first.result !== 'ok') return;
    expect(store.shareLinkByCode(first.code, START + 29 * DAY)).toMatchObject({ title: 'A' });
    expect(store.shareLinkByCode(first.code, START + 30 * DAY)).toBe('expired');
    expect(db.prepare('SELECT sent_at FROM invites WHERE inviter_id = ?').get('a1')?.sent_at).toBeNull();
    const second = store.createShareLink('a1', 'PID1AAAAAAAAAAAA', input, START + 31 * DAY);
    expect(second.result).toBe('ok');
    if (second.result === 'ok') expect(second.inviteCode).toBe(first.inviteCode);
  });
});
