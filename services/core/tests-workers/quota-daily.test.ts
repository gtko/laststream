/* eslint-disable @typescript-eslint/no-explicit-any -- stub RPC du Durable Object et lignes SQL de tests */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { workersQuotaGate } from '../src/platform/workers/metrics.js';

/** Budget quotidien global (table quota_daily du Durable Object Metrics, SQLite, runtime Workers). */

const workerEnv = env as unknown as WorkerEnv;

const metricsStub = () => {
  const namespace = workerEnv.METRICS;
  if (namespace === undefined) throw new Error('liaison METRICS absente');
  return namespace.getByName(`quota-${crypto.randomUUID()}`) as any;
};

/** Compteur lu directement dans le stockage du Durable Object (undefined : aucune ligne). */
const usedOf = (stub: any, provider: string, day: string) =>
  runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql.exec('SELECT used FROM quota_daily WHERE provider = ? AND day = ?', provider, day).toArray()[0];
    return row === undefined ? undefined : Number(row.used);
  });

describe('Durable Object Metrics : budget quotidien par fournisseur', () => {
  it('budget respecté : N appels passent, puis refus', async () => {
    const stub = metricsStub();
    expect([
      await stub.quotaTake('mdblist', '2026-10-18', 2),
      await stub.quotaTake('mdblist', '2026-10-18', 2),
      await stub.quotaTake('mdblist', '2026-10-18', 2),
    ]).toEqual([true, true, false]);
    expect(await usedOf(stub, 'mdblist', '2026-10-18')).toBe(2);
  });

  it('refus sans consommer : le compteur reste au budget', async () => {
    const stub = metricsStub();
    await stub.quotaTake('mdblist', '2026-10-18', 1);
    expect(await stub.quotaTake('mdblist', '2026-10-18', 1)).toBe(false);
    expect(await usedOf(stub, 'mdblist', '2026-10-18')).toBe(1);
    // Un budget relevé d'un cran laisse passer exactement un appel de plus.
    expect(await stub.quotaTake('mdblist', '2026-10-18', 2)).toBe(true);
    expect(await stub.quotaTake('mdblist', '2026-10-18', 2)).toBe(false);
    expect(await usedOf(stub, 'mdblist', '2026-10-18')).toBe(2);
  });

  it('budget 0 : refus, aucune ligne écrite', async () => {
    const stub = metricsStub();
    expect(await stub.quotaTake('mdblist', '2026-10-18', 0)).toBe(false);
    expect(await usedOf(stub, 'mdblist', '2026-10-18')).toBeUndefined();
  });

  it('indépendance par fournisseur : épuiser MDBList ne bloque pas TMDB', async () => {
    const stub = metricsStub();
    expect(await stub.quotaTake('mdblist', '2026-10-18', 1)).toBe(true);
    expect(await stub.quotaTake('mdblist', '2026-10-18', 1)).toBe(false);
    expect(await stub.quotaTake('tmdb', '2026-10-18', 1)).toBe(true);
    expect(await usedOf(stub, 'tmdb', '2026-10-18')).toBe(1);
  });

  it('jour UTC suivant : compteur remis à zéro, jours antérieurs purgés', async () => {
    const stub = metricsStub();
    expect(await stub.quotaTake('tmdb', '2026-10-18', 5)).toBe(true);
    expect(await stub.quotaTake('mdblist', '2026-10-18', 1)).toBe(true);
    expect(await stub.quotaTake('mdblist', '2026-10-19', 1)).toBe(true);
    expect(await usedOf(stub, 'mdblist', '2026-10-19')).toBe(1);
    expect(await usedOf(stub, 'mdblist', '2026-10-18')).toBeUndefined();
    expect(await usedOf(stub, 'tmdb', '2026-10-18')).toBeUndefined();
  });
});

describe('passerelle Workers : budget via le Durable Object global', () => {
  it('le jour UTC courant est transmis au Durable Object global', async () => {
    const namespace = workerEnv.METRICS;
    if (namespace === undefined) throw new Error('liaison METRICS absente');
    const provider = `gate-${crypto.randomUUID()}`;
    const gate = workersQuotaGate(namespace, () => Date.parse('2031-05-06T23:30:00Z'));
    expect(await gate.take(provider, 1)).toBe(true);
    expect(await gate.take(provider, 1)).toBe(false);
    const global = namespace.getByName('metrics') as any;
    expect(await usedOf(global, provider, '2031-05-06')).toBe(1);
  });
});
