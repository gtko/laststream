import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { purgeSocialData } from '../src/user/social-handles.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/**
 * Règles de l'accueil au niveau du store (LAST-191) : foyer exclu, ami enfant exclu, progression terminée sans durée ignorée,
 * purge des coups de cœur. Les profils et amitiés sont insérés en SQL : les routes HTTP ne passent pas par ces branches.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const ALICE = 'ALICEPID000AAAA';
const HOME = 'HOMEPIDAAAAAAAAA';
const BOB = 'BOBPIDAAAAAAAAAA';
const KID = 'KIDPIDAAAAAAAAAA';

function seeded() {
  const db = openUserDb(':memory:');
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')").run();
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a2', 'hub', 'h', 0, '2026-01-01')").run();
  const profile = (id: string, account: string, pid: string, handle: string, isKid: number) =>
    db
      .prepare(
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
         VALUES (?, ?, ?, '#00ff00', ?, ?, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
      )
      .run(id, account, handle, isKid, isKid === 1 ? 12 : null, pid, handle, handle);
  const accept = (pid: string) => {
    const [low, high] = ALICE < pid ? [ALICE, pid] : [pid, ALICE];
    db.prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)").run(low, high, ALICE, NOW);
  };
  const progress = (profileId: string, tmdbId: number, finished: number, duration: number) =>
    db
      .prepare(
        `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, imdb_id, season, episode, position_sec, duration_sec, updated_at, finished, manual)
         VALUES (?, 'movie', ?, ?, NULL, 0, 0, 600, ?, ?, ?, 0)`,
      )
      .run(profileId, `tmdb:${tmdbId}`, tmdbId, duration, new Date(NOW - 60_000).toISOString(), finished);
  const recommend = (pid: string) =>
    db.prepare("INSERT INTO recommendations (pid, type, tmdb_id, title, poster, word, created_at) VALUES (?, 'movie', 603, 'Matrix', NULL, 'Top', ?)").run(pid, NOW - 1000);
  profile('p-alice', 'a1', ALICE, 'alice', 0);
  return { db, store: new SocialV2Store(db), profile, accept, progress, recommend };
}

const REFS = [{ type: 'movie' as const, tmdbId: 603 }];

describe('accueil : foyer exclu (amitié acceptée entre deux profils du même compte)', () => {
  it('le profil du foyer est absent des trois lectures ; le témoin Bob, ami d un autre compte, est présent', () => {
    const s = seeded();
    s.profile('p-home', 'a1', HOME, 'maison', 0);
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    s.accept(HOME);
    s.accept(BOB);
    for (const id of ['p-home', 'p-bob']) s.progress(id, 603, 0, 7200);
    s.recommend(HOME);
    s.recommend(BOB);
    expect(s.store.homeWatching(ALICE, 50, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
    expect(s.store.friendsProgressFor(ALICE, REFS, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
    expect(s.store.homeRecommendations(ALICE, undefined, 50, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
  });
});

describe('accueil : ami enfant exclu', () => {
  it('l ami enfant qui regarde est absent de homeWatching et friendsProgressFor ; Bob est présent', () => {
    const s = seeded();
    s.profile('p-kid', 'a2', KID, 'petit', 1);
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    s.accept(KID);
    s.accept(BOB);
    for (const id of ['p-kid', 'p-bob']) s.progress(id, 603, 0, 7200);
    expect(s.store.homeWatching(ALICE, 50, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
    expect(s.store.friendsProgressFor(ALICE, REFS, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
  });
});

describe('accueil : progression terminée sans durée', () => {
  it('finished = 1 et duration_sec = 0 est ignorée ; une progression terminée avec une durée reste visible', () => {
    const s = seeded();
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    s.accept(BOB);
    s.progress('p-bob', 603, 1, 0);
    expect(s.store.homeWatching(ALICE, 50, NOW)).toEqual([]);
    expect(s.store.friendsProgressFor(ALICE, REFS, NOW)).toEqual([]);
    s.db.prepare("UPDATE progress SET duration_sec = 7200 WHERE profile_id = 'p-bob'").run();
    expect(s.store.homeWatching(ALICE, 50, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
    expect(s.store.friendsProgressFor(ALICE, REFS, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
  });
});

describe('coups de cœur : choix produit', () => {
  it('historyVisible faux et activityVisibility « nobody » chez l ami laissent ses coups de cœur visibles (geste volontaire), alors que son visionnage disparaît', () => {
    const s = seeded();
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    s.accept(BOB);
    s.progress('p-bob', 603, 0, 7200);
    s.recommend(BOB);
    expect(s.store.homeWatching(ALICE, 50, NOW)).toHaveLength(1);
    s.store.updatePrefs(BOB, { historyVisible: false, activityVisibility: 'nobody' });
    expect(s.store.homeWatching(ALICE, 50, NOW)).toEqual([]);
    expect(s.store.homeRecommendations(ALICE, undefined, 50, NOW).map((i) => i.friend.pid)).toEqual([BOB]);
  });
});

describe('coups de cœur : purge', () => {
  it('purgeSocialData supprime les coups de cœur du pid, puis le pid peut être vidé sans violer la clé étrangère ; ceux des autres restent', () => {
    const s = seeded();
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    s.recommend(BOB);
    s.recommend(ALICE);
    purgeSocialData(s.db, BOB);
    const left = (s.db.prepare('SELECT pid FROM recommendations').all() as { pid: string }[]).map((r) => r.pid);
    expect(left).toEqual([ALICE]);
    expect(() => s.db.prepare("UPDATE profiles SET pid = NULL, handle_name = NULL, handle_key = NULL, handle_tag = NULL WHERE id = 'p-bob'").run()).not.toThrow();
  });
});

describe('coups de cœur : plafond de 500 par profil', () => {
  it('une nouvelle clé au-delà de 500 est refusée ; remplacer une clé existante reste permis', () => {
    const s = seeded();
    s.profile('p-bob', 'a2', BOB, 'bob', 0);
    const insert = s.db.prepare("INSERT INTO recommendations (pid, type, tmdb_id, title, poster, word, created_at) VALUES (?, 'movie', ?, 't', NULL, 'w', ?)");
    for (let i = 1; i <= 499; i++) insert.run(BOB, i, NOW);
    const input = (tmdbId: number) => ({ type: 'movie' as const, tmdbId, title: 'T', word: 'mot' });
    expect(s.store.setRecommendation(BOB, input(1000), NOW)).toBe('ok');
    expect(s.store.setRecommendation(BOB, input(1001), NOW)).toBe('limit_reached');
    expect(s.store.setRecommendation(BOB, input(7), NOW)).toBe('ok');
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM recommendations WHERE pid = ?').get(BOB) as { n: number }).n).toBe(500);
    expect(s.store.setRecommendation(ALICE, input(1001), NOW)).toBe('ok');
  });
});
