import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { createLtContext, LtError, type LtContext } from '../src/lt/context.js';
import { mdblistCached } from '../src/lt/mdblist.js';
import { mdblistRatings } from '../src/lt/providers.js';
import { MDBLIST_DAILY_BUDGET_DEFAULT, memoryQuotaGate, msUntilNextUtcDay, parseDailyBudget, type QuotaGate, utcDay } from '../src/lt/quota.js';
import { workersQuotaGate } from '../src/platform/workers/metrics.js';
import type { KvCache } from '../src/platform/types.js';
import { fakeLookup, json, mockUpstream, type MockUpstream, SECRET } from './lt-harness.js';

const MDB = 'https://api.mdblist.com';
const T1 = `${MDB}/imdb/movie/tt0133093`;
const T2 = `${MDB}/imdb/movie/tt0000002`;
const T3 = `${MDB}/imdb/movie/tt0000003`;
const ok = () => json({ ratings: [{ source: 'imdb', value: 8.7 }], score: 80, released: '1999-03-31' });

/** KV mémoire neuf : chaque test part d'un cache persistant vide. */
function memoryKv(): KvCache {
  const data = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(data.get(key)),
    set: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
  };
}

/** Contexte lt avec un fetch simulé, un KV (partageable entre instances) et un budget ou un garde injectés. */
function ctxFor(upstream: MockUpstream, options: { quota?: QuotaGate; budget?: number; kv?: KvCache } = {}): LtContext {
  const deps = {
    secret: SECRET,
    allowPlain: false,
    fetch: upstream.fetch,
    lookupHost: fakeLookup(),
    ...(options.quota === undefined ? {} : { mdblistQuota: options.quota }),
    ...(options.budget === undefined ? {} : { mdblistDailyBudget: options.budget }),
  } as unknown as AppDeps;
  const ctx = createLtContext(deps);
  ctx.state.mdbKv = options.kv ?? memoryKv();
  return ctx;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('quota MDBList : analyse et calendrier', () => {
  it('budget : entier positif ou zéro, sinon défaut (800)', () => {
    expect(MDBLIST_DAILY_BUDGET_DEFAULT).toBe(800);
    expect(parseDailyBudget(undefined)).toBe(800);
    expect(parseDailyBudget('')).toBe(800);
    expect(parseDailyBudget('abc')).toBe(800);
    expect(parseDailyBudget('-5')).toBe(800);
    expect(parseDailyBudget('12.5')).toBe(800);
    expect(parseDailyBudget('0')).toBe(0);
    expect(parseDailyBudget('1000')).toBe(1000);
    expect(parseDailyBudget(' 250 ')).toBe(250);
  });

  it('jour UTC au format AAAA-MM-JJ, bascule à minuit UTC', () => {
    expect(utcDay(Date.parse('2026-10-18T23:59:59Z'))).toBe('2026-10-18');
    expect(utcDay(Date.parse('2026-10-19T00:00:00Z'))).toBe('2026-10-19');
  });

  it('durée restante jusqu\'à minuit UTC', () => {
    expect(msUntilNextUtcDay(Date.parse('2026-10-18T23:59:59.500Z'))).toBe(500);
    expect(msUntilNextUtcDay(Date.parse('2026-10-18T00:00:00Z'))).toBe(86_400_000);
  });

  it('contexte : budget par défaut 800, lu depuis MDBLIST_DAILY_BUDGET sinon', () => {
    vi.stubEnv('MDBLIST_DAILY_BUDGET', '');
    expect(createLtContext({ secret: SECRET, allowPlain: false, fetch: undefined } as unknown as AppDeps).mdbDailyBudget).toBe(800);
    vi.stubEnv('MDBLIST_DAILY_BUDGET', '42');
    expect(createLtContext({ secret: SECRET, allowPlain: false, fetch: undefined } as unknown as AppDeps).mdbDailyBudget).toBe(42);
  });
});

describe('quota : compteur mémoire', () => {
  it('par fournisseur : N passent, puis refus sans consommer', async () => {
    const gate = memoryQuotaGate(() => Date.parse('2026-10-18T10:00:00Z'));
    expect([await gate.take('mdblist', 2), await gate.take('mdblist', 2), await gate.take('mdblist', 2)]).toEqual([true, true, false]);
    expect(await gate.take('tmdb', 1)).toBe(true);
    // Le refus n'a rien consommé : un budget de 3 laisse passer le troisième appel.
    expect(await gate.take('mdblist', 3)).toBe(true);
    expect(await gate.take('mdblist', 3)).toBe(false);
  });

  it('budget 0 : toujours refusé', async () => {
    const gate = memoryQuotaGate(() => Date.parse('2026-10-18T10:00:00Z'));
    expect(await gate.take('mdblist', 0)).toBe(false);
  });

  it('jour UTC suivant : compteur remis à zéro', async () => {
    let clock = Date.parse('2026-10-18T23:00:00Z');
    const gate = memoryQuotaGate(() => clock);
    expect(await gate.take('mdblist', 1)).toBe(true);
    expect(await gate.take('mdblist', 1)).toBe(false);
    clock = Date.parse('2026-10-19T00:00:01Z');
    expect(await gate.take('mdblist', 1)).toBe(true);
  });
});

describe('quota : passerelle Workers', () => {
  it('passe le jour UTC courant au Durable Object', async () => {
    const calls: unknown[][] = [];
    const recording = {
      getByName: () => ({
        quotaTake: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(true);
        },
      }),
    };
    const gate = workersQuotaGate(recording as never, () => Date.parse('2026-10-18T23:30:00Z'));
    expect(await gate.take('mdblist', 800)).toBe(true);
    expect(calls).toEqual([['mdblist', '2026-10-18', 800]]);
  });

  it('erreur du Durable Object : refus (échec fermé), jamais un appel non compté', async () => {
    const broken = { getByName: () => ({ quotaTake: () => Promise.reject(new Error('indisponible')) }) };
    expect(await workersQuotaGate(broken as never, () => 0).take('mdblist', 5)).toBe(false);
  });
});

