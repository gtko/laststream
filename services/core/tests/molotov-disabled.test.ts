import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminRig, request, startAdmin } from './admin-harness.js';

// Molotov TV est mis de côté (LAST-184) : son code vit dans archive/molotov/ (voir archive/molotov/README.md),
// il n'est pas monté dans src/user/routes.ts. Ces routes doivent donc répondre 404 not_found, même pour un compte connecté.
describe('Molotov mis de côté (LAST-184)', () => {
  let rig: AdminRig;

  beforeAll(async () => {
    rig = await startAdmin();
  });
  afterAll(async () => {
    await rig.app.close();
  });

  it.each([
    ['GET', '/user/account/molotov'],
    ['POST', '/user/account/molotov/signin'],
    ['GET', '/user/account/molotov/channels'],
  ])('%s %s : 404 not_found pour un compte authentifié', async (method, path) => {
    const res = await request<{ error?: string }>(rig.app, method, path, {
      token: rig.owner.token,
      headers: { 'x-profile-id': rig.owner.profile },
      body: method === 'POST' ? {} : undefined,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
