import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openUserDb, wrapSqlite } from '../src/platform/node/user-db.js';
import { migrate } from '../src/user/migrations.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/** Réconciliations de fusion testées contre SQLite Node directement (hors runtime Workers) : migrations, titre d'activité. */

describe('migrations : le payload de partage n a plus de table propre', () => {
  it('message_payloads n existe plus ; les colonnes de messages portent le contenu', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(names).not.toContain('message_payloads');
    expect(names).toEqual(expect.arrayContaining(['messages', 'share_links', 'shared_lists', 'social_groups']));
  });
});

describe('titre vide complété depuis meta_index', () => {
  const ALICE = 'ALICEPID000AAAA';
  const NOW = Date.parse('2026-05-01T10:00:00.000Z');

  function seeded(): SocialV2Store {
    const db = openUserDb(':memory:');
    db.exec("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')");
    db.exec(
      `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
       VALUES ('p1', 'a1', 'Alice', '#ff0000', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', '${ALICE}', 'Alice', 'alice', 'A7K2')`,
    );
    db.exec("INSERT INTO meta_index (type, tmdb_id, title, updated_at, etag) VALUES ('movie', 603, 'Matrix', '2026-01-01', 'e1')");
    db.exec("INSERT INTO library_items (profile_id, type, title_ref, tmdb_id, title, poster, added_at, removed) VALUES ('p1', 'movie', 'tmdb:604', 604, 'Reloaded', '/r.jpg', '2026-01-01', 0)");
    return new SocialV2Store(db);
  }

  it('sans bibliothèque ni titre fourni, le titre vient de meta_index (affiche vide)', () => {
    const store = seeded();
    const item = store.recordActivity(ALICE, 'started', { type: 'movie', tmdbId: 603 }, {}, NOW);
    expect(item?.media).toEqual({ type: 'movie', tmdbId: 603, title: 'Matrix' });
  });

  it('la bibliothèque prime sur meta_index, un titre fourni prime sur les deux, un titre inconnu reste vide', () => {
    const store = seeded();
    expect(store.recordActivity(ALICE, 'started', { type: 'movie', tmdbId: 604 }, {}, NOW)?.media).toMatchObject({ title: 'Reloaded', poster: '/r.jpg' });
    expect(store.recordActivity(ALICE, 'listed', { type: 'movie', tmdbId: 603 }, { title: 'Fourni' }, NOW)?.media.title).toBe('Fourni');
    expect(store.recordActivity(ALICE, 'started', { type: 'movie', tmdbId: 999 }, {}, NOW)?.media.title).toBe('');
  });
});

