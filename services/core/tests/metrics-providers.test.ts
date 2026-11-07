import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/deps.js';
import { setCacheListener, TtlCache } from '../src/cache/ttl-cache.js';
import { recordCacheEvent, recordMetaEvent, recordProviderEvent, metricsService } from '../src/metrics/index.js';
import { MemoryMetricsStore, MetricsAccumulator } from '../src/metrics/core.js';
import {
  buildProviderReport,
  DAY_MS,
  dayOf,
  type ProviderCounts,
  type ProviderEvent,
  type ProviderName,
  type ProviderReport,
  type ProviderRow,
} from '../src/metrics/providers.js';
import { createLtContext } from '../src/lt/context.js';
import { mdblistFetch } from '../src/lt/providers.js';
import { request, startAdmin } from './admin-harness.js';
import { fakeLookup, json, SECRET } from './harness-core.js';

/** 18 octobre 2026, midi UTC : jour D = minuit UTC du même jour. */
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const D = dayOf(T0);
const iso = (day: number): string => new Date(day).toISOString().slice(0, 10);

const ZERO: ProviderCounts = {
  calls: 0,
  l1Hits: 0,
  l2Hits: 0,
  stale: 0,
  coalesced: 0,
  r2Hits: 0,
  r2Misses: 0,
  notModified: 0,
  hitRate: null,
  r2HitRate: null,
};

/** Totaux 30 jours d'un fournisseur, lus dans le service de mesure de la plateforme de test. */
async function totalsOf(provider: ProviderName): Promise<ProviderCounts> {
  const service = metricsService();
  if (service === undefined) throw new Error('métriques absentes');
  const report = await service.report('1h');
  return report.providers.totals.find((entry) => entry.provider === provider) ?? ZERO;
}

describe('compteurs par fournisseur : agrégation par jour UTC', () => {
  it('minuit UTC ouvre un nouveau jour : 23 h 59 et 00 h 00 ne se mélangent pas', () => {
    let now = Date.UTC(2026, 9, 18, 23, 59, 59);
    const acc = new MetricsAccumulator(() => now);
    acc.provider('tmdb', 'call');
    now = Date.UTC(2026, 9, 19, 0, 0, 0);
    acc.provider('tmdb', 'call');
    acc.provider('tmdb', 'l1hit');
    const rows = acc.take().providers ?? [];
    expect(rows.map((row) => [iso(row.day), row.provider, row.event, row.value]).sort()).toEqual([
      ['2026-10-18', 'tmdb', 'call', 1],
      ['2026-10-19', 'tmdb', 'call', 1],
      ['2026-10-19', 'tmdb', 'l1hit', 1],
    ]);
  });

  it('un nom de fournisseur ou un événement hors liste ne laisse aucune trace', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.provider('inconnu' as ProviderName, 'call');
    acc.provider('tmdb', 'inconnu' as ProviderEvent);
    expect(acc.isEmpty()).toBe(true);
  });

  it('un lot non envoyé est remis avec ses compteurs, additionnés à ceux du suivant', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.provider('tvdb', 'call');
    const failed = acc.take();
    expect(acc.isEmpty()).toBe(true);
    acc.provider('tvdb', 'call');
    acc.restore(failed);
    expect(acc.take().providers).toEqual([{ day: D, provider: 'tvdb', event: 'call', value: 2 }]);
  });
});

describe('rapport des compteurs par fournisseur', () => {
  it('taux de hit, blocs par jour, fenêtre de 30 jours, totaux', () => {
    const rows: ProviderRow[] = [
      { day: D, provider: 'tmdb', event: 'l1hit', value: 3 },
      { day: D, provider: 'tmdb', event: 'l2hit', value: 1 },
      { day: D, provider: 'tmdb', event: 'stale', value: 1 },
      { day: D, provider: 'tmdb', event: 'coalesced', value: 1 },
      { day: D, provider: 'tmdb', event: 'call', value: 4 },
      { day: D - DAY_MS, provider: 'tmdb', event: 'call', value: 2 },
      { day: D - 29 * DAY_MS, provider: 'tmdb', event: 'call', value: 1 },
      { day: D - 30 * DAY_MS, provider: 'tmdb', event: 'call', value: 100 },
      { day: D + DAY_MS, provider: 'cinemeta', event: 'call', value: 50 },
      { day: D, provider: 'cinemeta', event: 'r2hit', value: 2 },
      { day: D, provider: 'cinemeta', event: 'r2miss', value: 2 },
      { day: D, provider: 'cinemeta', event: '304', value: 1 },
    ];
    const report = buildProviderReport(rows, T0);
    expect(report.windowDays).toBe(30);
    expect(report.from).toBe(iso(D - 29 * DAY_MS));
    expect(report.to).toBe(iso(D));
    expect(report.byDay.map((block) => block.day)).toEqual([iso(D - 29 * DAY_MS), iso(D - DAY_MS), iso(D)]);
    expect(report.byDay.at(-1)).toEqual({
      day: iso(D),
      providers: [
        { provider: 'tmdb', calls: 4, l1Hits: 3, l2Hits: 1, stale: 1, coalesced: 1, r2Hits: 0, r2Misses: 0, notModified: 0, hitRate: 0.6, r2HitRate: null },
        { provider: 'cinemeta', calls: 0, l1Hits: 0, l2Hits: 0, stale: 0, coalesced: 0, r2Hits: 2, r2Misses: 2, notModified: 1, hitRate: null, r2HitRate: 0.5 },
      ],
    });
    // Totaux : tmdb a 4 + 2 + 1 appels ; 6 lectures servies sur 13 lectures.
    expect(report.totals.map((entry) => entry.provider)).toEqual(['tmdb', 'cinemeta']);
    expect(report.totals[0]).toMatchObject({ calls: 7, hitRate: 0.462 });
    expect(report.totals[1]).toMatchObject({ calls: 0, r2Hits: 2, r2Misses: 2, notModified: 1, r2HitRate: 0.5 });
  });

  it('sans compteur : rapport vide sur la fenêtre', () => {
    const report = buildProviderReport([], T0);
    expect(report).toMatchObject({ windowDays: 30, byDay: [], totals: [] });
  });
});

