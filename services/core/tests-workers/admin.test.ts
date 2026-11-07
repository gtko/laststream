import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/platform/workers/env.js';

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const ADMIN = { 'x-admin-secret': String(workerEnv.ADMIN_SECRET), 'content-type': 'application/json' };

const post = (body: unknown, headers: Record<string, string> = ADMIN) =>
  worker.fetch('https://core.test/__admin/import', { method: 'POST', headers, body: JSON.stringify(body) });

describe('route /__admin/ de migration', () => {
  it('refuse sans secret ou avec un mauvais secret', async () => {
    expect((await worker.fetch('https://core.test/__admin/counts')).status).toBe(401);
    expect((await worker.fetch('https://core.test/__admin/counts', { headers: { 'x-admin-secret': 'x'.repeat(40) } })).status).toBe(401);
  });

  it('importe, compte, refuse une base non vide sauf force', async () => {
    expect((await post({ action: 'begin', force: true })).status).toBe(200);
    const account = ['id1', 'greg', 'hash', 1, '2026-01-01T00:00:00.000Z'];
    const columns = ['id', 'username', 'password_hash', 'is_owner', 'created_at'];
    expect((await post({ action: 'insert', table: 'accounts', columns, rows: [account] })).status).toBe(200);
    const counts = (await (await worker.fetch('https://core.test/__admin/counts', { headers: ADMIN })).json()) as {
      tables: Record<string, { count: number; sha256: string }>;
    };
    expect(counts.tables.accounts?.count).toBe(1);
    expect(counts.tables.accounts?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await post({ action: 'begin', force: false })).status).toBe(409);
    expect((await post({ action: 'begin', force: true })).status).toBe(200);
    const after = (await (await worker.fetch('https://core.test/__admin/counts', { headers: ADMIN })).json()) as typeof counts;
    expect(after.tables.accounts?.count).toBe(0);
  });

  it('refuse une table ou une colonne inconnue', async () => {
    expect((await post({ action: 'insert', table: 'sqlite_master', columns: ['a'], rows: [[1]] })).status).toBe(404);
    expect((await post({ action: 'insert', table: 'accounts', columns: ['nope'], rows: [[1]] })).status).toBe(500);
  });
});
