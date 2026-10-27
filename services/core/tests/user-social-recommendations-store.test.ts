import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/**
 * Coups de cœur de l'accueil au niveau du store (LAST-191, lot 2) : un ami enfant n'apparaît jamais, le plafond de 200 amis
 * examinés s'applique, et la migration 33 crée la table, sa clé et son index, avec suppression en cascade avec le profil.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const ALICE = 'ALICEPID000AAAA';
const BOB = 'BOBPIDAAAAAAAAAA';
const KID = 'KIDPIDAAAAAAAAAA';
/** Amis de la boucle du plafond : `friend000` à `friend200`, soit 201 profils adultes. */
const FRIENDS = 201;

const code = (n: number): string => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 26] ?? 'A';
/** Pid de test (16 caractères) dérivé de l'index : unique pour chaque ami. */
const pidOf = (i: number): string => `${'C'.repeat(13)}${code(Math.floor(i / 676))}${code(Math.floor(i / 26))}${code(i)}`;
/** Noms triés : `friend000` (premier) à `friend200` (dernier). */
const handleOf = (i: number): string => `friend${String(i).padStart(3, '0')}`;

function seeded() {
  const db = openUserDb(':memory:');
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')").run();
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a2', 'hub', 'h', 0, '2026-01-01')").run();
  db.prepare(
    `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
     VALUES ('p-alice', 'a1', 'Alice', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', ?, 'Alice', 'alice', 'A7K2')`,
  ).run(ALICE);
  const friend = (id: string, pid: string, handle: string, isKid: number) => {
    db.prepare(
      `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
       VALUES (?, 'a2', ?, '#00ff00', ?, ?, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
    ).run(id, handle, isKid, isKid === 1 ? 12 : null, pid, handle, handle);
    const [low, high] = ALICE < pid ? [ALICE, pid] : [pid, ALICE];
    db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)").run(
      low,
      high,
      ALICE,
      NOW,
    );
  };
  friend('p-bob', BOB, 'bob', 0);
  friend('p-kid', KID, 'petit', 1);
  return { db, store: new SocialV2Store(db) };
}

const countFor = (db: ReturnType<typeof openUserDb>, pid: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM recommendations WHERE pid = ?').get(pid) as { n: number }).n;

describe('coups de cœur : ami enfant', () => {
  it('le coup de cœur d un profil enfant lié par amitié n apparaît jamais ; celui de Bob, ami adulte, apparaît', () => {
    const { db, store } = seeded();
    store.setRecommendation(BOB, { type: 'movie', tmdbId: 603, title: 'Matrix', word: 'Culte' }, NOW - 60_000);
    db.prepare("INSERT INTO recommendations (pid, type, tmdb_id, title, poster, word, created_at) VALUES (?, 'movie', 680, 'Alien', NULL, 'Enfant', ?)").run(
      KID,
      NOW - 30_000,
    );
    expect(countFor(db, KID)).toBe(1);

    const items = store.homeRecommendations(ALICE, undefined, 50, NOW);
    expect(items.map((item) => item.friend.pid)).toEqual([BOB]);
    expect(items[0]).toMatchObject({ word: 'Culte', media: { type: 'movie', tmdbId: 603, title: 'Matrix' }, createdAt: NOW - 60_000 });
  });
});

describe('coups de cœur : au plus 200 amis examinés', () => {
  it('ordre des noms : bob, friend000 … friend198 sont examinés (200) ; friend199 ne l est pas, même avec un coup de cœur', () => {
    const { db, store } = seeded();
    for (let i = 0; i < FRIENDS; i++) {
      const pid = pidOf(i);
      db.prepare(
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
         VALUES (?, 'a2', ?, '#00ff00', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
      ).run(`p${i}`, handleOf(i), pid, handleOf(i), handleOf(i));
      const [low, high] = ALICE < pid ? [ALICE, pid] : [pid, ALICE];
      db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)").run(
        low,
        high,
        ALICE,
        NOW,
      );
    }
    for (const i of [198, 199]) {
      db.prepare("INSERT INTO recommendations (pid, type, tmdb_id, title, poster, word, created_at) VALUES (?, 'movie', 603, 'Matrix', NULL, 'mot', ?)").run(
        pidOf(i),
        NOW - i,
      );
    }
    const pids = store.homeRecommendations(ALICE, undefined, 50, NOW).map((item) => item.friend.pid);
    expect([...pids].sort()).toEqual([pidOf(198)]);
    expect(pids).not.toContain(pidOf(199));
  });
});

describe('coups de cœur : migration 33', () => {
  it('crée recommendations (clé composite, index sur la date) ; supprime les coups de cœur avec le profil, et seulement les siens', () => {
    const { db, store } = seeded();
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(33);

    const columns = (db.prepare('PRAGMA table_info(recommendations)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toEqual(['pid', 'type', 'tmdb_id', 'title', 'poster', 'word', 'created_at']);
    const indexes = (db.prepare('PRAGMA index_list(recommendations)').all() as { name: string }[]).map((index) => index.name);
    expect(indexes).toContain('recommendations_created');

    store.setRecommendation(BOB, { type: 'movie', tmdbId: 603, title: 'Matrix', word: 'Culte' }, NOW);
    db.prepare("INSERT INTO recommendations (pid, type, tmdb_id, title, poster, word, created_at) VALUES (?, 'movie', 680, 'Alien', NULL, 'x', ?)").run(
      KID,
      NOW,
    );
    expect(countFor(db, BOB)).toBe(1);

    db.prepare('DELETE FROM profiles WHERE pid = ?').run(BOB);
    expect(countFor(db, BOB)).toBe(0);
    expect(countFor(db, KID)).toBe(1);
  });
});
