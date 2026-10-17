import { describe, expect, it } from 'vitest';
import {
  PROBE_CACHE_MAX_ENTRIES,
  PROBE_TTL_MS,
  ProbeCache,
  probeCacheKey,
  probeWithCache,
} from '../src/media/probe-cache.js';
import type { MediaProbe } from '../src/media/probe.js';

const PROBE: MediaProbe = { container: 'mkv', audio: [{ lang: 'fr', codec: 'EAC3', channels: 6 }], subtitles: [] };

/** Horloge pilotable par le test. */
function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('probeCacheKey', () => {
  it('suit le format infoHash:fileIdx, avec x quand le fichier est inconnu', () => {
    expect(probeCacheKey('ABCDEF0123', 2)).toBe('abcdef0123:2');
    expect(probeCacheKey('abcdef0123')).toBe('abcdef0123:x');
  });
});

describe('ProbeCache', () => {
  it('renvoie la valeur mise en cache et undefined pour une clé absente', () => {
    const cache = new ProbeCache<MediaProbe>();

    cache.set('a:x', PROBE);

    expect(cache.get('a:x')).toEqual(PROBE);
    expect(cache.get('b:x')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it('expire les entrées après 30 jours', () => {
    const time = clock();
    const cache = new ProbeCache<MediaProbe>({ now: time.now });
    expect(PROBE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);

    cache.set('a:x', PROBE);
    time.advance(PROBE_TTL_MS - 1);
    expect(cache.get('a:x')).toEqual(PROBE);

    time.advance(1);
    expect(cache.get('a:x')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('renouvelle le TTL lors d une nouvelle écriture', () => {
    const time = clock();
    const cache = new ProbeCache<MediaProbe>({ now: time.now });

    cache.set('a:x', PROBE);
    time.advance(PROBE_TTL_MS - 10);
    cache.set('a:x', PROBE);
    time.advance(PROBE_TTL_MS - 10);

    expect(cache.get('a:x')).toEqual(PROBE);
  });

  it('évince la moins récemment utilisée au-delà de la borne', () => {
    const cache = new ProbeCache<number>({ maxEntries: 3 });

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size()).toBe(3);
  });

  it('respecte la borne par défaut de 5000 entrées', () => {
    expect(PROBE_CACHE_MAX_ENTRIES).toBe(5000);
    const cache = new ProbeCache<number>();

    for (let i = 0; i < PROBE_CACHE_MAX_ENTRIES + 10; i++) cache.set(`h${i}:x`, i);

    expect(cache.size()).toBe(PROBE_CACHE_MAX_ENTRIES);
    expect(cache.get('h0:x')).toBeUndefined();
    expect(cache.get(`h${PROBE_CACHE_MAX_ENTRIES + 9}:x`)).toBe(PROBE_CACHE_MAX_ENTRIES + 9);
  });

  it('clear vide le cache', () => {
    const cache = new ProbeCache<MediaProbe>();
    cache.set('a:x', PROBE);

    cache.clear();

    expect(cache.size()).toBe(0);
  });
});

describe('probeWithCache', () => {
  it('ne rappelle pas la sonde pour une clé déjà en cache', async () => {
    const cache = new ProbeCache<MediaProbe>();
    let calls = 0;
    const probe = async (): Promise<MediaProbe> => {
      calls++;
      return PROBE;
    };

    await probeWithCache('h:0', probe, cache);
    const second = await probeWithCache('h:0', probe, cache);

    expect(second).toEqual(PROBE);
    expect(calls).toBe(1);
  });

  it('partage un appel concurrent pour la même clé', async () => {
    const cache = new ProbeCache<MediaProbe>();
    let calls = 0;
    let release: (value: MediaProbe) => void = () => undefined;
    const probe = (): Promise<MediaProbe> => {
      calls++;
      return new Promise<MediaProbe>((resolve) => {
        release = resolve;
      });
    };

    const first = probeWithCache('h:1', probe, cache);
    const second = probeWithCache('h:1', probe, cache);
    release(PROBE);

    expect(await first).toEqual(PROBE);
    expect(await second).toEqual(PROBE);
    expect(calls).toBe(1);
  });

  it('ne met jamais en cache un résultat null et réessaie au prochain appel', async () => {
    const cache = new ProbeCache<MediaProbe>();
    let calls = 0;
    const probe = async (): Promise<MediaProbe | null> => {
      calls++;
      return calls === 1 ? null : PROBE;
    };

    expect(await probeWithCache('h:2', probe, cache)).toBeNull();
    expect(await probeWithCache('h:2', probe, cache)).toEqual(PROBE);
    expect(calls).toBe(2);
  });

  it('propage une erreur de la sonde et ne laisse pas d appel en attente', async () => {
    const cache = new ProbeCache<MediaProbe>();
    const failing = async (): Promise<MediaProbe | null> => {
      throw new Error('boom');
    };

    await expect(probeWithCache('h:3', failing, cache)).rejects.toThrow('boom');
    expect(await probeWithCache('h:3', async () => PROBE, cache)).toEqual(PROBE);
  });
});
