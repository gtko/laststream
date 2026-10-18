import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { createLtContext, type LtContext } from '../src/lt/context.js';
import { mdblistCached, ratingsTtlSeconds } from '../src/lt/mdblist.js';
import { mdblistRetryDelayMs } from '../src/lt/providers.js';
import type { KvCache } from '../src/platform/types.js';
import { fakeLookup, fullToken, json, mockUpstream, type MockUpstream, SECRET, startApp, type RunningApp } from './lt-harness.js';

const MDB = 'https://api.mdblist.com';
const MATRIX = `${MDB}/imdb/movie/tt0133093`;
const OTHER = `${MDB}/imdb/movie/tt0000002`;

const body = (released: string | null) =>
  json({ ratings: [{ source: 'imdb', value: 8.7 }], score: 80, ...(released === null ? {} : { released }) });

/** KV mémoire qui garde la durée de vie demandée à chaque écriture. */
function recordingKv(): KvCache & { ttl: Map<string, number | undefined> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number | undefined>();
  return {
    ttl,
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value, seconds) => {
      data.set(key, value);
      ttl.set(key, seconds);
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

function context(upstream: MockUpstream, kv?: KvCache, limiter?: () => Promise<boolean>): LtContext {
  const deps = { secret: SECRET, fetch: upstream.fetch, lookupHost: fakeLookup(), allowPlain: false, mdblistLimiter: limiter } as unknown as AppDeps;
  const ctx = createLtContext(deps);
  if (kv !== undefined) ctx.state.mdbKv = kv;
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MDBList : cache persistant des notes', () => {
  it('durée : 7 jours, 24 h pour un titre sorti depuis moins de 30 jours (ou à venir)', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(ratingsTtlSeconds('1999-03-31', now)).toBe(7 * 86400);
    expect(ratingsTtlSeconds(null, now)).toBe(7 * 86400);
    expect(ratingsTtlSeconds('2026-10-01', now)).toBe(86400);
    expect(ratingsTtlSeconds('2027-01-01', now)).toBe(86400);
    expect(ratingsTtlSeconds('2026-09-19', now)).toBe(86400);
    expect(ratingsTtlSeconds('2026-09-17', now)).toBe(7 * 86400);
  });

  it('une instance neuve relit le KV : une seule requête amont, durée de 7 jours écrite', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => body('1999-03-31') });
    const kv = recordingKv();
    const first = await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093');
    const second = await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093');
    expect(second).toEqual(first);
    expect(first.ratings.imdb).toBe(8.7);
    expect(first.unavailable).toBeUndefined();
    expect(upstream.callsTo(MATRIX).length).toBe(1);
    expect(kv.ttl.get('r:imdb:movie:tt0133093')).toBe(7 * 86400);
  });

  it('titre récent : 24 h', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => body('2026-10-10') });
    const kv = recordingKv();
    await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093');
    expect(kv.ttl.get('r:imdb:movie:tt0133093')).toBe(86400);
  });

  it('requêtes simultanées pour un même titre : un seul appel amont', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => body(null) });
    const ctx = context(upstream, recordingKv());
    const results = await Promise.all(Array.from({ length: 8 }, () => mdblistCached(ctx, 'k', 'movie', 'tt0133093')));
    expect(upstream.callsTo(MATRIX).length).toBe(1);
    expect(new Set(results.map((r) => r.ratings.imdb))).toEqual(new Set([8.7]));
  });

  it('échec amont : mémorisé 2 min (une seule requête), mais pas une clé refusée (401)', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => new Response('boom', { status: 500 }), [OTHER]: () => json({}, 401) });
    const kv = recordingKv();
    await expect(mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093')).rejects.toMatchObject({ code: 'upstream_500' });
    await expect(mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093')).rejects.toMatchObject({ code: 'upstream_500' });
    expect(upstream.callsTo(MATRIX).length).toBe(1);
    expect(kv.ttl.get('n:imdb:movie:tt0133093')).toBe(120);
    await expect(mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0000002')).rejects.toMatchObject({ code: 'upstream_401' });
    await expect(mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0000002')).rejects.toMatchObject({ code: 'upstream_401' });
    expect(upstream.callsTo(OTHER).length).toBe(2);
  });
});