describe('quota MDBList : budget quotidien global', () => {
  it('budget N : les appels amont passent, les hits de cache non, puis refus sans fetch', async () => {
    const upstream = mockUpstream({ [T1]: ok, [T2]: ok, [T3]: ok });
    const ctx = ctxFor(upstream, { budget: 2 });
    expect((await mdblistCached(ctx, 'k', 'movie', 'tt0133093')).ratings.imdb).toBe(8.7);
    // Deuxième lecture du même titre : cache mémoire, aucun budget consommé.
    expect((await mdblistCached(ctx, 'k', 'movie', 'tt0133093')).ratings.imdb).toBe(8.7);
    expect((await mdblistCached(ctx, 'k', 'movie', 'tt0000002')).ratings.imdb).toBe(8.7);
    const refused = await mdblistCached(ctx, 'k', 'movie', 'tt0000003');
    expect(refused).toMatchObject({ unavailable: true, score: null });
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(upstream.callsTo(T1).length).toBe(1);
    expect(upstream.callsTo(T2).length).toBe(1);
    expect(upstream.callsTo(T3).length).toBe(0);
  });

  it('budget 0 : aucun appel amont, réponse dégradée', async () => {
    const upstream = mockUpstream({ [T1]: ok });
    const res = await mdblistCached(ctxFor(upstream, { budget: 0 }), 'k', 'movie', 'tt0133093');
    expect(res).toMatchObject({ unavailable: true, score: null });
    expect(upstream.callsTo(T1).length).toBe(0);
  });

  it('hit de cache persistant : servi sans budget, même instance épuisée', async () => {
    const upstream = mockUpstream({ [T1]: ok, [T2]: ok });
    const kv = memoryKv();
    await mdblistCached(ctxFor(upstream, { budget: 1, kv }), 'k', 'movie', 'tt0133093');
    // Nouvelle instance, budget épuisé : T1 vient du KV, T2 est refusé.
    const cached = await mdblistCached(ctxFor(upstream, { budget: 0, kv }), 'k', 'movie', 'tt0133093');
    expect(cached.unavailable).toBeUndefined();
    expect(cached.ratings.imdb).toBe(8.7);
    expect((await mdblistCached(ctxFor(upstream, { budget: 0, kv }), 'k', 'movie', 'tt0000002')).unavailable).toBe(true);
    expect(upstream.callsTo(T1).length).toBe(1);
    expect(upstream.callsTo(T2).length).toBe(0);
  });

  it('nouveau jour UTC : le budget repart à zéro', async () => {
    let clock = Date.parse('2026-10-18T22:00:00Z');
    const quota = memoryQuotaGate(() => clock);
    const upstream = mockUpstream({ [T1]: ok, [T2]: ok });
    const kv = memoryKv();
    expect((await mdblistCached(ctxFor(upstream, { quota, budget: 1, kv }), 'k', 'movie', 'tt0133093')).unavailable).toBeUndefined();
    expect((await mdblistCached(ctxFor(upstream, { quota, budget: 1, kv }), 'k', 'movie', 'tt0000002')).unavailable).toBe(true);
    clock = Date.parse('2026-10-19T00:00:01Z');
    expect((await mdblistCached(ctxFor(upstream, { quota, budget: 1, kv }), 'k', 'movie', 'tt0000002')).ratings.imdb).toBe(8.7);
    expect(upstream.callsTo(T2).length).toBe(1);
  });

  it('budget lu dans MDBLIST_DAILY_BUDGET quand les dépendances ne le fixent pas', async () => {
    vi.stubEnv('MDBLIST_DAILY_BUDGET', '1');
    const upstream = mockUpstream({ [T1]: ok, [T2]: ok });
    const ctx = ctxFor(upstream);
    expect(ctx.mdbDailyBudget).toBe(1);
    expect((await mdblistCached(ctx, 'k', 'movie', 'tt0133093')).ratings.imdb).toBe(8.7);
    expect((await mdblistCached(ctx, 'k', 'movie', 'tt0000002')).unavailable).toBe(true);
    expect(upstream.callsTo(T2).length).toBe(0);
  });
});

