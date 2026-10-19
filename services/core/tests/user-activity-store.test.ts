import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/**
 * Store d'activité (S5) directement : écriture publique `recordActivity` (favoris, listes, notes sur 5 — appelée par
 * d'autres lots), règles de note et flux. Base SQLite en mémoire, deux comptes avec un profil principal chacun, amis.
 */

const ALICE = 'ALICEPID000AAAA';
const BOB = 'BOBPID0000000BBB';
const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const DAY = 86_400_000;

function seeded(): { db: ReturnType<typeof openUserDb>; store: SocialV2Store } {
  const db = openUserDb(':memory:');
  db.exec(
    "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01'), ('a2', 'bob', 'h', 0, '2026-01-01')",
  );
  db.exec(
    `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
     VALUES ('p1', 'a1', 'Alice', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', '${ALICE}', 'Alice', 'alice', 'A7K2'),
            ('p2', 'a2', 'Bob', '#00ff00', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', '${BOB}', 'Bob', 'bob', 'B3C4')`,
  );
  db.exec(
    `INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES ('${ALICE}', '${BOB}', '${ALICE}', 'accepted', 0)`,
  );
  return { db, store: new SocialV2Store(db) };
}

const MATRIX = { type: 'movie', tmdbId: 603 } as const;

describe('écriture publique d’activité (recordActivity)', () => {
  it('favori et liste : titre et affiche fournis, un événement par genre, titre et jour', () => {
    const { store } = seeded();
    const favorite = store.recordActivity(ALICE, 'favorited', MATRIX, { title: 'Matrix', poster: '/m.jpg' }, NOW);
    expect(favorite).toMatchObject({ kind: 'favorited', pid: ALICE, handle: { full: 'Alice#A7K2' }, media: { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/m.jpg' } });
    expect(favorite?.media).not.toHaveProperty('season');

    // Même genre, même titre, même jour : dédoublonné. Autre genre ou autre jour : nouvel événement.
    expect(store.recordActivity(ALICE, 'favorited', MATRIX, { title: 'Matrix' }, NOW + 1000)).toBeUndefined();
    expect(store.recordActivity(ALICE, 'listed', MATRIX, { title: 'Matrix' }, NOW)).toBeDefined();
    expect(store.recordActivity(ALICE, 'favorited', MATRIX, { title: 'Matrix' }, NOW + DAY)).toBeDefined();
  });

  it('note sur 5 : demi-étoiles de 0,5 à 5 acceptées, le reste refusé', () => {
    const { store } = seeded();
    expect(store.recordActivity(ALICE, 'rated', { type: 'movie', tmdbId: 680 }, { rating: 4.5 }, NOW)?.rating).toBe(4.5);
    expect(store.recordActivity(ALICE, 'rated', { type: 'movie', tmdbId: 681 }, { rating: 4.3 }, NOW)).toBeUndefined();
    expect(store.recordActivity(ALICE, 'rated', { type: 'movie', tmdbId: 682 }, { rating: 6 }, NOW)).toBeUndefined();
  });

  it('série : saison et épisode gardés ; un seul événement par titre et jour, quel que soit l’épisode', () => {
    const { store } = seeded();
    const first = store.recordActivity(ALICE, 'noted', { type: 'series', tmdbId: 1399, season: 2, episode: 4 }, {}, NOW);
    expect(first?.media).toMatchObject({ type: 'series', tmdbId: 1399, season: 2, episode: 4 });
    expect(store.recordActivity(ALICE, 'noted', { type: 'series', tmdbId: 1399, season: 2, episode: 5 }, {}, NOW + 1000)).toBeUndefined();
  });

  it('profil sans identité sociale : aucun événement', () => {
    const { store } = seeded();
    expect(store.recordActivity('INCONNU', 'listed', MATRIX, {}, NOW)).toBeUndefined();
  });

  it('flux : l’ami voit l’événement, je ne vois pas le mien, un statut invisible le masque', () => {
    const { db, store } = seeded();
    store.recordActivity(BOB, 'favorited', MATRIX, { title: 'Matrix' }, NOW);
    expect(store.activityFeed(ALICE, undefined, 30).map((item) => item.pid)).toEqual([BOB]);
    expect(store.activityFeed(BOB, undefined, 30)).toEqual([]);

    db.exec(`INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES ('${BOB}', 'invisible', NULL, 0)`);
    expect(store.activityFeed(ALICE, undefined, 30)).toEqual([]);
  });
});
