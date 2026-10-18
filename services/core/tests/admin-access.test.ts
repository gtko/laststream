/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signElevation } from '../src/admin/elevation.js';
import { hashSessionToken } from '../src/user/crypto.js';
import { SECRET } from './harness-core.js';
import { addKidProfile, inviteAndRegister, type Member, PASSWORD, request, startAdmin, type AdminRig } from './admin-harness.js';

const ROUTES: [string, string][] = [
  ['GET', '/admin/me'],
  ['GET', '/admin/accounts'],
  ['GET', '/admin/referrals'],
  ['GET', '/admin/settings'],
  ['GET', '/admin/metrics'],
  ['GET', '/admin/caches'],
  ['GET', '/admin/audit'],
  ['GET', '/admin/party/rooms'],
  ['GET', '/admin/party/reports'],
  ['GET', '/admin/tv'],
];

describe('/admin : contrôle d\'accès', () => {
  let rig: AdminRig;
  let member: Member;
  let kidProfile: string;

  beforeAll(async () => {
    rig = await startAdmin();
    member = await inviteAndRegister(rig.app, rig.owner, 'bob');
    kidProfile = await addKidProfile(rig.app, rig.owner);
  });
  afterAll(async () => {
    await rig.app.close();
  });

  it('sans session : 401 sur chaque route', async () => {
    for (const [method, path] of ROUTES) {
      expect((await request(rig.app, method, path)).status, `${method} ${path}`).toBe(401);
    }
    expect((await request(rig.app, 'POST', '/admin/elevate', { body: { password: PASSWORD } })).status).toBe(401);
    expect((await request(rig.app, 'DELETE', `/admin/accounts/${crypto.randomUUID()}`)).status).toBe(401);
  });

  it('jeton de session invalide : 401', async () => {
    const res = await request(rig.app, 'GET', '/admin/accounts', { token: 'x'.repeat(43) });
    expect(res.status).toBe(401);
  });

  it('compte non propriétaire : 403 owner_only partout', async () => {
    for (const [method, path] of ROUTES) {
      const res = await request<{ error: string }>(rig.app, method, path, { token: member.token });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toBe('owner_only');
    }
    const elevate = await request<{ error: string }>(rig.app, 'POST', '/admin/elevate', { token: member.token, body: { password: PASSWORD } });
    expect(elevate.status).toBe(403);
  });

  it('propriétaire : accès accordé', async () => {
    for (const [method, path] of ROUTES) {
      const res = await rig.call(method, path);
      // 501 : fonction non branchée dans ce harnais (caches Workers, TV) ; jamais 401/403.
      expect([200, 501], `${method} ${path}`).toContain(res.status);
    }
    const me = await rig.call<{ account: { username: string } }>('GET', '/admin/me');
    expect(me.body.account.username).toBe('alice');
  });

  it('profil enfant du propriétaire : 403 kid_profile', async () => {
    const res = await rig.call<{ error: string }>('GET', '/admin/accounts', { headers: { 'x-profile-id': kidProfile } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
    const write = await rig.call('PUT', `/admin/settings`, { headers: { 'x-profile-id': kidProfile }, body: { invitesOpen: false } });
    expect(write.status).toBe(403);
    expect((await rig.call('GET', '/admin/settings')).body.invitesOpen).toBe(true);
  });

  it('profil adulte du propriétaire accepté ; profil d\'un autre compte refusé', async () => {
    expect((await rig.call('GET', '/admin/accounts', { headers: { 'x-profile-id': rig.owner.profile } })).status).toBe(200);
    const foreign = await rig.call<{ error: string }>('GET', '/admin/accounts', { headers: { 'x-profile-id': member.profile } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('profile_invalid');
  });

  it('profil adulte protégé par PIN : jeton de déverrouillage exigé', async () => {
    const created = await request<{ id: string }>(rig.app, 'POST', '/user/profiles', { token: rig.owner.token, body: { name: 'verrou', pin: '1234' } });
    const profileId = created.body.id;
    const locked = await rig.call<{ error: string }>('GET', '/admin/accounts', { headers: { 'x-profile-id': profileId } });
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe('pin_required');
    const unlock = await request<{ token: string }>(rig.app, 'POST', `/user/profiles/${profileId}/unlock`, { token: rig.owner.token, body: { pin: '1234' } });
    expect(unlock.status).toBe(200);
    const ok = await rig.call('GET', '/admin/accounts', { headers: { 'x-profile-id': profileId, 'x-profile-token': unlock.body.token } });
    expect(ok.status).toBe(200);
  });

  it('une route inconnue sous /admin répond 404 JSON (après authentification)', async () => {
    expect((await request(rig.app, 'GET', '/admin/nope')).status).toBe(404);
  });

  it('élévation : mauvais mot de passe 403, bon mot de passe jeton de 10 minutes', async () => {
    const bad = await rig.call<{ error: string }>('POST', '/admin/elevate', { body: { password: 'faux-mot-de-passe' } });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('invalid_password');
    const good = await rig.call<{ token: string; expiresAt: string }>('POST', '/admin/elevate', { body: { password: PASSWORD } });
    expect(good.status).toBe(200);
    const ttl = Date.parse(good.body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it('élévation exigée pour une action destructrice : absente, forgée, périmée, d\'une autre session', async () => {
    const target = await inviteAndRegister(rig.app, rig.owner, 'carole');
    const list = await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?q=carole');
    const id = list.body.accounts[0].id as string;
    const path = `/admin/accounts/${id}/suspend`;

    const none = await rig.call<{ error: string }>('POST', path);
    expect(none.status).toBe(403);
    expect(none.body.error).toBe('elevation_required');

    const forged = await rig.call<{ error: string }>('POST', path, { elevation: 'abc.def' });
    expect(forged.body.error).toBe('elevation_required');

    // Jeton authentique émis il y a 11 minutes : périmé.
    const ownerId = (await rig.call<{ account: { id: string } }>('GET', '/admin/me')).body.account.id;
    const sessionHash = hashSessionToken(rig.owner.token);
    const expired = signElevation({ accountId: ownerId, sessionHash }, Date.now() - 11 * 60_000, SECRET).token;
    const late = await rig.call<{ error: string }>('POST', path, { elevation: expired });
    expect(late.status).toBe(403);
    expect(late.body.error).toBe('elevation_expired');

    // Jeton valide mais lié à une autre session du propriétaire.
    const other = await request<{ token: string }>(rig.app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } });
    const otherSession = await request<{ token: string }>(rig.app, 'POST', '/admin/elevate', { token: other.body.token, body: { password: PASSWORD } });
    const crossed = await rig.call<{ error: string }>('POST', path, { elevation: otherSession.body.token });
    expect(crossed.status).toBe(403);
    expect(crossed.body.error).toBe('elevation_required');

    // Aucune de ces tentatives n'a suspendu le compte.
    expect((await rig.call<{ account: any }>('GET', `/admin/accounts/${id}`)).body.account.status).toBe('active');
    const ok = await rig.call('POST', path, { elevation: await rig.elevate() });
    expect(ok.status).toBe(200);
    void target;
  });

  it('limite de débit : 429 au-delà du plafond', async () => {
    const limited = await startAdmin({ adminRateLimits: { read: 3, write: 100, elevate: 100 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await limited.call('GET', '/admin/settings')).status);
      expect(statuses.slice(0, 2)).toEqual([200, 200]);
      expect(statuses).toContain(429);
    } finally {
      await limited.app.close();
    }
  });

  it('limite de ré-authentification : 429 après trop d\'essais', async () => {
    const limited = await startAdmin({ adminRateLimits: { read: 1000, write: 1000, elevate: 2 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) codes.push((await limited.call('POST', '/admin/elevate', { body: { password: 'mauvais-mot-de-passe' } })).status);
      expect(codes).toEqual([403, 403, 429, 429]);
    } finally {
      await limited.app.close();
    }
  });
});
