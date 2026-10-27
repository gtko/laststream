import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/**
 * Plafond d'amis de l'accueil (200, comme MAX_FRIENDS), testé directement sur le store : créer 201 amis en HTTP serait trop
 * lent (un compte par ami, hachage scrypt). Les amis sont insérés en SQL, sur un seul compte distinct de celui du lecteur.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const ALICE = 'ALICEPID000AAAA';
const FRIENDS = 201;

const code = (n: number): string => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 26] ?? 'A';
/** Pid de test (16 caractères) dérivé de l'index : unique pour chaque ami. */
const pidOf = (i: number): string => `${'C'.repeat(13)}${code(Math.floor(i / 676))}${code(Math.floor(i / 26))}${code(i)}`;
/** Noms triés : `friend000` (premier) à `friend200` (201e, hors plafond). */
const handleOf = (i: number): string => `friend${String(i).padStart(3, '0')}`;

interface Seeded {
  db: ReturnType<typeof openUserDb>;
  store: SocialV2Store;
}

function seeded(): Seeded {
  const db = openUserDb(':memory:');
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')").run();
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a2', 'hub', 'h', 0, '2026-01-01')").run();
  db.prepare(
    `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
     VALUES ('p-alice', 'a1', 'Alice', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', ?, 'Alice', 'alice', 'A7K2')`,
  ).run(ALICE);
  for (let i = 0; i < FRIENDS; i++) {
    const pid = pidOf(i);
    db.prepare(
      `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
       VALUES (?, 'a2', ?, '#00ff00', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
    ).run(`p${i}`, handleOf(i), pid, handleOf(i), handleOf(i));
    const [low, high] = ALICE < pid ? [ALICE, pid] : [pid, ALICE];
    db.prepare(
      "INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)",
    ).run(low, high, ALICE, NOW);
  }
  return { db, store: new SocialV2Store(db) };
}

describe('accueil : au plus 200 amis examinés (ordre des noms)', () => {
  it('le premier ami, qui regarde, apparaît ; le 201e, qui regarde aussi, est hors plafond', () => {
    const { db, store } = seeded();
    for (const i of [0, FRIENDS - 1]) {
      db.prepare(
        `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished, manual)
         VALUES (?, 'movie', 'tmdb:603', 603, NULL, 0, 0, 600, 7200, ?, 0, 0)`,
      ).run(`p${i}`, new Date(NOW - 60_000).toISOString());
    }
    const pids = store.homeWatching(ALICE, 50, NOW).map((item) => item.friend.pid);
    expect(pids).toEqual([pidOf(0)]);
  });
});
