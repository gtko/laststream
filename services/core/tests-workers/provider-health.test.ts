/* eslint-disable @typescript-eslint/no-explicit-any -- lignes SQL et corps de tests */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MetricsAccumulator, type MetricsBatch } from '../src/metrics/core.js';
import { HEALTH_HOURS, HOUR_MS, hourOf } from '../src/metrics/providers.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';

/** Santé des fournisseurs dans le Durable Object Metrics (table provider_hourly, SQLite, runtime Workers). */

const workerEnv = env as unknown as WorkerEnv;

const metricsStub = () => {
  const namespace = workerEnv.METRICS;
  if (namespace === undefined) throw new Error('liaison METRICS absente');
  return namespace.getByName(`provider-health-${crypto.randomUUID()}`) as any;
};

const batchOf = (build: (acc: MetricsAccumulator) => void, now: number): MetricsBatch => {
  const acc = new MetricsAccumulator(() => now);
  build(acc);
  return acc.take();
};

describe('Durable Object Metrics : santé des fournisseurs par heure UTC', () => {
  it('additionne les lots par heure et par fournisseur ; dernier échec = le plus récent ; histogramme sommé', async () => {
    const stub = metricsStub();
    // Dix minutes après le début de l'heure : l'heure courante contient les deux instants.
    const now = hourOf(Date.now()) + 10 * 60_000;
    const failedAt = now - 1000;
    await stub.ingest(
      batchOf((acc) => {
        acc.outbound('tmdb', 'ok', 7);
        acc.outbound('tmdb', 'fail', 12_000);
      }, failedAt),
    );
    await stub.ingest(batchOf((acc) => acc.outbound('tmdb', 'ok', 4000), now));
    await stub.ingest(batchOf((acc) => acc.outbound('tvdb', 'ok', 30), now));
    const rows = (await stub.providerHours()) as any[];
    const tmdb = rows.find((row) => row.provider === 'tmdb');
    expect(rows.map((row) => row.provider).sort()).toEqual(['tmdb', 'tvdb']);
    expect(tmdb).toMatchObject({ hour: hourOf(now), ok: 2, fail: 1, lastFailAt: failedAt });
    expect(tmdb.latency.reduce((sum: number, count: number) => sum + count, 0)).toBe(2);
    expect(tmdb.latency).toHaveLength(12);
    expect(rows.find((row) => row.provider === 'tvdb')).toMatchObject({ ok: 1, fail: 0, lastFailAt: null });
  });

  it('rétention : heures au-delà de 8 jours retirées du stockage ; lecture bornée à la rétention', async () => {
    const stub = metricsStub();
    const now = Date.now();
    await stub.ingest(batchOf((acc) => acc.outbound('mdblist', 'ok', 20), now - (HEALTH_HOURS + 2) * HOUR_MS));
    await stub.ingest(batchOf((acc) => acc.outbound('mdblist', 'ok', 20), now));
    const rows = (await stub.providerHours()) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'mdblist', hour: hourOf(now) });
    const stale = await runInDurableObject(stub, (_instance, state) =>
      Number(state.storage.sql.exec('SELECT COUNT(*) AS n FROM provider_hourly WHERE hour < ?', hourOf(now) - (HEALTH_HOURS - 1) * HOUR_MS).one().n),
    );
    expect(stale).toBe(0);
  });
});
