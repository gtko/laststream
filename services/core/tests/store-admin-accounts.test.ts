import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { AdminStore } from '../src/user/admin-store.js';

// Tests Node seulement : base node:sqlite (openUserDb). Hors de la config Workers, qui inclut tests/admin-*.test.ts.
describe('AdminStore : export plafonné et présence sans rig', () => {
  const ACCOUNT_SQL = 'INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)';

  it('export au-delà du plafond : `truncated`, jamais plus de `max` comptes', () => {
    const db = openUserDb(':memory:');
    const insert = db.prepare(ACCOUNT_SQL);
    insert.run('00000000-0000-4000-8000-000000000001', 'un', 'h', 1, '2026-01-01T00:00:00.000Z');
    insert.run('00000000-0000-4000-8000-000000000002', 'deux', 'h', 0, '2026-01-02T00:00:00.000Z');
    insert.run('00000000-0000-4000-8000-000000000003', 'trois', 'h', 0, '2026-01-03T00:00:00.000Z');
    const store = new AdminStore(db);
    const capped = store.exportAccounts({ filter: 'all' }, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.accounts.map((a) => a.username)).toEqual(['trois', 'deux']);
    const whole = store.exportAccounts({ filter: 'all' }, 3);
    expect(whole.truncated).toBe(false);
    expect(whole.accounts).toHaveLength(3);
    // Trois comptes sans activité depuis 2026-01 : tous inactifs, aucun en ligne.
    expect(store.listAccounts({ order: 'newest', limit: 25, filter: 'all' }).counts).toEqual({ all: 3, online: 0, inactive30: 3, suspended: 0, noInvites: 0 });
    db.close();
  });

  it('présence au JSON illisible ou sans titre : titre en cours absent, compte tout de même listé', () => {
    const db = openUserDb(':memory:');
    db.prepare(ACCOUNT_SQL).run('00000000-0000-4000-8000-000000000001', 'un', 'h', 1, '2026-01-01T00:00:00.000Z');
    db.prepare(ACCOUNT_SQL).run('00000000-0000-4000-8000-000000000002', 'deux', 'h', 0, '2026-01-01T00:00:00.000Z');
    const now = new Date().toISOString();
    const presence = db.prepare('INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES (?, ?, ?, ?, 0)');
    presence.run('00000000-0000-4000-8000-000000000001', null, now, 'pas du json');
    presence.run('00000000-0000-4000-8000-000000000002', null, now, '{"type":"movie"}');
    const online = new AdminStore(db).onlineAccounts();
    expect(online.map((a) => [a.username, a.watching])).toEqual([
      ['un', null],
      ['deux', null],
    ]);
    db.close();
  });
});
