/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AdminRig, inviteAndRegister, type Member, PASSWORD, request, startAdmin } from './admin-harness.js';

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}

/** Tous les codes d'invitation visibles par leurs titulaires : aucun ne doit apparaître dans une réponse d'administration. */
async function allCodes(rig: AdminRig, members: Member[]): Promise<string[]> {
  const codes: string[] = [];
  for (const member of members) {
    const list = await request<{ invites: { code: string }[] }>(rig.app, 'GET', '/user/invites', { token: member.token });
    codes.push(...list.body.invites.map((invite) => invite.code));
  }
  return codes;
}

describe('/admin : invitations', () => {
  let rig: AdminRig;
  let bob: Member;
  let carol: Member;

  beforeEach(async () => {
    rig = await startAdmin();
    // alice (propriétaire) invite bob ; bob invite carol. Chacun a 4 liens : un utilisé, trois libres.
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    carol = await inviteAndRegister(rig.app, bob, 'carol');
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('détail du compte : liens du compte, état, jamais de code', async () => {
    const bobId = await idOf(rig, 'bob');
    const detail = await rig.call<any>('GET', `/admin/accounts/${bobId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.invites).toHaveLength(4);
    const used = detail.body.invites.filter((invite: any) => invite.status === 'used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ ownerId: bobId, ownerUsername: 'bob', usedBy: await idOf(rig, 'carol'), usedByUsername: 'carol', expiresAt: null });
    expect(used[0].usedAt).toEqual(expect.any(String));
    expect(detail.body.invites.filter((invite: any) => invite.status === 'active')).toHaveLength(3);
    for (const invite of detail.body.invites) expect(invite).not.toHaveProperty('code');

    const codes = await allCodes(rig, [rig.owner, bob, carol]);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(JSON.stringify(detail.body)).not.toContain(code);
  });

  it('liste : tous les liens, filtres par statut, limite, 400 si invalide', async () => {
    const all = await rig.call<{ invites: any[] }>('GET', '/admin/invites');
    expect(all.status).toBe(200);
    expect(all.body.invites).toHaveLength(8);
    expect(all.body.invites.filter((invite) => invite.status === 'used')).toHaveLength(2);
    expect(all.body.invites.filter((invite) => invite.status === 'active')).toHaveLength(6);
    expect(all.body.invites.map((invite) => invite.ownerUsername).sort()).toEqual(['alice', 'alice', 'alice', 'alice', 'bob', 'bob', 'bob', 'bob']);

    const used = await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=used');
    expect(used.body.invites.map((invite) => invite.ownerUsername).sort()).toEqual(['alice', 'bob']);
    expect((await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=revoked')).body.invites).toEqual([]);
    expect((await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=expired')).body.invites).toEqual([]);
    expect((await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=active&limit=2')).body.invites).toHaveLength(2);

    expect((await rig.call('GET', '/admin/invites?status=perime')).status).toBe(400);
    expect((await rig.call('GET', '/admin/invites?limit=0')).status).toBe(400);
    expect((await rig.call('GET', '/admin/invites?limit=501')).status).toBe(400);

    const codes = await allCodes(rig, [rig.owner, bob, carol]);
    for (const code of codes) expect(JSON.stringify(all.body)).not.toContain(code);
    expect(all.body.invites[0]).not.toHaveProperty('code');
  });

  it('invitation système : sans propriétaire, révocable', async () => {
    const system = await rig.backend.social().createSystemInvite(new Date().toISOString());
    const listed = await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=active');
    expect(listed.body.invites.find((invite) => invite.id === system.id)).toMatchObject({ ownerId: null, ownerUsername: null, status: 'active' });

    expect((await rig.call('DELETE', `/admin/invites/${system.id}`, { elevation: await rig.elevate() })).status).toBe(204);
    expect((await request<any>(rig.app, 'GET', `/user/invites/check?code=${system.code}`)).body).toEqual({ valid: false, inviter: null });
  });

  it('révocation : élévation exigée, 404, 400, 409 si utilisée ou déjà révoquée, 204, audit', async () => {
    const target = (await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=active')).body.invites[0];
    const path = `/admin/invites/${target.id}`;
    const statusOf = async (): Promise<string | undefined> =>
      (await rig.call<{ invites: any[] }>('GET', '/admin/invites')).body.invites.find((invite) => invite.id === target.id)?.status;

    expect((await rig.call('DELETE', path)).status).toBe(403);
    expect((await rig.call('DELETE', path, { elevation: 'jeton-invente' })).status).toBe(403);
    expect(await statusOf()).toBe('active');

    expect((await rig.call('DELETE', `/admin/invites/${crypto.randomUUID()}`, { elevation: await rig.elevate() })).status).toBe(404);
    expect((await rig.call('DELETE', '/admin/invites/pas-un-uuid', { elevation: await rig.elevate() })).status).toBe(400);

    const usedInvite = (await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=used')).body.invites[0];
    const usedRes = await rig.call<{ error: string }>('DELETE', `/admin/invites/${usedInvite.id}`, { elevation: await rig.elevate() });
    expect(usedRes.status).toBe(409);
    expect(usedRes.body.error).toBe('invite_not_active');

    expect((await rig.call('DELETE', path, { elevation: await rig.elevate() })).status).toBe(204);
    expect(await statusOf()).toBe('revoked');
    const revoked = await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=revoked');
    expect(revoked.body.invites.map((invite) => invite.id)).toEqual([target.id]);
    const again = await rig.call<{ error: string }>('DELETE', path, { elevation: await rig.elevate() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invite_not_active');

    const audit = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=invite.revoke');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({ actor: 'alice', target: target.ownerUsername, detail: { inviteId: target.id, ownerId: target.ownerId } });
    const codes = await allCodes(rig, [rig.owner, bob, carol]);
    for (const code of codes) expect(JSON.stringify(audit.body)).not.toContain(code);
  });

  it('lien révoqué refusé à l\'inscription (vérification et inscription), sans compte créé', async () => {
    const free = (await request<{ invites: any[] }>(rig.app, 'GET', '/user/invites', { token: rig.owner.token })).body.invites.find((invite) => invite.state === 'free');
    expect(free).toBeDefined();
    expect((await request<any>(rig.app, 'GET', `/user/invites/check?code=${free.code}`)).body).toEqual({ valid: true, inviter: 'alice' });

    expect((await rig.call('DELETE', `/admin/invites/${free.id}`, { elevation: await rig.elevate() })).status).toBe(204);
    expect((await request<any>(rig.app, 'GET', `/user/invites/check?code=${free.code}`)).body).toEqual({ valid: false, inviter: null });
    const refused = await request<{ error: string }>(rig.app, 'POST', '/user/register', { body: { username: 'erin', password: PASSWORD, invite: free.code } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('invite_invalid');
    expect((await rig.call<any>('GET', '/admin/accounts?q=erin')).body.total).toBe(0);
  });

  it('régénération par le propriétaire : l’ancien code est mort, le nouveau lien libre fonctionne', async () => {
    const free = (await request<{ invites: any[] }>(rig.app, 'GET', '/user/invites', { token: rig.owner.token })).body.invites.find((invite) => invite.state === 'free');
    expect((await rig.call('DELETE', `/admin/invites/${free.id}`, { elevation: await rig.elevate() })).status).toBe(204);

    const regenerated = await request<{ invite: { id: string; code: string } }>(rig.app, 'DELETE', `/user/invites/${free.id}`, { token: rig.owner.token });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.invite.id).toBe(free.id);
    expect(regenerated.body.invite.code).not.toBe(free.code);
    expect((await request<any>(rig.app, 'GET', `/user/invites/check?code=${regenerated.body.invite.code}`)).body).toEqual({ valid: true, inviter: 'alice' });
    const joined = await request<{ account: { username: string } }>(rig.app, 'POST', '/user/register', {
      body: { username: 'erin', password: PASSWORD, invite: regenerated.body.invite.code },
    });
    expect(joined.status).toBe(201);
  });

  it('accès : 401 sans session, 403 pour un autre compte, rien de modifié', async () => {
    const target = (await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=active')).body.invites[0];
    expect((await request(rig.app, 'GET', '/admin/invites')).status).toBe(401);
    expect((await request(rig.app, 'DELETE', `/admin/invites/${target.id}`)).status).toBe(401);

    const asBob = { token: bob.token, headers: { 'x-profile-id': bob.profile } };
    const listed = await request<{ error: string }>(rig.app, 'GET', '/admin/invites', asBob);
    expect(listed.status).toBe(403);
    expect(listed.body.error).toBe('owner_only');
    const revoked = await request<{ error: string }>(rig.app, 'DELETE', `/admin/invites/${target.id}`, {
      ...asBob,
      headers: { ...asBob.headers, 'x-admin-elevation': await rig.elevate() },
    });
    expect(revoked.status).toBe(403);
    expect(revoked.body.error).toBe('owner_only');
    expect((await rig.call<{ invites: any[] }>('GET', '/admin/invites?status=revoked')).body.invites).toEqual([]);
  });
});
