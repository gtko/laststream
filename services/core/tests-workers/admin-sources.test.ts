import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { r2UsageOf } from '../src/admin/ops-stats.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { createWorkersOpsPorts } from '../src/platform/workers/ops.js';

/** Stockage d'exploitation contre le vrai Durable Object SQLite et les buckets R2 simulés par Miniflare. */

const workerEnv = env as unknown as WorkerEnv;

describe('stockage sous Workers (Durable Object SQLite, R2)', () => {
  it('base du Durable Object : taille et lignes par table, tables internes exclues', async () => {
    const stats = await createWorkersOpsPorts(workerEnv).sqlStats?.();
    expect(stats).toBeDefined();
    expect(stats?.sizeBytes).toBeGreaterThan(0);
    const names = stats?.tables.map((table) => table.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['accounts', 'sessions', 'admin_audit']));
    expect(names.some((name) => name.startsWith('sqlite_') || name.startsWith('_cf_'))).toBe(false);
    expect(stats?.tables.every((table) => typeof table.rows === 'number')).toBe(true);
    // Premier accès au Durable Object « users » du test : migrations à froid, plus long que le délai par défaut (5 s).
  }, 60_000);

  it('R2 : bucket absent de la liaison (AVATARS) = indisponible ; bucket présent = objets comptés', async () => {
    const ports = createWorkersOpsPorts(workerEnv);
    expect(await r2UsageOf(ports.r2?.AVATARS)).toEqual({ objects: null, bytes: null, truncated: false });
    expect(await r2UsageOf(ports.r2?.TV)).toEqual({ objects: expect.any(Number), bytes: expect.any(Number), truncated: false });
  });
});
