import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { checkDependencies, HEALTH_TIMEOUT_MS, healthReport } from '../src/health/probes.js';

/** Sonde qui ne répond jamais (dépendance bloquée). */
const never = (): Promise<never> => new Promise<never>(() => {});

describe('sondes de dépendances de /health', () => {
  it('délai d’attente par défaut de 1 500 ms', () => {
    expect(HEALTH_TIMEOUT_MS).toBe(1500);
  });

  it('toutes les dépendances répondent : ok global, un état et une durée par dépendance', async () => {
    const report = await healthReport('0.1.0', {
      kv: async () => null,
      r2: async () => undefined,
      base: async () => true,
    });
    expect(report).toEqual({
      ok: true,
      release: '0.1.0',
      deps: {
        kv: { ok: true, ms: expect.any(Number) },
        r2: { ok: true, ms: expect.any(Number) },
        base: { ok: true, ms: expect.any(Number) },
      },
    });
  });

  it('une dépendance en panne : ok global à false, les autres restent OK, aucun message d’erreur renvoyé', async () => {
    const report = await healthReport('0.1.0', {
      kv: async () => null,
      r2: async () => {
        throw new Error('R2 injoignable https://exemple.test/bucket?token=SECRET-123');
      },
      base: async () => true,
    });
    expect(report.ok).toBe(false);
    expect(report.deps.r2.ok).toBe(false);
    expect(report.deps.kv.ok).toBe(true);
    expect(report.deps.base.ok).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET-123');
    expect(serialized).not.toContain('exemple.test');
  });

  it('une sonde qui lève sans attendre (erreur synchrone) : en panne, sans exception', async () => {
    const deps = await checkDependencies({
      base: () => {
        throw new TypeError('base absente');
      },
    });
    expect(deps.base.ok).toBe(false);
  });

  it('une dépendance qui dépasse le délai : en panne, rendue au bout du délai, sans bloquer les autres', async () => {
    const started = Date.now();
    const deps = await checkDependencies({ base: never, kv: async () => null }, 30);
    expect(deps.base.ok).toBe(false);
    expect(deps.base.ms).toBeGreaterThanOrEqual(25);
    expect(deps.kv.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('les sondes tournent en parallèle : durée bornée par un seul délai, pas par leur somme', async () => {
    const started = Date.now();
    const deps = await checkDependencies({ a: never, b: never, c: never }, 100);
    expect(Object.values(deps).every((dep) => dep.ok === false)).toBe(true);
    // Séquentiel : 3 × 100 ms ; parallèle : environ 100 ms.
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('sans sonde : ok, aucune dépendance', async () => {
    expect(await healthReport('0.1.0', {})).toEqual({ ok: true, release: '0.1.0', deps: {} });
  });
});

describe('route /health avec sondes', () => {
  const deps = { secret: 'health-route-secret-with-32-chars-min', allowPlain: false };

  it('une dépendance en panne : HTTP 200, ok global à false, état par dépendance', async () => {
    const app = createApp({
      ...deps,
      healthProbes: {
        kv: async () => null,
        r2: async () => {
          throw new Error('panne');
        },
      },
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      release: '0.1.0',
      deps: {
        kv: { ok: true, ms: expect.any(Number) },
        r2: { ok: false, ms: expect.any(Number) },
      },
    });
  });

  it('dépendance qui dépasse le délai : la réponse arrive quand même, HTTP 200', async () => {
    const app = createApp({ ...deps, healthProbes: { base: never } });
    const started = Date.now();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deps: { base: { ok: boolean } } };
    expect(body.ok).toBe(false);
    expect(body.deps.base.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(HEALTH_TIMEOUT_MS + 1000);
  });
});
