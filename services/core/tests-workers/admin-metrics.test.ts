/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { env, exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { STATS_MAX_PAGES, createKvCacheAdmin, createRemoteMetrics } from '../src/platform/workers/metrics.js';
import { BUCKET_MS, FLUSH_INTERVAL_MS, MetricsAccumulator, RETENTION_MS, bucketOf, type MetricsBatch } from '../src/metrics/core.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';

/**
 * Durable Object Metrics (agrégation SQLite, rétention, purge par alarme) et administration de bout en bout contre le
 * vrai Worker : requêtes publiques, session du propriétaire, /admin/metrics.
 */

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const PASSWORD = 'mot-de-passe-test-1';

const metricsStub = () => {
  const namespace = workerEnv.METRICS;
  if (namespace === undefined) throw new Error('liaison METRICS absente');
  return namespace.getByName(`metrics-test-${crypto.randomUUID()}`) as any;
};

const batchOf = (build: (acc: MetricsAccumulator) => void, now: number): MetricsBatch => {
  const acc = new MetricsAccumulator(() => now);
  build(acc);
  return acc.take();
};

describe('Durable Object Metrics', () => {
  it('additionne les lots de plusieurs instances par tranche de 5 minutes, p50/p95 sur l\'histogramme', async () => {
    const stub = metricsStub();
    const now = Date.now();
    for (let instance = 0; instance < 3; instance += 1) {
      await stub.ingest(
        batchOf((acc) => {
          for (let i = 0; i < 30; i += 1) acc.request('stream', 200, 20);
          for (let i = 0; i < 3; i += 1) acc.request('stream', 502, 1500);
          acc.upstream('addon.example', 'ok', 100);
          acc.alldebrid('unlock', null);
          acc.cache('packs', true);
        }, now),
      );
    }
    // Une tranche précédente.
    await stub.ingest(batchOf((acc) => acc.request('user', 404, 10), now - BUCKET_MS));
    const report = await stub.report('1h');
    expect(report.groups.stream.requests).toBe(99);
    expect(report.groups.stream.status).toEqual({ '2xx': 90, '3xx': 0, '4xx': 0, '5xx': 9 });
    expect(report.groups.stream.p50).toBeLessThanOrEqual(25);
    expect(report.groups.stream.p95).toBeGreaterThan(1000);
    expect(report.upstreams).toEqual([{ host: 'addon.example', calls: 3, failures: 0, timeouts: 0, avgMs: 100 }]);
    expect(report.alldebrid.unlock.ok).toBe(3);
    expect(report.caches).toEqual([{ prefix: 'packs', hits: 3, misses: 0, hitRate: 1 }]);
    const points = report.series.filter((point: any) => point.requests > 0);
    expect(points.map((point: any) => point.requests)).toEqual([1, 99]);
    expect(points[1].t).toBe(new Date(bucketOf(now)).toISOString());
  });

  it('rétention : les tranches de plus de 7 jours sont supprimées du stockage', async () => {
    const stub = metricsStub();
    const now = Date.now();
    await stub.ingest(batchOf((acc) => acc.request('stream', 200, 5), now - RETENTION_MS - 2 * BUCKET_MS));
    await stub.ingest(batchOf((acc) => acc.request('stream', 200, 5), now - RETENTION_MS + 2 * BUCKET_MS));
    await stub.ingest(batchOf((acc) => acc.request('stream', 200, 5), now));
    const report = await stub.report('7d');
    expect(report.groups.stream.requests).toBe(2);
    const stale = await runInDurableObject(stub, (_instance, state) =>
      Number(state.storage.sql.exec('SELECT COUNT(*) AS n FROM metrics WHERE bucket < ?', Date.now() - RETENTION_MS).one().n),
    );
    expect(stale).toBe(0);
  });

  it('garde les 100 dernières erreurs 5xx', async () => {
    const stub = metricsStub();
    const now = Date.now();
    for (let start = 0; start < 130; start += 26) {
      await stub.ingest(
        batchOf((acc) => {
          for (let i = start; i < start + 26; i += 1) acc.error(`/r${i}`, 500, `échec ${i}`);
        }, now),
      );
    }
    const report = await stub.report('1h');
    expect(report.errors).toHaveLength(100);
    expect(report.errors[0].message).toBe('échec 129');
    expect(report.errors[99].message).toBe('échec 30');
  });

  it('purge par préfixe : lots, asynchrone, progression consultable, autres préfixes intacts', async () => {
    const stub = metricsStub();
    const tag = crypto.randomUUID().slice(0, 8);
    for (let i = 0; i < 230; i += 1) await workerEnv.CACHE.put(`packs:${tag}:${i}`, '1');
    for (let i = 0; i < 5; i += 1) await workerEnv.CACHE.put(`hosts:${tag}:${i}`, '1');
    const first = await stub.startPurge('packs');
    expect(first).toMatchObject({ prefix: 'packs', status: 'running', deleted: 0, error: null });
    const again = await stub.startPurge('packs');
    expect(again.id).toBe(first.id);
    for (const bad of ['*', '']) {
      const outcome = await (async () => await stub.startPurge(bad))().then(() => 'ok', () => 'refusé');
      expect(outcome).toBe('refusé');
    }

    let job = await stub.purgeJob(first.id);
    const deadline = Date.now() + 20_000;
    while (job.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await stub.purgeJob(first.id);
    }
    expect(job.status).toBe('done');
    expect(job.deleted).toBeGreaterThanOrEqual(230);
    expect((await workerEnv.CACHE.list({ prefix: 'packs:' })).keys).toHaveLength(0);
    expect((await workerEnv.CACHE.list({ prefix: 'hosts:' })).keys.length).toBeGreaterThanOrEqual(5);
    expect((await stub.purgeJobs())[0].id).toBe(first.id);
    expect(await stub.purgeJob(crypto.randomUUID())).toBeUndefined();
    for (let i = 0; i < 5; i += 1) await workerEnv.CACHE.delete(`hosts:${tag}:${i}`);
  });
});

describe('envoi groupé des métriques', () => {
  it('une instance n\'appelle le Durable Object qu\'au plus toutes les 10 s', async () => {
    let now = 1_000_000;
    const batches: MetricsBatch[] = [];
    const namespace = { getByName: () => ({ ingest: (batch: MetricsBatch) => Promise.resolve(void batches.push(batch)) }) };
    const pending: Promise<unknown>[] = [];
    const service = createRemoteMetrics(namespace as never, (work) => pending.push(work), () => now);
    for (let i = 0; i < 100; i += 1) {
      service.sink.request('stream', 200, 5);
      service.flushIfDue?.();
      now += 50;
    }
    await Promise.all(pending);
    // Premier envoi immédiat (instance neuve), puis plus rien tant que 10 s ne se sont pas écoulées.
    expect(batches).toHaveLength(1);
    now += FLUSH_INTERVAL_MS;
    service.flushIfDue?.();
    await Promise.all(pending);
    expect(batches).toHaveLength(2);
    const total = batches.flatMap((batch) => batch.rows).filter((row) => row.name === 'rq|stream').reduce((sum, row) => sum + row.value, 0);
    expect(total).toBe(100);
  });

  it('un envoi en échec est conservé pour le suivant', async () => {
    let now = 5_000_000;
    let fail = true;
    const received: MetricsBatch[] = [];
    const namespace = {
      getByName: () => ({
        ingest: (batch: MetricsBatch) => (fail ? Promise.reject(new Error('DO indisponible')) : Promise.resolve(void received.push(batch))),
      }),
    };
    const pending: Promise<unknown>[] = [];
    const service = createRemoteMetrics(namespace as never, (work) => pending.push(work), () => now);
    service.sink.request('play', 200, 5);
    service.flushIfDue?.();
    await Promise.all(pending);
    fail = false;
    now += FLUSH_INTERVAL_MS;
    service.sink.request('play', 200, 5);
    service.flushIfDue?.();
    await Promise.all(pending);
    expect(received).toHaveLength(1);
    expect(received[0]?.rows.find((row) => row.name === 'rq|play')?.value).toBe(2);
  });
});

describe('statistiques KV', () => {
  it('comptage exact par préfixe', async () => {
    const namespace = workerEnv.METRICS;
    if (namespace === undefined) throw new Error('liaison METRICS absente');
    const admin = createKvCacheAdmin(workerEnv.CACHE, namespace);
    const tag = crypto.randomUUID().slice(0, 8);
    for (let i = 0; i < 7; i += 1) await workerEnv.CACHE.put(`torrents:${tag}:${i}`, '1');
    const stats = await admin.stats();
    expect(stats.map((stat) => stat.prefix)).toEqual(['issued', 'packs', 'hosts', 'torrents', 'alldebrid']);
    const torrents = stats.find((stat) => stat.prefix === 'torrents');
    expect(torrents?.exact).toBe(true);
    expect(torrents?.keys).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < 7; i += 1) await workerEnv.CACHE.delete(`torrents:${tag}:${i}`);
  });

  it('comptage borné : un très gros préfixe est signalé comme partiel', async () => {
    let calls = 0;
    const kv = {
      list: () => {
        calls += 1;
        return Promise.resolve({ keys: new Array(1000).fill({ name: 'k' }), list_complete: false, cursor: `c${calls}` });
      },
    };
    const namespace = workerEnv.METRICS;
    if (namespace === undefined) throw new Error('liaison METRICS absente');
    const stats = await createKvCacheAdmin(kv as never, namespace).stats();
    expect(stats.every((stat) => !stat.exact && stat.keys === STATS_MAX_PAGES * 1000)).toBe(true);
    expect(calls).toBe(5 * STATS_MAX_PAGES);
  });
});