describe('quota MDBList : notes des fiches (mdblistRatings) soumises à la même garde', () => {
  it('budget 0 : refus levé en LtError, aucun appel amont', async () => {
    const upstream = mockUpstream({ [T1]: ok });
    await expect(mdblistRatings(ctxFor(upstream, { budget: 0 }), 'k', 'movie', 'tt0133093', true)).rejects.toBeInstanceOf(LtError);
    expect(upstream.callsTo(T1)).toHaveLength(0);
  });

  it('disjoncteur ouvert : refus levé en LtError, aucun appel amont, même avec du budget', async () => {
    const upstream = mockUpstream({ [T1]: ok });
    const ctx = ctxFor(upstream, { budget: 10 });
    ctx.state.mdbBreakerUntil = Date.now() + 60e3;
    await expect(mdblistRatings(ctx, 'k', 'movie', 'tt0133093', true)).rejects.toBeInstanceOf(LtError);
    expect(upstream.callsTo(T1)).toHaveLength(0);
  });

  it('budget consommé par une fiche : la fiche suivante est refusée sans appel', async () => {
    const upstream = mockUpstream({ [T1]: ok, [T2]: ok });
    const ctx = ctxFor(upstream, { budget: 1 });
    expect((await mdblistRatings(ctx, 'k', 'movie', 'tt0133093', true)).ratings.imdb).toBe(8.7);
    await expect(mdblistRatings(ctx, 'k', 'movie', 'tt0000002', true)).rejects.toBeInstanceOf(LtError);
    expect(upstream.callsTo(T2)).toHaveLength(0);
  });

  it('test de clé (sans garde) : disjoncteur ouvert ou budget à 0, l appel amont est émis', async () => {
    const upstream = mockUpstream({ [T1]: ok });
    const ctx = ctxFor(upstream, { budget: 0 });
    ctx.state.mdbBreakerUntil = Date.now() + 60e3;
    expect((await mdblistRatings(ctx, 'k', 'movie', 'tt0133093')).ratings.imdb).toBe(8.7);
    expect(upstream.callsTo(T1)).toHaveLength(1);
  });

  it('test de clé (sans garde) : 429 transmis, disjoncteur non ouvert, budget inchangé', async () => {
    const upstream = mockUpstream({ [T1]: () => new Response('quota', { status: 429, headers: { 'retry-after': '86400' } }) });
    const quota = memoryQuotaGate();
    const ctx = ctxFor(upstream, { quota, budget: 5 });

    await expect(mdblistRatings(ctx, 'k', 'movie', 'tt0133093')).rejects.toBeInstanceOf(LtError);

    expect(upstream.callsTo(T1)).toHaveLength(1);
    expect(ctx.state.mdbBreakerUntil).toBe(0);
    // Budget intact : les 5 prises du jour restent disponibles.
    for (let i = 0; i < 5; i += 1) expect(await ctx.mdbQuota.take('mdblist', 5)).toBe(true);
  });
});
