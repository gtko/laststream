import { TtlCache } from '../src/cache/ttl-cache.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeSeconds, parseRuntimeSeconds } from '../src/engine/cinemeta.js';
import type { ContentRef } from '../src/types.js';

const movie: ContentRef = { type: 'movie', id: 'tt0111161', imdbId: 'tt0111161' };
const episode: ContentRef = { type: 'series', id: 'tt0903747:1:4', imdbId: 'tt0903747', season: 1, episode: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Faux fetch : le typage est forcé car seul l'usage (url, init) compte ici. */
function mockFetch(impl: () => Promise<Response>) {
  return vi.fn(impl);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRuntimeSeconds', () => {
  it('lit « 142 min », « 1h 22min », « 2h » et les minutes nues', () => {
    expect(parseRuntimeSeconds('142 min')).toBe(8520);
    expect(parseRuntimeSeconds('1h 22min')).toBe(4920);
    expect(parseRuntimeSeconds('2h')).toBe(7200);
    expect(parseRuntimeSeconds('95')).toBe(5700);
    expect(parseRuntimeSeconds(95)).toBe(5700);
  });

  it('renvoie undefined pour une durée vide, nulle ou illisible', () => {
    expect(parseRuntimeSeconds('')).toBeUndefined();
    expect(parseRuntimeSeconds('abc')).toBeUndefined();
    expect(parseRuntimeSeconds('0 min')).toBeUndefined();
    expect(parseRuntimeSeconds(undefined)).toBeUndefined();
    expect(parseRuntimeSeconds(null)).toBeUndefined();
  });
});

describe('getRuntimeSeconds', () => {
  it('lit la durée d un film sur l URL Cinemeta', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ meta: { runtime: '142 min' } }));
    const result = await getRuntimeSeconds(movie, { fetch: fetchMock as unknown as typeof fetch, cache: new TtlCache() });
    expect(result).toBe(8520);
    expect(fetchMock).toHaveBeenCalledWith('https://v3-cinemeta.strem.io/meta/movie/tt0111161.json', expect.anything());
  });

  it('utilise la durée de l épisode si fournie, sinon celle de la série', async () => {
    const body = {
      meta: {
        runtime: '50 min',
        videos: [
          { season: 1, episode: 4, runtime: '45 min' },
          { season: 1, episode: 5 },
        ],
      },
    };
    const options = { fetch: mockFetch(async () => jsonResponse(body)) as unknown as typeof fetch, cache: new TtlCache() };
    await expect(getRuntimeSeconds(episode, options)).resolves.toBe(2700);
    await expect(getRuntimeSeconds({ ...episode, episode: 5 }, options)).resolves.toBe(3000);
    await expect(getRuntimeSeconds({ ...episode, episode: 9 }, options)).resolves.toBe(3000);
  });

  it('met la réponse en cache et ne refait pas la requête', async () => {
    const cache = new TtlCache();
    const fetchMock = mockFetch(async () => jsonResponse({ meta: { runtime: '90 min' } }));
    const options = { fetch: fetchMock as unknown as typeof fetch, cache };
    await getRuntimeSeconds(movie, options);
    await getRuntimeSeconds(movie, options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('expire le cache après 24 h', async () => {
    const start = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const fetchMock = mockFetch(async () => jsonResponse({ meta: { runtime: '90 min' } }));
    const options = { fetch: fetchMock as unknown as typeof fetch, cache: new TtlCache() };

    await getRuntimeSeconds(movie, options);
    now.mockReturnValue(start + DAY_MS - 1);
    await getRuntimeSeconds(movie, options);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + DAY_MS + 1);
    await getRuntimeSeconds(movie, options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renvoie undefined sans lever d erreur (HTTP 500, réseau, JSON invalide, forme inattendue)', async () => {
    const failures: (() => Promise<Response>)[] = [
      async () => new Response('oops', { status: 500 }),
      async () => {
        throw new Error('network down');
      },
      async () => new Response('pas du json', { status: 200 }),
      async () => jsonResponse({ nothing: true }),
    ];
    for (const impl of failures) {
      const options = { fetch: mockFetch(impl) as unknown as typeof fetch, cache: new TtlCache() };
      await expect(getRuntimeSeconds(movie, options)).resolves.toBeUndefined();
    }
  });

  it('abandonne après timeoutMs même si fetch ne répond jamais', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const result = await getRuntimeSeconds(movie, {
      fetch: fetchMock as unknown as typeof fetch,
      cache: new TtlCache(),
      timeoutMs: 20,
    });
    expect(result).toBeUndefined();
  });

  it('ignore un identifiant non IMDb sans appeler le réseau', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ meta: { runtime: '90 min' } }));
    const result = await getRuntimeSeconds(
      { ...movie, imdbId: 'kitsu:1' },
      { fetch: fetchMock as unknown as typeof fetch, cache: new TtlCache() },
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
