/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKidProfile, inviteAndRegister, PASSWORD, request, startAdmin, type AdminRig } from './admin-harness.js';

describe('/admin : réglages globaux', () => {
  let rig: AdminRig;
  beforeEach(async () => {
    rig = await startAdmin();
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('valeurs par défaut puis mise à jour partielle', async () => {
    const initial = await rig.call<any>('GET', '/admin/settings');
    expect(initial.body).toEqual({ inviteDefaultQuota: 4, invitesOpen: true, maintenance: { enabled: false, message: '' } });
    const updated = await rig.call<any>('PUT', '/admin/settings', { body: { inviteDefaultQuota: 2 } });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ inviteDefaultQuota: 2, invitesOpen: true, maintenance: { enabled: false, message: '' } });
    expect((await rig.call<any>('GET', '/admin/settings')).body.inviteDefaultQuota).toBe(2);
  });

  it('refuse les corps invalides', async () => {
    expect((await rig.call('PUT', '/admin/settings', { body: {} })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/settings', { body: { inviteDefaultQuota: -1 } })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/settings', { body: { inviteDefaultQuota: 1000 } })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/settings', { body: { invitesOpen: 'oui' } })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/settings', { body: { inconnu: true } })).status).toBe(400);
    expect((await rig.call('PUT', '/admin/settings', { body: { maintenance: { enabled: true, message: 'x'.repeat(501) } } })).status).toBe(400);
  });

  it('quota par défaut : appliqué aux nouveaux comptes seulement', async () => {
    const before = await inviteAndRegister(rig.app, rig.owner, 'avant');
    await rig.call('PUT', '/admin/settings', { body: { inviteDefaultQuota: 1 } });
    const after = await inviteAndRegister(rig.app, rig.owner, 'apres');
    expect((await request<{ quota: number }>(rig.app, 'GET', '/user/invites', { token: before.token })).body.quota).toBe(4);
    expect((await request<{ quota: number }>(rig.app, 'GET', '/user/invites', { token: after.token })).body.quota).toBe(1);
  });

  it('inscriptions par invitation fermées : refusées, rouvertes ensuite', async () => {
    const invites = await request<{ invites: { code: string }[] }>(rig.app, 'GET', '/user/invites', { token: rig.owner.token });
    const code = invites.body.invites[0]?.code as string;
    await rig.call('PUT', '/admin/settings', { body: { invitesOpen: false } });
    const closed = await request<{ error: string }>(rig.app, 'POST', '/user/register', { body: { username: 'zoe', password: PASSWORD, invite: code } });
    expect(closed.status).toBe(403);
    expect(closed.body.error).toBe('invites_closed');
    // Le lien n'est pas consommé.
    await rig.call('PUT', '/admin/settings', { body: { invitesOpen: true } });
    expect((await request(rig.app, 'POST', '/user/register', { body: { username: 'zoe', password: PASSWORD, invite: code } })).status).toBe(201);
  });
});

describe('/admin : mode maintenance', () => {
  let rig: AdminRig;
  beforeEach(async () => {
    rig = await startAdmin();
  });
  afterEach(async () => {
    await rig.app.close();
  });

  const enable = async (message = 'Retour dans dix minutes <b>promis</b>') =>
    await rig.call<any>('PUT', '/admin/settings', { body: { maintenance: { enabled: true, message } }, elevation: await rig.elevate() });

  it('activation : élévation exigée', async () => {
    const res = await rig.call<{ error: string }>('PUT', '/admin/settings', { body: { maintenance: { enabled: true, message: 'm' } } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('elevation_required');
    expect((await request(rig.app, 'GET', '/health')).status).toBe(200);
    expect((await request(rig.app, 'GET', '/manifest.json')).status).toBe(200);
  });

  it('tout répond 503 JSON avec le message, sauf /admin, /health et la connexion du propriétaire', async () => {
    const member = await inviteAndRegister(rig.app, rig.owner, 'bob');
    expect((await enable()).status).toBe(200);

    const manifest = await request<{ error: string; message: string }>(rig.app, 'GET', '/manifest.json');
    expect(manifest.status).toBe(503);
    expect(manifest.body.error).toBe('maintenance');
    expect(manifest.body.message).toContain('dix minutes');
    expect(manifest.headers.get('retry-after')).toBe('300');
    expect(manifest.headers.get('content-type')).toContain('application/json');

    for (const [method, path] of [
      ['GET', '/user/me'],
      ['GET', '/party'],
      ['GET', '/config/schema'],
      ['GET', '/abc/stream/movie/tt0133093.json'],
      ['GET', '/abc/lt/tmdb/movie/603'],
      ['GET', '/abc/play/0123456789abcdef0123456789abcdef01234567'],
    ] as const) {
      expect((await request(rig.app, method, path, { token: member.token })).status, `${method} ${path}`).toBe(503);
    }

    // Exceptions : /health, /admin (propriétaire), connexion du propriétaire.
    expect((await request(rig.app, 'GET', '/health')).status).toBe(200);
    expect((await rig.call('GET', '/admin/settings')).status).toBe(200);
    const ownerLogin = await request<{ token: string }>(rig.app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } });
    expect(ownerLogin.status).toBe(200);
    expect((await request(rig.app, 'GET', '/admin/me', { token: ownerLogin.body.token, headers: { 'x-profile-id': rig.owner.profile } })).status).toBe(200);
    // /admin reste protégé en maintenance.
    expect((await request(rig.app, 'GET', '/admin/settings', { token: member.token })).status).toBe(403);
    expect((await request(rig.app, 'GET', '/admin/settings')).status).toBe(401);
  });

  it('connexion d\'un non-propriétaire refusée en maintenance (503), sans ouvrir de session', async () => {
    await inviteAndRegister(rig.app, rig.owner, 'bob');
    await enable();
    const login = await request<{ error: string }>(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } });
    expect(login.status).toBe(503);
    expect(login.body.error).toBe('maintenance');
    const wrong = await request(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: 'faux-mot-de-passe' } });
    expect(wrong.status).toBe(401);
  });

  it('navigateur : page HTML 503 avec message échappé', async () => {
    await enable();
    const res = await fetch(`${rig.app.baseUrl}/`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Maintenance');
    expect(html).toContain('&lt;b&gt;promis&lt;/b&gt;');
    expect(html).not.toContain('<b>promis</b>');
  });

  it('préflight CORS toujours accepté', async () => {
    await enable();
    const res = await fetch(`${rig.app.baseUrl}/user/me`, { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-method': 'GET' } });
    expect(res.status).toBe(204);
  });

  it('désactivation : le service reprend (sans élévation)', async () => {
    await enable();
    expect((await request(rig.app, 'GET', '/manifest.json')).status).toBe(503);
    const off = await rig.call<any>('PUT', '/admin/settings', { body: { maintenance: { enabled: false, message: '' } } });
    expect(off.status).toBe(200);
    expect(off.body.maintenance.enabled).toBe(false);
    expect((await request(rig.app, 'GET', '/manifest.json')).status).toBe(200);
  });

  it('le profil enfant du propriétaire ne peut pas modifier la maintenance', async () => {
    const kid = await addKidProfile(rig.app, rig.owner);
    const res = await rig.call('PUT', '/admin/settings', { headers: { 'x-profile-id': kid }, body: { maintenance: { enabled: true, message: 'x' } }, elevation: await rig.elevate() });
    expect(res.status).toBe(403);
    expect((await request(rig.app, 'GET', '/manifest.json')).status).toBe(200);
  });
});
