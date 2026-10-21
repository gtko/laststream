import { describe, expect, it } from 'vitest';
import {
  BUCKET_MS,
  MAX_ERRORS,
  MemoryMetricsStore,
  MetricsAccumulator,
  RETENTION_MS,
  buildReport,
  hostOf,
  latencyIndex,
  routeGroup,
  routeLabel,
  sanitizeErrorMessage,
} from '../src/metrics/core.js';
import { createMemoryMetrics } from '../src/metrics/memory.js';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

describe('groupes de routes', () => {
  it.each([
    ['/abc/stream/movie/tt0133093.json', 'stream'],
    ['/abc/play/0123/1', 'play'],
    ['/abc/play/c/token', 'play'],
    ['/abc/lt/tmdb/movie/603', 'lt_tmdb'],
    ['/abc/lt/skip/tt1', 'lt'],
    ['/abc/lt/streams/status/movie/tt1', 'lt'],
    ['/user/login', 'user'],
    ['/party/abc/join', 'party'],
    ['/', 'ui'],
    ['/assets/app-123.js', 'ui'],
    ['/favicon.ico', 'ui'],
    ['/health', 'other'],
    ['/manifest.json', 'other'],
    ['/abc/manifest.json', 'other'],
    ['/config/schema', 'other'],
    ['/admin/metrics', 'other'],
  ])('%s -> %s', (path, group) => {
    expect(routeGroup(path)).toBe(group);
  });

  it('étiquette de route sans valeur variable (configuration, identifiants)', () => {
    expect(routeLabel('/Zm9vYmFyc2VjcmV0Y29uZmln/stream/movie/tt0133093.json')).toBe('/:config/stream/movie/:id');
    expect(routeLabel('/user/profiles/6f1c2c9e-1111-2222-3333-444455556666/library')).toBe('/user/profiles/:id/library');
    expect(routeLabel('/')).toBe('/');
    expect(routeLabel('/health')).toBe('/health');
  });
});

describe('épuration des messages d\'erreur', () => {
  it('retire URL, clés, IP, e-mails', () => {
    const message = 'fetch https://addon.example/AbCdEf0123456789AbCdEf0123456789/stream/movie/tt1.json?apikey=secret failed for bob@example.com from 203.0.113.9 key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const clean = sanitizeErrorMessage(message);
    expect(clean).not.toContain('addon.example');
    expect(clean).not.toContain('AbCdEf');
    expect(clean).not.toContain('apikey');
    expect(clean).not.toContain('bob@');
    expect(clean).not.toContain('203.0.113.9');
    expect(clean).not.toContain('AAAAAAAA');
    expect(clean).toContain('[url]');
  });

  it('borne la longueur', () => {
    expect(sanitizeErrorMessage('a b '.repeat(200)).length).toBeLessThanOrEqual(200);
  });

  it('hôte seul', () => {
    expect(hostOf('https://User:Pass@Addon.Example:8443/secrettoken/manifest.json?x=1')).toBe('addon.example');
    expect(hostOf('pas une url')).toBeUndefined();
  });
});

describe('histogramme et percentiles', () => {
  it('p50 et p95 d\'une distribution connue', () => {
    const acc = new MetricsAccumulator(() => T0);
    // 90 requêtes rapides (≈ 20 ms) et 10 lentes (≈ 800 ms).
    for (let i = 0; i < 90; i += 1) acc.request('stream', 200, 20);
    for (let i = 0; i < 10; i += 1) acc.request('stream', 200, 800);
    const store = new MemoryMetricsStore(() => T0);
    store.ingest(acc.take());
    const report = store.report('1h');
    const stream = report.groups.stream;
    expect(stream.requests).toBe(100);
    expect(stream.p50).toBeGreaterThanOrEqual(10);
    expect(stream.p50).toBeLessThanOrEqual(25);
    expect(stream.p95).toBeGreaterThan(500);
    expect(stream.p95).toBeLessThanOrEqual(1000);
    expect(stream.avgMs).toBe(Math.round((90 * 20 + 10 * 800) / 100));
    expect(report.totals.requests).toBe(100);
    expect(report.groups.play.p95).toBeNull();
    expect(latencyIndex(3)).toBe(0);
    expect(latencyIndex(5)).toBe(0);
    expect(latencyIndex(6)).toBe(1);
    expect(latencyIndex(60_000)).toBeGreaterThan(8);
  });
});

