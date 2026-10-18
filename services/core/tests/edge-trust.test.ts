import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { PASSWORD, request } from './user-harness.js';

const EDGE_SECRET = 'secret-de-test-du-relais-0123456789';

let app: RunningApp | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

const login = (app: RunningApp, headers: Record<string, string> = {}, username = 'alice') =>
  request(app, 'POST', '/user/login', { body: { username, password: 'mauvais-mot-de-passe' }, headers });

describe('limitation des tentatives de connexion par IP (15 minutes)', () => {
  it('au-delà de la limite, /login et /register répondent 429 même si la limite par minute est large', async () => {
    app = await startApp({ userRateLimits: { sensitive: 1000, loginPerUsername: 1000, authPerIp: 3 } });
    await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
    expect((await login(app)).status).toBe(401);
    expect((await login(app)).status).toBe(401);
    const blocked = await login(app, {}, 'bob');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await request(app, 'POST', '/user/register', { body: { username: 'carl', password: PASSWORD } })).status).toBe(429);
  });
});

describe('relais de confiance (LASTADDON_EDGE_SECRET)', () => {
  it('secret valide : la limite se mesure par IP cliente transmise', async () => {
    vi.stubEnv('LASTADDON_EDGE_SECRET', EDGE_SECRET);
    app = await startApp({ userRateLimits: { sensitive: 1000, loginPerUsername: 1000, authPerIp: 1 } });
    const edge = (ip: string) => ({ 'x-laststream-edge': EDGE_SECRET, 'x-laststream-client-ip': ip });
    expect((await login(app, edge('203.0.113.7'))).status).toBe(401);
    expect((await login(app, edge('203.0.113.7'))).status).toBe(429);
    expect((await login(app, edge('203.0.113.8'))).status).toBe(401);
  });

  it('secret absent ou faux : l en-tête d IP cliente est ignoré (impossible de contourner la limite)', async () => {
    vi.stubEnv('LASTADDON_EDGE_SECRET', EDGE_SECRET);
    app = await startApp({ userRateLimits: { sensitive: 1000, loginPerUsername: 1000, authPerIp: 1 } });
    expect((await login(app, { 'x-laststream-client-ip': '203.0.113.1' })).status).toBe(401);
    expect((await login(app, { 'x-laststream-client-ip': '203.0.113.2' })).status).toBe(429);
    expect((await login(app, { 'x-laststream-edge': 'faux', 'x-laststream-client-ip': '203.0.113.3' })).status).toBe(429);
  });

  it('sans LASTADDON_EDGE_SECRET configuré : aucun en-tête n est cru', async () => {
    vi.stubEnv('LASTADDON_EDGE_SECRET', '');
    app = await startApp({ userRateLimits: { sensitive: 1000, loginPerUsername: 1000, authPerIp: 1 } });
    const headers = { 'x-laststream-edge': '', 'x-laststream-client-ip': '203.0.113.9' };
    expect((await login(app, headers)).status).toBe(401);
    expect((await login(app, { ...headers, 'x-laststream-client-ip': '203.0.113.10' })).status).toBe(429);
  });

  it('IP cliente invalide : ignorée, le pair réel reste la clé', async () => {
    vi.stubEnv('LASTADDON_EDGE_SECRET', EDGE_SECRET);
    app = await startApp({ userRateLimits: { sensitive: 1000, loginPerUsername: 1000, authPerIp: 1 } });
    const edge = (ip: string) => ({ 'x-laststream-edge': EDGE_SECRET, 'x-laststream-client-ip': ip });
    expect((await login(app, edge('pas-une-ip'))).status).toBe(401);
    expect((await login(app, edge('autre-chose'))).status).toBe(429);
  });
});
