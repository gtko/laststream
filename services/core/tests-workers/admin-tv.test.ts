/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { env, exports as workerExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import { TV_CRON_KEY } from '../src/platform/workers/tv-store.js';

/**
 * API TV d'administration contre le vrai Worker : la liaison R2 `TV` porte la trace du dernier passage du cron
 * (écrite par refreshTvFromEnv), GET /admin/tv la restitue, POST /admin/tv/rerun relance sans toucher au réseau
 * quand un passage est déjà en cours (verrou KV présent).
 */

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const PASSWORD = 'mot-de-passe-test-1';
const LOCK_KEY = 'tv:refresh-lock';

let token = '';
let profile = '';
let ipCounter = 0;

async function api<T = any>(method: string, path: string, options: { token?: string; profile?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'cf-connecting-ip': `198.51.100.${(ipCounter += 1) % 250}` };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.profile !== undefined) headers['x-profile-id'] = options.profile;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

const bucket = () => {
  if (workerEnv.TV === undefined) throw new Error('liaison TV absente');
  return workerEnv.TV;
};

beforeAll(async () => {
  expect((await api('POST', '/user/register', { body: { username: 'proprio', password: PASSWORD } })).status).toBe(201);
  token = (await api<{ token: string }>('POST', '/user/login', { body: { username: 'proprio', password: PASSWORD } })).body.token;
  profile = (await api<{ id: string }>('POST', '/user/profiles', { token, body: { name: 'proprio' } })).body.id;
}, 60_000);

describe('administration TV contre le vrai Worker', () => {
  it('sans session : 401 sur les deux routes', async () => {
    expect((await api('GET', '/admin/tv')).status).toBe(401);
    expect((await api('POST', '/admin/tv/rerun')).status).toBe(401);
  });

  it('dernier passage : null tant que rien n\'est enregistré, puis l\'état écrit par le cron', async () => {
    await bucket().delete(TV_CRON_KEY);
    const none = await api<any>('GET', '/admin/tv', { token, profile });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ lastCron: null });

    const state = {
      v: 1, startedAt: '2026-10-18T03:00:00.000Z', finishedAt: '2026-10-18T03:04:12.000Z', durationMs: 252_000,
      ok: true, channels: 708, programmes: 15_230, epgOk: true, error: null,
    };
    await bucket().put(TV_CRON_KEY, JSON.stringify(state));
    const res = await api<any>('GET', '/admin/tv', { token, profile });
    expect(res.status).toBe(200);
    const { v: _version, ...expected } = state;
    expect(res.body).toEqual({ lastCron: expected });
  });

  it('relance : 202, et sans nouveau passage tant que le verrou d\'un passage en cours est présent', async () => {
    await workerEnv.CACHE.put(LOCK_KEY, String(Date.now()), { expirationTtl: 60 });
    try {
      const res = await api('POST', '/admin/tv/rerun', { token, profile });
      expect(res.status).toBe(202);
    } finally {
      await workerEnv.CACHE.delete(LOCK_KEY);
    }
    expect(await bucket().get(TV_CRON_KEY)).not.toBeNull();
  });
});
