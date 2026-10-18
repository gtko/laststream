import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, type Member } from './social-harness.js';
import { request } from './user-harness.js';

let app: RunningApp;
let alice: Member;

beforeEach(async () => {
  app = await startApp({});
  alice = await bootstrapOwner(app);
});

afterEach(async () => {
  await app.close();
});

describe('watch party sous Node', () => {
  it('toutes les routes /party répondent 501 party_unavailable (temps réel : Workers seulement)', async () => {
    for (const [method, path] of [
      ['GET', '/party'],
      ['POST', '/party'],
      ['GET', '/party/abcdefghijklmnop'],
      ['POST', '/party/abcdefghijklmnop/join'],
      ['DELETE', '/party/abcdefghijklmnop'],
    ] as const) {
      const res = await request(app, method, path, { token: alice.token, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(501);
      expect(res.body).toEqual({ error: 'party_unavailable' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('la mise à niveau WebSocket n’existe pas sous Node : 501 / 404 propre, sans plantage', async () => {
    const res = await request(app, 'GET', '/party/abcdefghijklmnop/ws', { token: alice.token });
    expect([501, 404]).toContain(res.status);
  });

  it('les autres routes sociales fonctionnent sous Node (amis, parrainage, masqués)', async () => {
    expect((await request(app, 'GET', '/user/friends', { token: alice.token })).status).toBe(200);
    expect((await request(app, 'GET', '/user/invites', { token: alice.token })).status).toBe(200);
    expect((await request(app, 'GET', `/user/profiles/${alice.profile}/hidden`, { token: alice.token })).status).toBe(200);
  });
});