describe('MDBList : disjoncteur 429 et limite de débit', () => {
  it('429 avec Retry-After : réponse dégradée, plus aucun appel amont avant la remise à zéro, puis reprise', async () => {
    let quota = true;
    const upstream = mockUpstream({
      [MATRIX]: () => (quota ? new Response('limit', { status: 429, headers: { 'retry-after': '600' } }) : body(null)),
      [OTHER]: () => body(null),
    });
    const kv = recordingKv();
    const ctx = context(upstream, kv);
    const first = await mdblistCached(ctx, 'k', 'movie', 'tt0133093');
    expect(first).toMatchObject({ unavailable: true, retryAfter: 600, score: null });
    expect(first.ratings.imdb).toBeNull();
    expect(kv.ttl.get('breaker')).toBe(600);
    // Un autre titre, depuis une autre instance (KV partagé) : coupé aussi, aucun appel.
    const other = await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0000002');
    expect(other.unavailable).toBe(true);
    expect(upstream.callsTo(OTHER).length).toBe(0);
    expect(upstream.callsTo(MATRIX).length).toBe(1);
    // 11 min plus tard : le disjoncteur est retombé (le KV réel expire seul, simulé ici), nouvel essai.
    vi.setSystemTime(new Date('2026-10-18T12:11:00Z'));
    await kv.delete('breaker');
    quota = false;
    const later = await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093');
    expect(later.ratings.imdb).toBe(8.7);
    expect(later.unavailable).toBeUndefined();
  });

  it('429 sans en-tête : coupure d\'une heure', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => json({ error: 'quota' }, 429) });
    const kv = recordingKv();
    const res = await mdblistCached(context(upstream, kv), 'k', 'movie', 'tt0133093');
    expect(res.unavailable).toBe(true);
    expect(res.retryAfter).toBe(3600);
    expect(kv.ttl.get('breaker')).toBe(3600);
  });

  it('limite de débit globale atteinte : réponse dégradée sans appel amont', async () => {
    const upstream = mockUpstream({ [MATRIX]: () => body(null) });
    const res = await mdblistCached(context(upstream, recordingKv(), () => Promise.resolve(false)), 'k', 'movie', 'tt0133093');
    expect(res.unavailable).toBe(true);
    expect(upstream.callsTo(MATRIX).length).toBe(0);
  });

  it('en-têtes de remise à zéro : secondes, epoch ou date', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(mdblistRetryDelayMs(new Headers({ 'retry-after': '90' }), now)).toBe(90_000);
    expect(mdblistRetryDelayMs(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 300) }), now)).toBe(300_000);
    expect(mdblistRetryDelayMs(new Headers({ 'retry-after': 'Sun, 18 Oct 2026 12:05:00 GMT' }), now)).toBe(300_000);
    expect(mdblistRetryDelayMs(new Headers(), now)).toBeUndefined();
  });
});

describe('GET /lt/mdblist : route', () => {
  let app: RunningApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('quota épuisé : 200 « indisponible temporairement » (pas un 502), non mis en cache par le navigateur', async () => {
    vi.useRealTimers();
    const upstream = mockUpstream({ [MATRIX]: () => json({ error: 'limit' }, 429) });
    app = await startApp({ fetch: upstream.fetch, lookupHost: fakeLookup() });
    const res = await fetch(`${app.baseUrl}/${fullToken()}/lt/mdblist/movie/tt0133093`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ unavailable: true, retryAfter: 3600, score: null });
    const again = await fetch(`${app.baseUrl}/${fullToken()}/lt/mdblist/movie/tt0000002`);
    expect(again.status).toBe(200);
    expect(upstream.callsTo(MATRIX).length).toBe(1);
  });
});
