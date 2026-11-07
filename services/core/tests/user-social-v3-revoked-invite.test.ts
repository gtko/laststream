import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { SocialV3Store } from '../src/user/social-v3-store.js';
import type { SqlDb } from '../src/user/sql.js';

/** Liens publics et invitations révoquées par l'administration : une invitation révoquée n'est jamais réservée. */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const PID = 'PID1AAAAAAAAAAAA';

function seeded(quota: number): SqlDb {
  const db = openUserDb(':memory:');
  db.exec(`INSERT INTO accounts (id, username, password_hash, is_owner, created_at, invite_quota) VALUES ('a1', 'user1', 'h', 1, '2026-01-01', ${quota})`);
  db.exec(
    `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
     VALUES ('p1', 'a1', 'User1', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', '${PID}', 'User1', 'user1', 'A7K1')`,
  );
  db.exec("INSERT INTO invites (id, code, inviter_id, created_at, revoked_at) VALUES ('i-rev', 'REVOKEDCODE', 'a1', '2026-01-03', '2026-02-01T00:00:00.000Z')");
  return db;
}

const input = { type: 'movie' as const, tmdbId: 603, title: 'Matrix', withInvite: true };

describe('liens publics : invitation révoquée', () => {
  it('une invitation révoquée compte dans le quota et n est pas réservée', () => {
    const db = seeded(1);
    const outcome = new SocialV3Store(db).createShareLink('a1', PID, input, NOW);
    expect(outcome.result).toBe('invite_quota_reached');
    expect(db.prepare("SELECT sent_at FROM invites WHERE id = 'i-rev'").get()?.sent_at).toBeNull();
  });

  it('avec de la marge dans le quota, une nouvelle invitation est créée : jamais celle révoquée', () => {
    const db = seeded(2);
    const outcome = new SocialV3Store(db).createShareLink('a1', PID, input, NOW);
    expect(outcome.result).toBe('ok');
    if (outcome.result !== 'ok') return;
    expect(outcome.inviteCode).toBeTypeOf('string');
    expect(outcome.inviteCode).not.toBe('REVOKEDCODE');
    expect(db.prepare("SELECT sent_at, revoked_at FROM invites WHERE id = 'i-rev'").get()).toMatchObject({ sent_at: null, revoked_at: '2026-02-01T00:00:00.000Z' });
  });
});
