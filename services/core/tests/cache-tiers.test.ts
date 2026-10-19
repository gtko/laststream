import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CacheEvent, type CacheProvider, TtlCache } from '../src/cache/ttl-cache.js';
import { getRuntimeSeconds } from '../src/engine/cinemeta.js';
import { createLtContext } from '../src/lt/context.js';
import type { KvCache } from '../src/platform/types.js';
import type { ContentRef } from '../src/types.js';

const TTL = 60_000;
const movie: ContentRef = { type: 'movie', id: 'tt0111161', imdbId: 'tt0111161' };
const episode: ContentRef = { type: 'series', id: 'tt0903747:1:4', imdbId: 'tt0903747', season: 1, episode: 4 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** KV en mémoire qui compte les écritures. L'expiration n'est pas simulée : le cache juge lui-même la fraîcheur. */
function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    sets: 0,
    get: (key: string) => Promise.resolve(store.get(key)),
    set: (key: string, value: string) => {
      kv.sets += 1;
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
  return kv;
}

/** Instance dont le niveau 2 est ce KV (autre isolat : même store, niveau 1 neuf). */
const withKv = (kv: KvCache, onEvent?: (event: CacheEvent, provider: CacheProvider | undefined) => void): TtlCache =>
  new TtlCache(100, 1e6, { kv: () => kv, ...(onEvent === undefined ? {} : { onEvent }) });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('TtlCache : stale-while-revalidate', () => {
  it('valeur périmée servie tout de suite, rafraîchie en arrière-plan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const background: Promise<unknown>[] = [];
    const cache = new TtlCache(100, 1e6, { kv: () => undefined, background: (work) => background.push(work) });
    let loads = 0;
    const load = async (): Promise<number> => (loads += 1);

    expect(await cache.get('k', TTL, load, { swr: true })).toBe(1);
    vi.setSystemTime(Date.now() + TTL); // périmée, dans la fenêtre de service périmé
    expect(await cache.get('k', TTL, load, { swr: true })).toBe(1); // servie sans attendre le rafraîchissement

    await Promise.all(background);
    expect(loads).toBe(2);
    expect(await cache.get('k', TTL, load, { swr: true })).toBe(2);
  });

  it('un seul rafraîchissement à la fois, même si plusieurs lectures tombent pendant la fenêtre', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const background: Promise<unknown>[] = [];
    const cache = new TtlCache(100, 1e6, { kv: () => undefined, background: (work) => background.push(work) });
    let loads = 0;
    const load = async (): Promise<number> => (loads += 1);
    await cache.get('k', TTL, load, { swr: true });
    vi.setSystemTime(Date.now() + TTL);

    await cache.get('k', TTL, load, { swr: true });
    await cache.get('k', TTL, load, { swr: true });
    await Promise.all(background);
    expect(loads).toBe(2);
  });

  it('sans swr, une entrée périmée est rechargée de façon bloquante', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const cache = new TtlCache(100, 1e6, { kv: () => undefined });
    let loads = 0;
    const load = async (): Promise<number> => (loads += 1);
    await cache.get('k', TTL, load);
    vi.setSystemTime(Date.now() + TTL);
    expect(await cache.get('k', TTL, load)).toBe(2);
  });

  it('un échec du rafraîchissement garde la valeur périmée', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const background: Promise<unknown>[] = [];
    const cache = new TtlCache(100, 1e6, { kv: () => undefined, background: (work) => background.push(work) });
    await cache.get('k', TTL, async () => 'ancienne', { swr: true });
    vi.setSystemTime(Date.now() + TTL);
    const failing = async (): Promise<string> => {
      throw new Error('amont coupé');
    };
    expect(await cache.get('k', TTL, failing, { swr: true })).toBe('ancienne');
    await Promise.all(background);
    expect(await cache.get('k', TTL, failing, { swr: true })).toBe('ancienne');
  });
});

