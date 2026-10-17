import { describe, expect, it } from 'vitest';
import { hashConfigKey, LruCache, stableStringify } from '../src/cache/lru.js';

const clock = (start = 1_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

describe('LruCache : éviction LRU', () => {
  it('get et set de base, delete et clear', () => {
    const cache = new LruCache<string>({ max: 3, ttlMs: 60_000 });
    cache.set('a', 'A');
    expect(cache.get('a')).toBe('A');
    expect(cache.get('absent')).toBeUndefined();
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    cache.set('b', 'B');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('b')).toBeUndefined();
  });

  it('évince la moins récemment consultée au-delà de max', () => {
    const cache = new LruCache<number>({ max: 3, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // 'a' devient la plus récente
    cache.set('d', 4); // évince 'b'
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('réécrire une clé existante ne fait pas grandir le cache et la rend la plus récente', () => {
    const cache = new LruCache<number>({ max: 2, ttlMs: 60_000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10); // 'a' redevient la plus récente, 'b' est la plus ancienne
    cache.set('c', 3); // évince 'b'
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
  });

  it('valide max et ttlMs', () => {
    expect(() => new LruCache({ max: 0, ttlMs: 1 })).toThrow(RangeError);
    expect(() => new LruCache({ max: 1.5, ttlMs: 1 })).toThrow(RangeError);
    expect(() => new LruCache({ max: 1, ttlMs: 0 })).toThrow(RangeError);
    expect(() => new LruCache({ max: 1, ttlMs: Number.NaN })).toThrow(RangeError);
    const cache = new LruCache<number>({ max: 1, ttlMs: 1 });
    expect(() => cache.set('a', 1, 0)).toThrow(RangeError);
  });
});

describe('LruCache : expiration TTL', () => {
  it('une entrée expire à expiresAt (set + ttl) et n est plus renvoyée', () => {
    const t = clock();
    const cache = new LruCache<string>({ max: 10, ttlMs: 1_000, now: t.now });
    cache.set('a', 'A');
    t.advance(999);
    expect(cache.get('a')).toBe('A');
    t.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('un ttl propre à l entrée remplace le ttl par défaut', () => {
    const t = clock();
    const cache = new LruCache<string>({ max: 10, ttlMs: 1_000, now: t.now });
    cache.set('court', 'x', 100);
    cache.set('long', 'y', 5_000);
    t.advance(200);
    expect(cache.get('court')).toBeUndefined();
    expect(cache.get('long')).toBe('y');
  });

  it('get renouvelle la récence sans prolonger la durée de vie', () => {
    const t = clock();
    const cache = new LruCache<string>({ max: 10, ttlMs: 1_000, now: t.now });
    cache.set('a', 'A');
    t.advance(900);
    expect(cache.get('a')).toBe('A');
    t.advance(200);
    expect(cache.get('a')).toBeUndefined();
  });

  it('size ne compte pas les entrées expirées ; prune les retire et renvoie leur nombre', () => {
    const t = clock();
    const cache = new LruCache<number>({ max: 10, ttlMs: 1_000, now: t.now });
    cache.set('a', 1);
    t.advance(500);
    cache.set('b', 2);
    t.advance(600);
    expect(cache.size).toBe(1);
    t.advance(500);
    cache.set('c', 3);
    expect(cache.prune()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('au dépassement de max, les entrées expirées partent avant les vivantes', () => {
    const t = clock();
    const cache = new LruCache<number>({ max: 2, ttlMs: 1_000, now: t.now });
    cache.set('vieille', 1, 100);
    cache.set('vivante', 2, 10_000);
    t.advance(200);
    cache.set('nouvelle', 3, 10_000);
    expect(cache.get('vivante')).toBe(2);
    expect(cache.get('nouvelle')).toBe(3);
    expect(cache.get('vieille')).toBeUndefined();
  });

  it('dump renvoie les entrées vivantes de la moins récente à la plus récente, avec le temps restant', () => {
    const t = clock();
    const cache = new LruCache<string>({ max: 10, ttlMs: 1_000, now: t.now });
    cache.set('a', 'A');
    t.advance(300);
    cache.set('b', 'B');
    cache.get('a');
    t.advance(800); // 'a' et 'b' ont expiré à des instants différents
    expect(cache.dump()).toEqual([{ key: 'b', value: 'B', remainingMs: 200 }]);
  });
});

describe('stableStringify et hashConfigKey', () => {
  it('stableStringify trie les clés récursivement et suit les règles de JSON.stringify', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined }, e: undefined })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
    expect(stableStringify([undefined, () => 1, Number.NaN])).toBe('[null,null,null]');
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it('stableStringify refuse BigInt et les cycles, sans contenu dans le message', () => {
    expect(() => stableStringify({ n: 1n })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(TypeError);
  });

  it('hashConfigKey est un sha256 hexadécimal, indépendant de l ordre des clés', () => {
    const first = hashConfigKey({ debrid: { key: 'abc' }, lang: 'fr' }, 'tt1234567');
    const second = hashConfigKey({ lang: 'fr', debrid: { key: 'abc' } }, 'tt1234567');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it('hashConfigKey distingue la configuration et l identifiant', () => {
    const base = hashConfigKey({ lang: 'fr' }, 'tt1');
    expect(hashConfigKey({ lang: 'en' }, 'tt1')).not.toBe(base);
    expect(hashConfigKey({ lang: 'fr' }, 'tt2')).not.toBe(base);
  });

  it('la clé de cache ne contient jamais la clé API en clair', () => {
    const secret = 'SECRET-API-KEY-7f3a9c2e1b';
    const key = hashConfigKey({ debrid: { apiKey: secret } }, 'tt1234567');
    expect(key).not.toContain(secret);
    expect(key).not.toContain('SECRET');
    const cache = new LruCache<string>({ max: 4, ttlMs: 60_000 });
    cache.set(key, 'valeur');
    expect([...cache.dump().map((entry) => entry.key)]).toEqual([key]);
    expect(cache.dump()[0]?.key).not.toContain(secret);
  });
});
