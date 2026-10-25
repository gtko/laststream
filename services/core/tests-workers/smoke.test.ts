import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;

describe('Worker lastaddon-core (entrée src/worker.ts)', () => {
  it('/health répond', async () => {
    const res = await worker.fetch('https://core.test/health');
    expect(res.status).toBe(200);
    // KV, R2 (TV) et base du Durable Object répondent dans Miniflare : toutes OK.
    expect(await res.json()).toEqual({
      ok: true,
      release: '0.1.0',
      deps: {
        kv: { ok: true, ms: expect.any(Number) },
        r2: { ok: true, ms: expect.any(Number) },
        base: { ok: true, ms: expect.any(Number) },
      },
    });
    expect(env).toBeDefined();
  });
});

describe('limite de connexion (binding Rate Limiting)', () => {
  it('10 tentatives par IP puis 429 avec Retry-After', async () => {
    const attempt = () =>
      worker.fetch('https://core.test/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
        body: JSON.stringify({ username: `inconnu${Math.random().toString(36).slice(2, 8)}`, password: 'mauvais-mot-de-passe' }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[11]).toBe(429);
  });
});
