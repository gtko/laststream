import { describe, expect, it } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { createR2MetaAdmin } from '../src/platform/workers/meta-blobs.js';

/** Purge d'une fiche partagée (DELETE /admin/meta/:type/:id) : seuls les objets du préfixe fichePrefix sont supprimés. */

/** Bucket R2 simulé : listage par préfixe, pages de `limit` clés avec curseur, suppression par lots. */
class FakeBucket {
  readonly keys = new Set<string>();
  readonly deleteCalls: string[][] = [];

  add(...keys: string[]): void {
    for (const key of keys) this.keys.add(key);
  }

  /** Curseur fondé sur la dernière clé lue (comme R2) : supprimer entre deux pages ne décale pas la suite. */
  list(options: { prefix?: string; limit?: number; cursor?: string }): Promise<unknown> {
    const limit = options.limit ?? 1000;
    const after = options.cursor ?? '';
    const remaining = [...this.keys]
      .filter((key) => key.startsWith(options.prefix ?? '') && key > after)
      .sort();
    const page = remaining.slice(0, limit);
    const objects = page.map((key) => ({ key }));
    if (remaining.length > limit) {
      return Promise.resolve({ objects, delimitedPrefixes: [], truncated: true, cursor: page[page.length - 1] });
    }
    return Promise.resolve({ objects, delimitedPrefixes: [], truncated: false });
  }

  delete(keys: string[]): Promise<void> {
    this.deleteCalls.push([...keys]);
    for (const key of keys) this.keys.delete(key);
    return Promise.resolve();
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

const FICHE_MOVIE_123 = ['meta/v2/movie/123/base.json', 'meta/v2/movie/123/l10n/fr-FR.json', 'meta/v2/movie/123/l10n/en-US.json', 'meta/v2/movie/123/ratings.json'];
/** Objets voisins : identifiants qui commencent par 123 ou par 12, autre type, ancienne clé v1 : jamais supprimés. */
const NEIGHBOURS = [
  'meta/v2/movie/1234/base.json',
  'meta/v2/movie/1230/ratings.json',
  'meta/v2/movie/12/base.json',
  'meta/v2/tv/123/base.json',
  'meta/v2/tv/123/s1/fr-FR.json',
  'meta/movie/123.json',
  'rows/lastaddon-trending.json',
];

describe('purge d une fiche partagée (préfixe exact)', () => {
  it('supprime exactement les objets de la fiche, et rien d autre', async () => {
    const bucket = new FakeBucket();
    bucket.add(...FICHE_MOVIE_123, ...NEIGHBOURS);

    const deleted = await createR2MetaAdmin(bucket.asBucket()).deleteFiche('movie', 123);

    expect(deleted).toBe(FICHE_MOVIE_123.length);
    expect([...bucket.keys].sort()).toEqual([...NEIGHBOURS].sort());
  });

  it('une série : supprime ses saisons (préfixe meta/v2/tv/<id>/) sans toucher aux films de même numéro', async () => {
    const bucket = new FakeBucket();
    bucket.add('meta/v2/tv/1399/base.json', 'meta/v2/tv/1399/s1/fr-FR.json', 'meta/v2/tv/1399/s2/en-US.json', 'meta/v2/movie/1399/base.json');

    const deleted = await createR2MetaAdmin(bucket.asBucket()).deleteFiche('tv', 1399);

    expect(deleted).toBe(3);
    expect([...bucket.keys]).toEqual(['meta/v2/movie/1399/base.json']);
  });

  it('fiche absente : rien supprimé, pas d appel de suppression', async () => {
    const bucket = new FakeBucket();
    bucket.add(...NEIGHBOURS);

    const deleted = await createR2MetaAdmin(bucket.asBucket()).deleteFiche('movie', 123);

    expect(deleted).toBe(0);
    expect(bucket.deleteCalls).toHaveLength(0);
    expect(bucket.keys.size).toBe(NEIGHBOURS.length);
  });

  it('parcourt tous les listages paginés et supprime par lots', async () => {
    const bucket = new FakeBucket();
    const many = Array.from({ length: 2500 }, (_, i) => `meta/v2/movie/123/s${i}/fr-FR.json`);
    bucket.add(...many, 'meta/v2/movie/1234/base.json');

    const deleted = await createR2MetaAdmin(bucket.asBucket()).deleteFiche('movie', 123);

    expect(deleted).toBe(2500);
    expect([...bucket.keys]).toEqual(['meta/v2/movie/1234/base.json']);
    expect(bucket.deleteCalls.every((batch) => batch.length <= 1000)).toBe(true);
  });
});
