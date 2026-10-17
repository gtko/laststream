import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { request } from './user-harness.js';

const ALLOWED = 'https://ui.example.test';
const FOREIGN = 'https://evil.example';

let app: RunningApp | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

async function preflight(origin: string, method: string, path = '/user/profiles/x/library/movie/603') {
  return fetch(`${app?.baseUrl}${path}`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' },
  });
}

describe('CORS sur /user', () => {
  it('origine autorisée (LASTADDON_ALLOWED_ORIGINS) : ACAO sur l origine, méthodes PUT/PATCH/DELETE, en-tête X-Profile-Token', async () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', ALLOWED);
    app = await startApp({});
    const res = await preflight(ALLOWED, 'PATCH');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Profile-Token');
  });

  it('origine étrangère : aucun ACAO, ni * ni écho', async () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', ALLOWED);
    app = await startApp({});
    const res = await request(app, 'GET', '/user/me', { headers: { origin: FOREIGN } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await preflight(FOREIGN, 'PUT');
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('jamais de ACAO * sur les routes utilisateur, même pour une origine quelconque', async () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', ALLOWED);
    app = await startApp({});
    const res = await request(app, 'POST', '/user/login', { headers: { origin: FOREIGN }, body: { username: 'x', password: 'y' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('limite de débit sur /user', () => {
  it('au-delà de la limite par minute : 429 rate_limited avec Retry-After, sans contenu', async () => {
    app = await startApp({ userRateLimit: 3 });
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await request(app, 'GET', '/user/me')).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    const limited = await request(app, 'GET', '/user/me');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
