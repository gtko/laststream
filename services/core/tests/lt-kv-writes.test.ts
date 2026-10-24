import { afterEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { TtlCache } from '../src/cache/ttl-cache.js';
import { createLtContext } from '../src/lt/context.js';
import { seriesEpisodes } from '../src/lt/episodes.js';
import type { MetaBlob, MetaBlobStore } from '../src/lt/meta.js';
import { seasonKey } from '../src/lt/meta-policy.js';
import { mdblistRatings, tmdbGet, tvdbAiredEpisodes, tvdbSeries } from '../src/lt/providers.js';
import { platform, setPlatform } from '../src/platform/index.js';
import type { KvCache } from '../src/platform/types.js';
import { fakeLookup, type Handler, json, KEYS, mockUpstream, SECRET } from './lt-harness.js';

const TMDB = 'https://api.themoviedb.org/3';
const TVDB4 = 'https://api4.thetvdb.com/v4';
const MDB = 'https://api.mdblist.com';
const TVDB_KEY = 'v4-tvdb-test-key-0001';

/** KV en mémoire qui compte les lectures et les écritures. */
interface CountingKv extends KvCache {
  readonly store: Map<string, string>;
  gets: number;
  sets: number;
}

function countingKv(): CountingKv {
  const store = new Map<string, string>();
  const kv: CountingKv = {
    store,
    gets: 0,
    sets: 0,
    get: (key) => {
      kv.gets += 1;
      return Promise.resolve(store.get(key));
    },
    set: (key, value) => {
      kv.sets += 1;
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return kv;
}

/** Mode Workers simulé : le niveau 2 existe (KV compté, partagé par tous les espaces de noms). */
let restore: (() => void) | undefined;

function installSharedKv(): CountingKv {
  const original = platform();
  const kv = countingKv();
  setPlatform({ ...original, capabilities: { ...original.capabilities, sharedState: true }, createKvCache: () => kv });
  restore = () => setPlatform(original);
  return kv;
}

afterEach(() => {
  restore?.();
  restore = undefined;
});

interface MemoryBlobs extends MetaBlobStore {
  readonly store: Map<string, MetaBlob>;
  puts: number;
}

/** Stockage R2 en mémoire qui compte les écritures (`put`). */
function memoryBlobs(): MemoryBlobs {
  const store = new Map<string, MetaBlob>();
  const blobs: MemoryBlobs = {
    store,
    puts: 0,
    get: (key) => Promise.resolve(store.get(key)),
    put: (key, blob) => {
      blobs.puts += 1;
      store.set(key, blob);
      return Promise.resolve();
    },
  };
  return blobs;
}

/** Contexte neuf (mémoire d'isolat vide) : l'application d'un nouvel isolat, avec ou sans R2. */
function ctxWith(upstream: { fetch: typeof fetch }, extra: Partial<AppDeps> = {}) {
  return createLtContext({ secret: SECRET, allowPlain: false, fetch: upstream.fetch, lookupHost: fakeLookup(), ...extra } as unknown as AppDeps);
}

describe('TtlCache : niveau 2 désactivable (l2: false)', () => {
  it('l2: false : ni lecture ni écriture KV, même avec un fournisseur ; la mémoire sert la lecture suivante', async () => {
    const kv = countingKv();
    const cache = new TtlCache(100, 1e6, { kv: () => kv });
    expect(await cache.get('k', 60_000, async () => 'v', { provider: 'tmdb', l2: false })).toBe('v');
    expect(await cache.get('k', 60_000, async () => 'w', { provider: 'tmdb', l2: false })).toBe('v');
    expect(kv.gets).toBe(0);
    expect(kv.sets).toBe(0);
  });

  it('sans l2 : le fournisseur garde son niveau 2 (témoin du comportement inchangé)', async () => {
    const kv = countingKv();
    const cache = new TtlCache(100, 1e6, { kv: () => kv });
    await cache.get('k', 60_000, async () => 'v', { provider: 'tmdb' });
    expect(kv.sets).toBe(1);
  });
});

describe('TMDB : recherches en mémoire seule, listes en KV', () => {
  it('search/* : aucune écriture KV (une seule amont par mémoire) ; une liste reste écrite en KV', async () => {
    const kv = installSharedKv();
    const upstream = mockUpstream({
      [`${TMDB}/search/movie`]: () => json({ results: [{ id: 1 }] }),
      [`${TMDB}/trending/movie/week`]: () => json({ results: [{ id: 2 }] }),
    });
    const ctx = ctxWith(upstream);
    await tmdbGet(ctx, KEYS.tmdbToken, 'search/movie', { query: 'matrix' });
    await tmdbGet(ctx, KEYS.tmdbToken, 'search/movie', { query: 'matrix' });
    expect(kv.sets).toBe(0);
    expect(upstream.callsTo(`${TMDB}/search/movie`)).toHaveLength(1);
    await tmdbGet(ctx, KEYS.tmdbToken, 'trending/movie/week');
    expect(kv.sets).toBe(1);
  });
});

describe('MDBList : notes en mémoire, aucune écriture KV', () => {
  it('mdb : une seule amont par mémoire, zéro écriture KV', async () => {
    const kv = installSharedKv();
    const upstream = mockUpstream({
      [`${MDB}/imdb/movie/tt0133093`]: () => json({ released: '1999-03-31', ratings: [{ source: 'imdb', value: 8.7 }], score: 85 }),
    });
    const ctx = ctxWith(upstream);
    await mdblistRatings(ctx, KEYS.mdblistApiKey, 'movie', 'tt0133093');
    await mdblistRatings(ctx, KEYS.mdblistApiKey, 'movie', 'tt0133093');
    expect(upstream.callsTo(`${MDB}/imdb/movie/tt0133093`)).toHaveLength(1);
    expect(kv.sets).toBe(0);
  });
});

/** Mock TVDB v4 : connexion, fiche de série et épisodes (ordre default, français). */
function tvdbUpstream(extended: Handler = () => json({ data: { status: { name: 'Ended' }, seasons: [{ number: 1, type: { type: 'official' } }], nextAired: '', lastAired: '2020-01-08' } })) {
  return mockUpstream({
    [`${TVDB4}/login`]: () => json({ status: 'success', data: { token: 'v4-session' } }),
    [`${TVDB4}/series/81189/extended`]: extended,
    [`${TVDB4}/series/81189/episodes/default/fra`]: () =>
      json({
        status: 'success',
        data: { episodes: [{ seasonNumber: 1, number: 1, name: 'Pilote', overview: 'Résumé', aired: '2020-01-01', runtime: 25 }] },
        links: { prev: null, self: 0, next: null },
      }),
  });
}

describe('TVDB : séries et épisodes dans R2, aucune écriture KV', () => {
  it('tvdb : écrits une fois dans R2, relus ensuite sans amont ni écriture (autre isolat), zéro écriture KV', async () => {
    const kv = installSharedKv();
    const blobs = memoryBlobs();
    const upstream = tvdbUpstream();
    await tvdbSeries(ctxWith(upstream, { metaBlobs: blobs }), TVDB_KEY, '81189');
    await tvdbAiredEpisodes(ctxWith(upstream, { metaBlobs: blobs }), TVDB_KEY, '81189', 'fr');
    expect(kv.sets).toBe(0);
    expect(blobs.puts).toBe(2);
    const extendedCalls = upstream.callsTo(`${TVDB4}/series/81189/extended`).length;
    await tvdbSeries(ctxWith(upstream, { metaBlobs: blobs }), TVDB_KEY, '81189');
    await tvdbAiredEpisodes(ctxWith(upstream, { metaBlobs: blobs }), TVDB_KEY, '81189', 'fr');
    expect(upstream.callsTo(`${TVDB4}/series/81189/extended`)).toHaveLength(extendedCalls);
    expect(blobs.puts).toBe(2);
    expect(kv.sets).toBe(0);
  });

  it('tvdb : blob expiré et amont en panne : valeur périmée servie, sans réécriture', async () => {
    installSharedKv();
    const blobs = memoryBlobs();
    await tvdbSeries(ctxWith(tvdbUpstream(), { metaBlobs: blobs }), TVDB_KEY, '81189');
    for (const blob of blobs.store.values()) blob.expiresAt = 0;
    const down = tvdbUpstream(() => json({ status: 'failure' }, 500));
    const served = await tvdbSeries(ctxWith(down, { metaBlobs: blobs }), TVDB_KEY, '81189');
    expect(served.status).toBe('Ended');
    expect(blobs.puts).toBe(1);
  });
});

describe('épisodes : couche saison R2', () => {
  const TV = '1001';
  const seasonUrl = `${TMDB}/tv/${TV}/season/1`;
  const services = { tmdbToken: KEYS.tmdbToken, tvdbApiKey: undefined, tvdbPin: undefined };
  const handlers = (): Record<string, Handler> => ({
    [`${TMDB}/tv/${TV}`]: () =>
      json({
        id: 1001,
        name: 'Série',
        status: 'Ended',
        last_air_date: '2020-01-08',
        number_of_seasons: 1,
        seasons: [{ season_number: 1, name: 'Saison 1', episode_count: 2, air_date: '2020-01-01', poster_path: null }],
        external_ids: { tvdb_id: null, imdb_id: null },
        episode_groups: { results: [] },
      }),
    [seasonUrl]: () =>
      json({
        season_number: 1,
        episodes: [
          { season_number: 1, episode_number: 1, name: 'Ep 1', overview: 'Résumé', air_date: '2020-01-01', runtime: 24, still_path: null },
          { season_number: 1, episode_number: 2, name: 'Ep 2', overview: '', air_date: '2020-01-08', runtime: null, still_path: null },
        ],
      }),
  });

  it('saison fraîche servie depuis R2 : ni réécriture ni appel TMDB saison (autre isolat)', async () => {
    const blobs = memoryBlobs();
    const upstream = mockUpstream(handlers());
    const first = await seriesEpisodes(ctxWith(upstream, { metaBlobs: blobs }), services, TV, 'fr-FR');
    expect(blobs.store.has(seasonKey(TV, 1, 'fr-FR'))).toBe(true);
    expect(blobs.puts).toBe(1);
    const second = await seriesEpisodes(ctxWith(upstream, { metaBlobs: blobs }), services, TV, 'fr-FR');
    expect(second).toEqual(first);
    expect(upstream.callsTo(seasonUrl)).toHaveLength(1);
    expect(blobs.puts).toBe(1);
  });

  it('saison expirée : réécrite après un nouvel appel TMDB', async () => {
    const blobs = memoryBlobs();
    const upstream = mockUpstream(handlers());
    await seriesEpisodes(ctxWith(upstream, { metaBlobs: blobs }), services, TV, 'fr-FR');
    const blob = blobs.store.get(seasonKey(TV, 1, 'fr-FR'));
    if (blob === undefined) throw new Error('couche saison absente de R2');
    blob.expiresAt = 0;
    await seriesEpisodes(ctxWith(upstream, { metaBlobs: blobs }), services, TV, 'fr-FR');
    expect(upstream.callsTo(seasonUrl)).toHaveLength(2);
    expect(blobs.puts).toBe(2);
  });

  it('sans R2 (Node) : saisons reconstruites à chaque isolat, sans rien écrire et sans erreur', async () => {
    const upstream = mockUpstream(handlers());
    const first = await seriesEpisodes(ctxWith(upstream), services, TV, 'fr-FR');
    const second = await seriesEpisodes(ctxWith(upstream), services, TV, 'fr-FR');
    expect(first.episodes).toHaveLength(2);
    expect(second).toEqual(first);
    expect(upstream.callsTo(seasonUrl)).toHaveLength(2);
  });
});