describe('TtlCache : requêtes simultanées', () => {
  it('deux appels simultanés pour une même clé = un seul appel amont', async () => {
    const events: CacheEvent[] = [];
    const cache = new TtlCache(100, 1e6, { kv: () => undefined, onEvent: (event) => events.push(event) });
    let calls = 0;
    let release: (value: number) => void = () => undefined;
    const load = (): Promise<number> => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const first = cache.get('k', TTL, load);
    const second = cache.get('k', TTL, load);
    release(7);

    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(calls).toBe(1);
    expect(events).toEqual(['miss', 'coalesced']);
  });

  it('getRuntimeSeconds : deux appels simultanés = une seule requête Cinemeta', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ meta: { runtime: '142 min' } })));
    const cache = new TtlCache();
    const options = { fetch: fetchMock as unknown as typeof fetch, cache };

    const seconds = await Promise.all([getRuntimeSeconds(movie, options), getRuntimeSeconds(movie, options)]);

    expect(seconds).toEqual([8520, 8520]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TtlCache : niveau 2 (KV)', () => {
  it('après vidage du niveau 1, la lecture vient du KV : aucun appel amont', async () => {
    const kv = memoryKv();
    const cache = withKv(kv);
    let loads = 0;
    const load = async (): Promise<{ ranking: number[] }> => {
      loads += 1;
      return { ranking: [1, 2] };
    };
    await cache.get('tmdb:/movie/1', TTL, load, { provider: 'tmdb' });
    expect(loads).toBe(1);

    cache.clearMemory();
    expect(await cache.get('tmdb:/movie/1', TTL, load, { provider: 'tmdb' })).toEqual({ ranking: [1, 2] });
    expect(loads).toBe(1);
  });

  it('un autre isolat (niveau 1 neuf, même KV) reçoit la valeur sans appel amont', async () => {
    const kv = memoryKv();
    await withKv(kv).get('cinemeta:movie:tt1', TTL, async () => 'fiche', { provider: 'cinemeta' });
    let loads = 0;
    const other = withKv(kv);
    expect(await other.get('cinemeta:movie:tt1', TTL, async () => ((loads += 1), 'autre'), { provider: 'cinemeta' })).toBe('fiche');
    expect(loads).toBe(0);
  });

  it('les Map sont restituées telles quelles depuis le niveau 2', async () => {
    const kv = memoryKv();
    const value = { runtimeSeconds: undefined, episodes: new Map([['1:4', 2640]]), seasonCounts: new Map([[1, 10]]) };
    await withKv(kv).get('cinemeta:series:tt0903747', TTL, async () => value, { provider: 'cinemeta' });

    const restored = await withKv(kv).get<typeof value>('cinemeta:series:tt0903747', TTL, async () => {
      throw new Error('ne doit pas être appelé');
    }, { provider: 'cinemeta' });
    expect(restored.episodes).toBeInstanceOf(Map);
    expect(restored.episodes.get('1:4')).toBe(2640);
    expect(restored.seasonCounts.get(1)).toBe(10);
  });

  it('getRuntimeSeconds : après vidage du niveau 1, la durée vient du KV sans requête Cinemeta', async () => {
    const kv = memoryKv();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ meta: { runtime: '45 min', videos: [{ season: 1, episode: 4, runtime: '44 min' }] } })));
    const cache = withKv(kv);
    const options = { fetch: fetchMock as unknown as typeof fetch, cache };
    expect(await getRuntimeSeconds(episode, options)).toBe(2640);

    cache.clearMemory();
    expect(await getRuntimeSeconds(episode, options)).toBe(2640);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pas de PUT si la même valeur est déjà fraîche en KV (écriture concurrente d une autre instance)', async () => {
    const kv = memoryKv();
    await withKv(kv).get('k', TTL, async () => 'v', { provider: 'tmdb' });
    expect(kv.sets).toBe(1);

    // Ce lecteur rate le KV à sa première lecture (l'autre instance n'avait pas encore écrit), puis le trouve frais.
    let loads = 0;
    expect(await withKv(racyOnce(kv)).get('k', TTL, async () => ((loads += 1), 'v'), { provider: 'tmdb' })).toBe('v');
    expect(loads).toBe(1);
    expect(kv.sets).toBe(1);
  });

  it('PUT si la valeur a changé', async () => {
    const kv = memoryKv();
    await withKv(kv).get('k', TTL, async () => 'v', { provider: 'tmdb' });
    await withKv(racyOnce(kv)).get('k', TTL, async () => 'w', { provider: 'tmdb' });
    expect(kv.sets).toBe(2);
    expect(JSON.parse(kv.store.get('k') ?? '{}').v).toBe('w');
  });

  it('PUT si l enregistrement KV est périmé, même pour une valeur identique', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const kv = memoryKv();
    await withKv(kv).get('k', TTL, async () => 'v', { provider: 'tmdb' });
    vi.setSystemTime(Date.now() + TTL); // enregistrement périmé (sans SWR, il n'est plus servi)
    await withKv(kv).get('k', TTL, async () => 'v', { provider: 'tmdb' });
    expect(kv.sets).toBe(2);
  });

  it('une erreur du KV ne casse jamais la lecture', async () => {
    const broken: KvCache = {
      get: () => Promise.reject(new Error('KV indisponible')),
      set: () => Promise.reject(new Error('KV indisponible')),
      delete: () => Promise.reject(new Error('KV indisponible')),
    };
    const cache = withKv(broken);
    expect(await cache.get('k', TTL, async () => 42, { provider: 'tmdb' })).toBe(42);
  });

  it('sans fournisseur, rien ne va dans le KV', async () => {
    const kv = memoryKv();
    await withKv(kv).get('k', TTL, async () => 'v');
    expect(kv.sets).toBe(0);
  });
});

