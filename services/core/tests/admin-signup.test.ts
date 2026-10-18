/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it } from 'vitest';
import { inviteAndRegister, PASSWORD, request, startAdmin, type AdminRig } from './admin-harness.js';
import { bootstrapOwner } from './social-harness.js';
import { startApp, type RunningApp } from './lt-harness.js';

let app: RunningApp | undefined;
let rig: AdminRig | undefined;
afterEach(async () => {
  await app?.close();
  await rig?.app.close();
  app = undefined;
  rig = undefined;
});

describe('GET /user/signup-info', () => {
  it('public, minimal : serveur vide puis non vide', async () => {
    app = await startApp({});
    const empty = await request<any>(app, 'GET', '/user/signup-info');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ serverEmpty: true, inviteOnly: true, maintenance: false });
    await bootstrapOwner(app);
    expect((await request<any>(app, 'GET', '/user/signup-info')).body).toEqual({ serverEmpty: false, inviteOnly: true, maintenance: false });
  });

  it('annonce la maintenance (et répond malgré elle)', async () => {
    rig = await startAdmin();
    const on = await rig.call('PUT', '/admin/settings', { body: { maintenance: { enabled: true, message: 'x' } }, elevation: await rig.elevate() });
    expect(on.status).toBe(200);
    const info = await request<any>(rig.app, 'GET', '/user/signup-info');
    expect(info.status).toBe(200);
    expect(info.body.maintenance).toBe(true);
  });
});

describe('GET /user/me : rôle explicite', () => {
  it('owner pour le propriétaire, member sinon', async () => {
    rig = await startAdmin();
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    const owner = await request<any>(rig.app, 'GET', '/user/me', { token: rig.owner.token });
    const member = await request<any>(rig.app, 'GET', '/user/me', { token: bob.token });
    expect(owner.body.account).toMatchObject({ username: 'alice', isOwner: true, role: 'owner' });
    expect(member.body.account).toMatchObject({ username: 'bob', isOwner: false, role: 'member' });
    expect(PASSWORD).toBeDefined();
  });
});
