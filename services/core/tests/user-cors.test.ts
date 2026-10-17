import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { loginAs, PASSWORD, request } from './user-harness.js';

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
  it('origine autorisée (LASTADDON_ALLOWED_ORIGINS) : ACAO sur l origine, méthodes PUT/PATCH/DELETE, en-têtes jeton', async () => {
    vi.stubEnv('LASTADDON_ALLOWED_ORIGINS', ALLOWED);
    app = await startApp({});
    const res = await preflight(ALLOWED, 'PATCH');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Profile-Token');
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Bootstrap-Token');
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

describe('limites de débit sur /user (par IP, par catégorie)', () => {
  it('lectures : au-delà de la limite, 429 rate_limited avec Retry-After, sans contenu', async () => {
    app = await startApp({ userRateLimits: { read: 3 } });
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await request(app, 'GET', '/user/me')).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    const limited = await request(app, 'GET', '/user/me');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('écritures : compteur séparé des lectures', async () => {
    app = await startApp({ userRateLimits: { write: 1 } });
    expect((await request(app, 'POST', '/user/logout')).status).toBe(401);
    expect((await request(app, 'POST', '/user/logout')).status).toBe(429);
    expect((await request(app, 'GET', '/user/me')).status).toBe(401);
  });

  it('routes sensibles : limite serrée à part, appliquée à /register, /login et /unlock', async () => {
    app = await startApp({ userRateLimits: { sensitive: 2 } });
    await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
    const login = await request(app, 'POST', '/user/login', { body: { username: 'alice', password: 'mauvais-mot-de-passe' } });
    expect(login.status).toBe(401);
    const third = await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } });
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'rate_limited' });
    // Les lectures ne consomment pas le compteur des routes sensibles.
    expect((await request(app, 'GET', '/user/me')).status).toBe(401);
  });

  it('/login aussi par nom d utilisateur : un compte visé est bridé, les autres ne le sont pas', async () => {
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    app = await startApp({ userRateLimits: { sensitive: 100, loginPerUsername: 2 } });
    await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
    await request(app, 'POST', '/user/register', { body: { username: 'bob', password: PASSWORD } });
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).status).toBe(200);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).status).toBe(200);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).status).toBe(429);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } })).status).toBe(200);
    const token = await loginAs(app, 'bob');
    expect(token.length).toBeGreaterThan(20);
  });
});