/** Profil administrateur de chaque jeton propriétaire : l'administration exige X-Profile-Id. */
const adminProfiles = new Map<string, string>();
let ipCounter = 0;
async function api<T = any>(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'cf-connecting-ip': `198.51.100.${(ipCounter += 1) % 250}`, ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.token !== undefined && path.startsWith('/admin/') && adminProfiles.has(options.token) && headers['x-profile-id'] === undefined) headers['x-profile-id'] = adminProfiles.get(options.token) as string;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

describe('administration contre le vrai Worker', () => {
  it('sans session : 401 ; compte ordinaire : 403 ; propriétaire : métriques après des requêtes publiques', async () => {
    for (const path of ['/admin/me', '/admin/accounts', '/admin/metrics', '/admin/caches', '/admin/audit', '/admin/party/rooms']) {
      expect((await api('GET', path)).status, path).toBe(401);
    }
    expect((await api('POST', '/admin/elevate', { body: { password: PASSWORD } })).status).toBe(401);

    // Premier compte = propriétaire.
    expect((await api('POST', '/user/register', { body: { username: 'proprio', password: PASSWORD } })).status).toBe(201);
    const login = await api<{ token: string }>('POST', '/user/login', { body: { username: 'proprio', password: PASSWORD } });
    const token = login.body.token;
    adminProfiles.set(token, (await api<{ id: string }>('POST', '/user/profiles', { token, body: { name: 'proprio' } })).body.id);
    const code = (await api<{ invites: { code: string }[] }>('GET', '/user/invites', { token })).body.invites[0]?.code as string;
    expect((await api('POST', '/user/register', { body: { username: 'membre', password: PASSWORD, invite: code } })).status).toBe(201);
    const member = (await api<{ token: string }>('POST', '/user/login', { body: { username: 'membre', password: PASSWORD } })).body.token;
    expect((await api('GET', '/admin/metrics', { token: member })).status).toBe(403);

    for (let i = 0; i < 4; i += 1) await api('GET', '/health');
    await api('GET', '/manifest.json');
    await api('GET', '/abc/stream/movie/tt0133093.json');
    const report = await api<any>('GET', '/admin/metrics?range=1h', { token });
    expect(report.status).toBe(200);
    expect(report.body.groups.other.requests).toBeGreaterThanOrEqual(5);
    expect(report.body.groups.stream.requests).toBeGreaterThanOrEqual(1);
    expect(report.body.groups.user.requests).toBeGreaterThanOrEqual(5);
    expect(report.body.totals.p95).toEqual(expect.any(Number));
    expect(report.body.series.length).toBe(12);

    const caches = await api<any>('GET', '/admin/caches', { token });
    expect(caches.status).toBe(200);
    expect(caches.body.caches.map((c: any) => c.prefix)).toEqual(['issued', 'packs', 'hosts', 'torrents', 'alldebrid']);

    // Maintenance de bout en bout : active, puis rouverte par le propriétaire.
    const elevation = (await api<{ token: string }>('POST', '/admin/elevate', { token, body: { password: PASSWORD } })).body.token;
    expect((await api('PUT', '/admin/settings', { token, headers: { 'x-admin-elevation': elevation }, body: { maintenance: { enabled: true, message: 'Mise à jour' } } })).status).toBe(200);
    const down = await api<any>('GET', '/manifest.json');
    expect(down.status).toBe(503);
    expect(down.body.message).toBe('Mise à jour');
    expect((await api('GET', '/health')).status).toBe(200);
    expect((await api('PUT', '/admin/settings', { token, body: { maintenance: { enabled: false, message: '' } } })).status).toBe(200);
    expect((await api('GET', '/manifest.json')).status).toBe(200);
  });
});
