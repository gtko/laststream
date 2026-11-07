import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import { MetaStore, type MetaIndexRow } from '../src/user/meta-store.js';
import { migrate, MIGRATIONS } from '../src/user/migrations.js';
import type { SqlDb } from '../src/user/sql.js';

function tableNames(db: SqlDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
}

function indexNames(db: SqlDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'meta_index' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );
}

const row = (overrides: Partial<MetaIndexRow> = {}): MetaIndexRow => ({
  type: 'movie',
  tmdbId: 603,
  imdbId: 'tt0133093',
  tvdbId: null,
  title: 'Matrix',
  originalTitle: 'The Matrix',
  year: 1999,
  status: 'Released',
  updatedAt: '2026-10-19T12:00:00.000Z',
  nextAirDate: null,
  etag: '"abc"',
  ...overrides,
});

describe('migration v12 : index des fiches partagées', () => {
  it('base neuve : table meta_index et index imdb_id / tvdb_id, version 12 tracée', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    expect(tableNames(db)).toContain('meta_index');
    expect(indexNames(db)).toEqual(expect.arrayContaining(['meta_index_imdb', 'meta_index_tvdb']));
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 12').get()?.version).toBe(12);
    expect(MIGRATIONS.at(-1)?.version).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));
  });

  it('base v11 existante : migration v12 appliquée, données conservées', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db, MIGRATIONS.slice(0, 11));
    expect(tableNames(db)).not.toContain('meta_index');
    db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, '2026-01-01')").run();
    migrate(db);
    expect(tableNames(db)).toContain('meta_index');
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id = 'a1'").get()?.n).toBe(1);
  });
});

describe('MetaStore : index des fiches', () => {
  const freshStore = (): MetaStore => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    return new MetaStore(db);
  };

  it('insertion puis mise à jour de la même fiche (clé : type + identifiant TMDB)', () => {
    const store = freshStore();
    store.upsert(row());
    expect(store.find('movie', 603)).toEqual(row());
    store.upsert(row({ title: 'Matrix Reloaded', etag: '"def"' }));
    expect(store.find('movie', 603)).toMatchObject({ title: 'Matrix Reloaded', etag: '"def"' });
    expect(store.find('series', 603)).toBeUndefined();
  });

  it('recherche par identifiant IMDb et TVDB', () => {
    const store = freshStore();
    store.upsert(row());
    store.upsert(row({ type: 'series', tmdbId: 1399, imdbId: 'tt0944947', tvdbId: 121361, title: 'Game of Thrones', status: 'Ended', nextAirDate: null }));
    expect(store.findByImdb('tt0944947').map((r) => r.tmdbId)).toEqual([1399]);
    expect(store.findByTvdb(121361)).toMatchObject([{ type: 'series', title: 'Game of Thrones' }]);
    expect(store.findByImdb('tt9999999')).toEqual([]);
  });
});
