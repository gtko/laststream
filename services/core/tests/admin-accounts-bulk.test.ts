/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inviteAndRegister, type Member, PASSWORD, request, startAdmin, type AdminRig } from './admin-harness.js';

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}

async function quotaOf(rig: AdminRig, username: string): Promise<number> {
  const list = await rig.call<{ accounts: { username: string; inviteQuota: number }[] }>('GET', `/admin/accounts?q=${username}`);
  return list.body.accounts.find((account) => account.username === username)?.inviteQuota ?? -1;
}

const randomIds = (count: number): string[] => Array.from({ length: count }, () => crypto.randomUUID());

describe('/admin/accounts/bulk', () => {
  let rig: AdminRig;
  let bob: Member;
  let carol: Member;
  let dave: Member;

  // alice (propriétaire) -> bob, dave ; bob -> carol. Quota par défaut : 4.
  beforeEach(async () => {
    rig = await startAdmin();
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    carol = await inviteAndRegister(rig.app, bob, 'carol');
    dave = await inviteAndRegister(rig.app, rig.owner, 'dave');
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('sans session : 401 ; compte non propriétaire : 403 owner_only, même avec élévation', async () => {
    const body = { ids: [await idOf(rig, 'bob')], action: 'suspend' };
    expect((await request(rig.app, 'POST', '/admin/accounts/bulk', { body })).status).toBe(401);
    const denied = await request<{ error: string }>(rig.app, 'POST', '/admin/accounts/bulk', { token: bob.token, body, headers: { 'x-admin-elevation': await rig.elevate() } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('owner_only');
    expect((await rig.call<any>('GET', '/admin/accounts?q=bob')).body.accounts[0].status).toBe('active');
  });

  it('élévation exigée pour toute action : 403 elevation_required, rien modifié', async () => {
    const ids = [await idOf(rig, 'bob')];
    for (const body of [
      { ids, action: 'quota', quota: 1 },
      { ids, action: 'revoke-sessions' },
      { ids, action: 'suspend' },
    ]) {
      const res = await rig.call<{ error: string }>('POST', '/admin/accounts/bulk', { body });
      expect(res.status, body.action).toBe(403);
      expect(res.body.error).toBe('elevation_required');
    }
    expect(await quotaOf(rig, 'bob')).toBe(4);
    expect((await rig.call<any>('GET', '/admin/accounts?q=bob')).body.accounts[0].status).toBe('active');
    expect((await request(rig.app, 'GET', '/user/me', { token: bob.token })).status).toBe(200);
  });

  it('quota absolu : appliqué à chaque compte, done et failed', async () => {
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', {
      elevation: await rig.elevate(),
      body: { ids: [await idOf(rig, 'bob'), await idOf(rig, 'dave')], action: 'quota', quota: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: 2, failed: [] });
    expect(await quotaOf(rig, 'bob')).toBe(2);
    expect(await quotaOf(rig, 'dave')).toBe(2);
    // Un quota absolu hors bornes est refusé par la validation (400), rien n'est écrit.
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [await idOf(rig, 'bob')], action: 'quota', quota: 101 } })).status).toBe(400);
    expect(await quotaOf(rig, 'bob')).toBe(2);
  });

  it('quota en delta : hors de 0 à 100 signalé par compte, sans bloquer le lot', async () => {
    const bobId = await idOf(rig, 'bob');
    const daveId = await idOf(rig, 'dave');
    // 4 + 97 = 101 : hors bornes pour bob ; dave (4) n'est pas concerné.
    const over = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [bobId], action: 'quota', delta: 97 } });
    expect(over.body).toEqual({ done: 0, failed: [{ id: bobId, error: 'quota_out_of_range' }] });
    expect(await quotaOf(rig, 'bob')).toBe(4);

    // Lot mixte : bob (4 - 4 = 0) et dave (4 - 4 = 0) passent ; un troisième compte inconnu échoue.
    const unknown = crypto.randomUUID();
    const mixed = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [bobId, unknown, daveId], action: 'quota', delta: -4 } });
    expect(mixed.body).toEqual({ done: 2, failed: [{ id: unknown, error: 'account_not_found' }] });
    expect(await quotaOf(rig, 'bob')).toBe(0);
    expect(await quotaOf(rig, 'dave')).toBe(0);

    // Sous zéro : refusé.
    const under = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [bobId], action: 'quota', delta: -1 } });
    expect(under.body.failed).toEqual([{ id: bobId, error: 'quota_out_of_range' }]);
  });

  it('quota : exactement un des deux (quota ou delta), et seulement pour l\'action quota', async () => {
    const elevation = await rig.elevate();
    const ids = [await idOf(rig, 'bob')];
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids, action: 'quota' } })).status).toBe(400);
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids, action: 'quota', quota: 1, delta: 1 } })).status).toBe(400);
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids, action: 'suspend', quota: 1 } })).status).toBe(400);
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids, action: 'revoke-sessions', delta: 1 } })).status).toBe(400);
    expect(await quotaOf(rig, 'bob')).toBe(4);
  });

  it('révocation des sessions de plusieurs comptes ; la connexion reste possible ensuite', async () => {
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', {
      elevation: await rig.elevate(),
      body: { ids: [await idOf(rig, 'bob'), await idOf(rig, 'carol')], action: 'revoke-sessions' },
    });
    expect(res.body).toEqual({ done: 2, failed: [] });
    expect((await request(rig.app, 'GET', '/user/me', { token: bob.token })).status).toBe(401);
    expect((await request(rig.app, 'GET', '/user/me', { token: carol.token })).status).toBe(401);
    expect((await request(rig.app, 'GET', '/user/me', { token: dave.token })).status).toBe(200);
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } })).status).toBe(200);
  });

  it('suspension : le propriétaire est refusé (cannot_target_owner), les autres suspendus, sessions révoquées', async () => {
    const ownerId = await idOf(rig, 'alice');
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', {
      elevation: await rig.elevate(),
      body: { ids: [ownerId, await idOf(rig, 'bob'), await idOf(rig, 'dave')], action: 'suspend' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: 2, failed: [{ id: ownerId, error: 'cannot_target_owner' }] });
    expect((await request(rig.app, 'GET', '/user/me', { token: bob.token })).status).toBe(401);
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'dave', password: PASSWORD } })).status).toBe(403);
    expect((await rig.call<any>('GET', '/admin/accounts?filter=suspended')).body.total).toBe(2);
    expect((await rig.call<any>('GET', `/admin/accounts/${ownerId}`)).body.account.status).toBe('active');
    expect((await request(rig.app, 'GET', '/user/me', { token: rig.owner.token })).status).toBe(200);
  });

  it('suspension : le compte qui agit ne peut pas se suspendre lui-même', async () => {
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [await idOf(rig, 'alice')], action: 'suspend' } });
    expect(res.body).toEqual({ done: 0, failed: [{ id: await idOf(rig, 'alice'), error: 'cannot_target_owner' }] });
  });

  it('identifiants : mal formé ou liste vide en 400 ; compte inconnu en échec', async () => {
    const elevation = await rig.elevate();
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: ['pas-un-uuid'], action: 'revoke-sessions' } })).status).toBe(400);
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: [], action: 'revoke-sessions' } })).status).toBe(400);
    const unknown = crypto.randomUUID();
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation, body: { ids: [unknown], action: 'revoke-sessions' } });
    expect(res.body).toEqual({ done: 0, failed: [{ id: unknown, error: 'account_not_found' }] });
  });

  it('plafond : 100 identifiants au plus, 101 refusés (400) sans rien traiter', async () => {
    const elevation = await rig.elevate();
    expect((await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: randomIds(101), action: 'revoke-sessions' } })).status).toBe(400);
    const full = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation, body: { ids: randomIds(100), action: 'revoke-sessions' } });
    expect(full.status).toBe(200);
    expect(full.body.done).toBe(0);
    expect(full.body.failed).toHaveLength(100);
    expect((await request(rig.app, 'GET', '/user/me', { token: bob.token })).status).toBe(200);
  });

  it('doublons : un compte n\'est traité qu\'une fois', async () => {
    const bobId = await idOf(rig, 'bob');
    const res = await rig.call<any>('POST', '/admin/accounts/bulk', { elevation: await rig.elevate(), body: { ids: [bobId, bobId], action: 'quota', quota: 3 } });
    expect(res.body).toEqual({ done: 1, failed: [] });
    expect(await quotaOf(rig, 'bob')).toBe(3);
  });

  it('audit : une entrée par opération, écrite avant son exécution ; aucune pour les refus de validation', async () => {
    const elevation = await rig.elevate();
    const bobId = await idOf(rig, 'bob');
    await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: [bobId, bobId], action: 'quota', quota: 3 } });
    await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: [bobId], action: 'quota' } });
    await rig.call('POST', '/admin/accounts/bulk', { body: { ids: [bobId], action: 'quota', quota: 1 } });
    const audit = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=account.bulk');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({
      actor: 'alice',
      action: 'account.bulk',
      detail: { action: 'quota', count: 1, quota: 3, accountIds: [bobId] },
    });
  });

  it('audit : opération de suspension tracée avec ses identifiants', async () => {
    const elevation = await rig.elevate();
    const daveId = await idOf(rig, 'dave');
    await rig.call('POST', '/admin/accounts/bulk', { elevation, body: { ids: [daveId], action: 'suspend' } });
    const audit = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=account.bulk');
    expect(audit.body.entries[0].detail).toMatchObject({ action: 'suspend', count: 1, accountIds: [daveId] });
    expect(JSON.stringify(audit.body)).not.toContain(PASSWORD);
  });
});