describe('tranches de 5 minutes', () => {
  it('agrège par tranche et par classe de statut', () => {
    let now = T0;
    const acc = new MetricsAccumulator(() => now);
    acc.request('user', 200, 10);
    acc.request('user', 404, 10);
    now = T0 + BUCKET_MS - 1;
    acc.request('user', 500, 10);
    now = T0 + BUCKET_MS;
    acc.request('user', 302, 10);
    const batch = acc.take();
    const buckets = new Set(batch.rows.map((row) => row.bucket));
    expect([...buckets].sort()).toEqual([T0, T0 + BUCKET_MS]);
    const store = new MemoryMetricsStore(() => T0 + BUCKET_MS);
    store.ingest(batch);
    const report = store.report('1h');
    expect(report.groups.user.status).toEqual({ '2xx': 1, '3xx': 1, '4xx': 1, '5xx': 1 });
    const nonEmpty = report.series.filter((point) => point.requests > 0);
    expect(nonEmpty.map((point) => [point.t, point.requests, point.errors5xx])).toEqual([
      [new Date(T0).toISOString(), 3, 1],
      [new Date(T0 + BUCKET_MS).toISOString(), 1, 0],
    ]);
    expect(report.series).toHaveLength(12);
    expect(report.stepSec).toBe(300);
  });

  it('plages 24 h (pas de 5 min) et 7 j (pas d\'une heure)', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.request('stream', 200, 5);
    const store = new MemoryMetricsStore(() => T0);
    store.ingest(acc.take());
    expect(store.report('24h').series).toHaveLength(288);
    const week = store.report('7d');
    expect(week.series).toHaveLength(168 + 1);
    expect(week.stepSec).toBe(3600);
    expect(week.series.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
  });

  it('les lots de plusieurs instances s\'additionnent', () => {
    const store = new MemoryMetricsStore(() => T0);
    for (let instance = 0; instance < 3; instance += 1) {
      const acc = new MetricsAccumulator(() => T0);
      acc.request('play', 200, 100);
      acc.cache('packs', true);
      acc.cache('packs', false);
      store.ingest(acc.take());
    }
    const report = store.report('1h');
    expect(report.groups.play.requests).toBe(3);
    expect(report.caches).toEqual([{ prefix: 'packs', hits: 3, misses: 3, hitRate: 0.5 }]);
  });

  it('la période demandée ne voit pas les tranches plus anciennes', () => {
    const store = new MemoryMetricsStore(() => T0 + 2 * 3600_000);
    const old = new MetricsAccumulator(() => T0);
    old.request('stream', 200, 5);
    store.ingest(old.take());
    expect(store.report('1h').groups.stream.requests).toBe(0);
    expect(store.report('24h').groups.stream.requests).toBe(1);
  });
});

describe('rétention de 7 jours', () => {
  it('les tranches plus vieilles que 7 jours sont supprimées à l\'ingestion', () => {
    let now = T0;
    const store = new MemoryMetricsStore(() => now);
    const old = new MetricsAccumulator(() => now);
    old.request('stream', 200, 5);
    old.error('/x', 500, 'ancienne');
    store.ingest(old.take());
    now = T0 + RETENTION_MS - BUCKET_MS;
    expect(store.report('7d').groups.stream.requests).toBe(1);
    now = T0 + RETENTION_MS + 2 * BUCKET_MS;
    const fresh = new MetricsAccumulator(() => now);
    fresh.request('play', 200, 5);
    store.ingest(fresh.take());
    const report = store.report('7d');
    expect(report.groups.stream.requests).toBe(0);
    expect(report.groups.play.requests).toBe(1);
    expect(report.errors).toHaveLength(0);
  });
});

