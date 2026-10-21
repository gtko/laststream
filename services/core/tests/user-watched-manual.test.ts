import { describe, expect, it } from 'vitest';
import { openUserDb } from '../src/platform/node/user-db.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';
import { type ProgressWrite, UserStore } from '../src/user/store.js';

/**
 * « Marqué vu » à la main (ODY-207) : une ligne de progression écrite par un marquage manuel (colonne `manual`) reste
 * dans « vus » du profil, mais n'entre ni dans l'historique récent ni dans le flux des amis.
 */

const ALICE = 'ALICEPID000AAAA';
const BOB = 'BOBPID0000000BBB';
const T0 = '2026-05-01T10:00:00.000Z';
const T1 = '2026-05-01T11:00:00.000Z';

/** Deux comptes, un profil principal chacun (p1 = Alice, p2 = Bob), amis acceptés. Base SQLite en mémoire. */
function seeded() {
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
    `INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at, accepted_at)
     VALUES ('${ALICE}', '${BOB}', '${ALICE}', 'accepted', 0, 0)`,
  );
  return { db, users: new UserStore(db), social: new SocialV2Store(db) };
}

/** Historique récent que Bob voit d'Alice. Échoue si le lien d'amitié n'est pas reconnu. */
function historyOfAlice(social: SocialV2Store) {
  const outcome = social.friendHistory(BOB, ALICE, 50);
  if (outcome.result !== 'ok') throw new Error(`historique ${outcome.result}`);
  return outcome.items;
}

const movie = (tmdbId: number, over: Partial<ProgressWrite> = {}): ProgressWrite => ({
  profileId: 'p1',
  type: 'movie',
  tmdbId,
  imdbId: null,
  season: 0,
  episode: 0,
  positionSec: 7000,
  durationSec: 7200,
  updatedAt: T0,
  finished: true,
  ...over,
});

const episode = (tmdbId: number, season: number, number: number, over: Partial<ProgressWrite> = {}): ProgressWrite => ({
  profileId: 'p1',
  type: 'series',
  tmdbId,
  imdbId: null,
  season,
  episode: number,
  positionSec: 2900,
  durationSec: 3000,
  updatedAt: T0,
  finished: true,
  ...over,
});

describe('colonne manual (migration 29)', () => {
  it('vaut 0 par défaut : une ligne écrite par la lecture n’est pas un marquage manuel', () => {
    const { db } = seeded();
    db.exec(
      `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, season, episode, position_sec, duration_sec, updated_at, finished)
       VALUES ('p1', 'movie', 'tmdb:603', 603, 0, 0, 10, 100, '${T0}', 0)`,
    );
    expect(db.prepare('SELECT manual FROM progress').get()).toEqual({ manual: 0 });
  });
});

describe('vu manuel (setWatched) : hors historique des amis, présent dans « vus »', () => {
  it('un film et une saison marqués vus : dans mes vus, absents de l’historique de l’ami', () => {
    const { users, social } = seeded();
    users.setWatched({ profileId: 'p1', type: 'movie', tmdbId: 603, imdbId: null, episodes: [{ season: 0, episode: 0 }], watched: true, updatedAt: T0 });
    users.setWatched({
      profileId: 'p1',
      type: 'series',
      tmdbId: 1399,
      imdbId: null,
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      watched: true,
      updatedAt: T0,
    });

    expect(historyOfAlice(social)).toEqual([]);
    const watched = users.watchedTitles('p1');
    expect(watched).toHaveLength(2);
    expect(watched.find((title) => title.tmdbId === 603)?.watched).toBe(1);
    expect(watched.find((title) => title.tmdbId === 1399)?.watched).toBe(2);
  });

  it('un vrai visionnage terminé (durée connue) reste visible chez l’ami, avec son état vu', () => {
    const { users, social } = seeded();
    users.upsertProgress(movie(680));
    expect(historyOfAlice(social)).toEqual([expect.objectContaining({ tmdbId: 680, watched: true })]);
  });

  it('marquer vu un épisode déjà réellement terminé garde son statut réel : toujours visible', () => {
    const { db, users, social } = seeded();
    users.upsertProgress(episode(1399, 1, 1));
    users.setWatched({ profileId: 'p1', type: 'series', tmdbId: 1399, imdbId: null, episodes: [{ season: 1, episode: 1 }], watched: true, updatedAt: T1 });

    expect(db.prepare('SELECT manual FROM progress').get()).toEqual({ manual: 0 });
    expect(historyOfAlice(social)).toEqual([
      expect.objectContaining({ tmdbId: 1399, season: 1, episode: 1, watched: true, updatedAt: Date.parse(T0) }),
    ]);
  });

  it('une lecture en cours marquée vue à la main sort de l’historique de l’ami', () => {
    const { users, social } = seeded();
    users.upsertProgress(movie(603, { positionSec: 100, durationSec: 7200, finished: false }));
    expect(historyOfAlice(social)).toEqual([expect.objectContaining({ tmdbId: 603, watched: false })]);

    users.setWatched({ profileId: 'p1', type: 'movie', tmdbId: 603, imdbId: null, episodes: [{ season: 0, episode: 0 }], watched: true, updatedAt: T1 });
    expect(historyOfAlice(social)).toEqual([]);
  });

  it('une lecture réelle après un marquage manuel remet l’entrée visible chez l’ami', () => {
    const { users, social } = seeded();
    users.setWatched({ profileId: 'p1', type: 'movie', tmdbId: 603, imdbId: null, episodes: [{ season: 0, episode: 0 }], watched: true, updatedAt: T0 });
    expect(historyOfAlice(social)).toEqual([]);

    users.upsertProgress(movie(603, { updatedAt: T1 }));
    expect(historyOfAlice(social)).toEqual([expect.objectContaining({ tmdbId: 603, watched: true })]);
  });
});

describe('anciennes lignes d’un marquage manuel (avant la v29) : masquées si sans durée', () => {
  it('finished = 1 sans durée (position 0) masquée ; finished = 1 avec durée reste visible', () => {
    const { db, social } = seeded();
    db.exec(
      `INSERT INTO progress (profile_id, type, title_ref, tmdb_id, season, episode, position_sec, duration_sec, updated_at, finished)
       VALUES ('p1', 'movie', 'tmdb:603', 603, 0, 0, 0, 0, '${T0}', 1),
              ('p1', 'movie', 'tmdb:680', 680, 0, 0, 7000, 7200, '${T1}', 1)`,
    );
    expect(historyOfAlice(social).map((item) => item.tmdbId)).toEqual([680]);
  });
});