describe('TtlCache : compteurs', () => {
  it('signale miss, l1hit, l2hit, puis stale avec le fournisseur', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const kv = memoryKv();
    const events: [CacheEvent, CacheProvider | undefined][] = [];
    const background: Promise<unknown>[] = [];
    const cache = new TtlCache(100, 1e6, {
      kv: () => kv,
      onEvent: (event, provider) => events.push([event, provider]),
      background: (work) => background.push(work),
    });
    const load = async (): Promise<string> => 'v';

    await cache.get('k', TTL, load, { provider: 'openrouter', swr: true });
    await cache.get('k', TTL, load, { provider: 'openrouter', swr: true });
    cache.clearMemory();
    await cache.get('k', TTL, load, { provider: 'openrouter', swr: true });
    vi.setSystemTime(Date.now() + TTL);
    await cache.get('k', TTL, load, { provider: 'openrouter', swr: true });
    await Promise.all(background);

    expect(events).toEqual([
      ['miss', 'openrouter'],
      ['l1hit', 'openrouter'],
      ['l2hit', 'openrouter'],
      ['stale', 'openrouter'],
      ['miss', 'openrouter'], // le rafraîchissement recharge depuis l'amont
    ]);
  });
});

describe('createLtContext : un contexte par application', () => {
  it('même application : même contexte, cache et état partagés', () => {
    const deps = { secret: 'x'.repeat(32), allowPlain: false };
    expect(createLtContext(deps)).toBe(createLtContext(deps));
    expect(createLtContext(deps).state.cache).toBe(createLtContext(deps).state.cache);
  });

  it('applications distinctes : états distincts (pas de fuite de cache entre tests)', () => {
    const first = createLtContext({ secret: 'x'.repeat(32), allowPlain: false });
    const second = createLtContext({ secret: 'x'.repeat(32), allowPlain: false });
    expect(first).not.toBe(second);
    expect(first.state.cache).not.toBe(second.state.cache);
  });
});

function racyOnce(kv: ReturnType<typeof memoryKv>): KvCache {
  let missOnce = true;
  return {
    get: (key) => {
      if (missOnce) {
        missOnce = false;
        return Promise.resolve(undefined);
      }
      return kv.get(key);
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };
}
