import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;

describe('Worker lastaddon-core (entrée src/worker.ts)', () => {
  it('/health répond', async () => {
    const res = await worker.fetch('https://core.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(env).toBeDefined();
  });
});