describe('upstreams, AllDebrid, erreurs', () => {
  it('santé par hôte : appels, échecs, timeouts, latence moyenne', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.upstream('addon.example', 'ok', 100);
    acc.upstream('addon.example', 'fail', 300);
    acc.upstream('addon.example', 'timeout', 8000);
    acc.upstream('autre.example', 'ok', 50);
    acc.upstream('Mauvais Hôte|x', 'ok', 5);
    const report = buildReport(acc.take().rows, [], '1h', T0);
    expect(report.upstreams).toEqual([
      { host: 'addon.example', calls: 3, failures: 1, timeouts: 1, avgMs: Math.round(8400 / 3) },
      { host: 'autre.example', calls: 1, failures: 0, timeouts: 0, avgMs: 50 },
    ]);
  });

  it('AllDebrid : forme stable du rapport (zéro sans donnée) et lignes antérieures lues par code et par opération', () => {
    const empty = buildReport([], [], '1h', T0);
    expect(empty.alldebrid).toEqual({ unlock: { ok: 0, errors: {} }, magnet: { ok: 0, errors: {} }, other: { ok: 0, errors: {} } });
    const rows = [
      { bucket: T0, name: 'ad|unlock|ok', value: 2 },
      { bucket: T0, name: 'ad|unlock|err|LINK_HOST_NOT_SUPPORTED', value: 1 },
      { bucket: T0, name: 'ad|magnet|err|MAGNET_INVALID_URI', value: 1 },
      { bucket: T0, name: 'ad|magnet|err|not_ready', value: 1 },
    ];
    const report = buildReport(rows, [], '1h', T0);
    expect(report.alldebrid.unlock).toEqual({ ok: 2, errors: { LINK_HOST_NOT_SUPPORTED: 1 } });
    expect(report.alldebrid.magnet.errors).toEqual({ MAGNET_INVALID_URI: 1, not_ready: 1 });
  });

  it('garde les 100 dernières erreurs 5xx, les plus récentes d\'abord, sans donnée sensible', () => {
    let now = T0;
    const acc = new MetricsAccumulator(() => now);
    for (let i = 0; i < 130; i += 1) {
      now = T0 + i * 1000;
      acc.error(`/r${i}`, 500, `échec https://addon.example/${'k'.repeat(30)} numéro ${i}`);
    }
    const store = new MemoryMetricsStore(() => now);
    store.ingest(acc.take());
    const report = store.report('1h');
    expect(report.errors).toHaveLength(MAX_ERRORS);
    expect(report.errors[0]?.route).toBe('/r129');
    expect(report.errors[MAX_ERRORS - 1]?.route).toBe('/r30');
    expect(JSON.stringify(report.errors)).not.toContain('addon.example');
    expect(report.errors[0]?.message).toContain('numéro 129');
  });

  it('bornes de cardinalité : trop d\'hôtes ou de préfixes ne font pas exploser le stockage', () => {
    const acc = new MetricsAccumulator(() => T0);
    for (let i = 0; i < 500; i += 1) {
      acc.upstream(`h${i}.example`, 'ok', 1);
      acc.cache(`p${i}`, true);
    }
    const report = buildReport(acc.take().rows, [], '1h', T0);
    expect(report.upstreams.length).toBeLessThanOrEqual(200);
    expect(report.caches.length).toBeLessThanOrEqual(101);
  });

  it('un lot non envoyé est remis dans l\'accumulateur', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.request('stream', 200, 5);
    const batch = acc.take();
    expect(acc.isEmpty()).toBe(true);
    acc.request('stream', 200, 5);
    acc.restore(batch);
    const report = buildReport(acc.take().rows, [], '1h', T0);
    expect(report.groups.stream.requests).toBe(2);
  });
});

describe('service en mémoire (mode Node)', () => {
  it('rapport après quelques mesures', async () => {
    const service = createMemoryMetrics(() => T0);
    service.sink.request('user', 200, 12);
    service.sink.request('user', 503, 12);
    const report = await service.report('1h');
    expect(report.totals.requests).toBe(2);
    expect(report.totals.status['5xx']).toBe(1);
    // Une seconde lecture additionne sans doubler.
    expect((await service.report('1h')).totals.requests).toBe(2);
  });
});