describe('stockage en mémoire : rétention de 30 jours, indépendante de la période', () => {
  it('les jours hors fenêtre sont retirés ; la période demandée ne change rien', () => {
    let now = T0;
    const store = new MemoryMetricsStore(() => now);
    const acc = new MetricsAccumulator(() => now);
    acc.provider('mdblist', 'call');
    store.ingest(acc.take());
    store.ingest({ rows: [], errors: [], providers: [{ day: D - 31 * DAY_MS, provider: 'mdblist', event: 'call', value: 9 }] });
    expect(store.report('1h').providers.totals).toEqual([expect.objectContaining({ provider: 'mdblist', calls: 1 })]);
    expect(store.report('7d').providers.totals[0]?.calls).toBe(1);
    now = T0 + 29 * DAY_MS;
    expect(store.report('24h').providers.totals[0]?.calls).toBe(1);
    now = T0 + 30 * DAY_MS;
    expect(store.report('1h').providers.totals).toEqual([]);
  });
});

describe('points de mesure sur la plateforme Node', () => {
  beforeAll(() => setCacheListener(recordCacheEvent));
  afterAll(() => setCacheListener(undefined));

  it('cache à deux niveaux : appel sortant, hit mémoire, requête jointe à un appel en vol', async () => {
    const before = await totalsOf('cinemeta');
    const cache = new TtlCache(100, 1e6, { kv: () => undefined });
    const load = () => Promise.resolve('valeur');
    await cache.get('a', 60e3, load, { provider: 'cinemeta' });
    await cache.get('a', 60e3, load, { provider: 'cinemeta' });
    await Promise.all([cache.get('b', 60e3, load, { provider: 'cinemeta' }), cache.get('b', 60e3, load, { provider: 'cinemeta' })]);
    const after = await totalsOf('cinemeta');
    expect(after.calls - before.calls).toBe(2);
    expect(after.l1Hits - before.l1Hits).toBe(1);
    expect(after.coalesced - before.coalesced).toBe(1);
  });

  it('entrée de cache sans fournisseur : aucun compteur par fournisseur', async () => {
    const service = metricsService();
    if (service === undefined) throw new Error('métriques absentes');
    const sumCalls = async (): Promise<number> => (await service.report('1h')).providers.totals.reduce((sum, entry) => sum + entry.calls, 0);
    const before = await sumCalls();
    const cache = new TtlCache(100, 1e6, { kv: () => undefined });
    await cache.get('seul', 60e3, () => Promise.resolve(1));
    await cache.get('seul', 60e3, () => Promise.resolve(1));
    expect((await sumCalls()) - before).toBe(0);
  });

  it('MDBList : chaque appel sortant est compté', async () => {
    const before = await totalsOf('mdblist');
    const ctx = createLtContext({
      secret: SECRET,
      fetch: () => Promise.resolve(json({ ratings: [{ source: 'imdb', value: 8.7 }], score: 80 })),
      lookupHost: fakeLookup(),
      allowPlain: false,
    } as unknown as AppDeps);
    await mdblistFetch(ctx, 'cle-de-test-mdblist', 'movie', 'tt0133093');
    expect((await totalsOf('mdblist')).calls - before.calls).toBe(1);
  });

  it('fiches R2 et 304 : compteurs par fournisseur', async () => {
    const before = await totalsOf('tvdb');
    recordMetaEvent('r2hit', 'tvdb');
    recordMetaEvent('r2hit', 'tvdb');
    recordMetaEvent('r2miss', 'tvdb');
    recordMetaEvent('304', 'tvdb');
    recordProviderEvent('tvdb', 'call');
    const after = await totalsOf('tvdb');
    expect(after.r2Hits - before.r2Hits).toBe(2);
    expect(after.r2Misses - before.r2Misses).toBe(1);
    expect(after.notModified - before.notModified).toBe(1);
    expect(after.calls - before.calls).toBe(1);
  });
});

describe('/admin sous Node : compteurs par fournisseur', () => {
  it('propriétaire : providers dans /admin/metrics ; sans session : 401', async () => {
    const rig = await startAdmin();
    try {
      recordProviderEvent('openrouter', 'call');
      const res = await rig.call<{ providers: ProviderReport }>('GET', '/admin/metrics?range=1h');
      expect(res.status).toBe(200);
      expect(res.body.providers.windowDays).toBe(30);
      expect(res.body.providers.totals.find((entry) => entry.provider === 'openrouter')?.calls).toBeGreaterThanOrEqual(1);
      expect(res.body.providers.byDay.length).toBeGreaterThanOrEqual(1);
      expect((await request(rig.app, 'GET', '/admin/metrics')).status).toBe(401);
    } finally {
      await rig.app.close();
    }
  });
});
