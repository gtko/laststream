/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKidProfile, inviteAndRegister, type Member, PASSWORD, request, startAdmin, type AdminRig } from './admin-harness.js';

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}

const SENSITIVE = /password|hash|scrypt|pin_hash|token_hash|secret|apikey/i;

describe('/admin : comptes', () => {
  let rig: AdminRig;
  let bob: Member;
  let carol: Member;
  let dave: Member;

  beforeEach(async () => {
    rig = await startAdmin();
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    carol = await inviteAndRegister(rig.app, bob, 'carol');
    dave = await inviteAndRegister(rig.app, rig.owner, 'dave');
    await addKidProfile(rig.app, bob);
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('liste : champs utiles, jamais de donnée sensible', async () => {
    const res = await rig.call<{ accounts: any[]; total: number; nextCursor: string | null }>('GET', '/admin/accounts');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    const byName = new Map(res.body.accounts.map((account) => [account.username, account]));
    const bobRow = byName.get('bob');
    expect(bobRow).toMatchObject({ username: 'bob', isOwner: false, status: 'active', referrer: 'alice', profileCount: 2, inviteQuota: 4, invitesUsed: 1 });
    expect(bobRow.lastActivityAt).toEqual(expect.any(String));
    expect(bobRow.createdAt).toEqual(expect.any(String));
    expect(byName.get('carol')?.referrer).toBe('bob');
    expect(byName.get('alice')).toMatchObject({ isOwner: true, referrer: null });
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('bibliothèque comptée par compte', async () => {
    await request(rig.app, 'PUT', `/user/profiles/${bob.profile}/library/movie/603`, { token: bob.token, body: { title: 'Matrix' } });
    const bobRow = (await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?q=bob')).body.accounts[0];
    expect(bobRow.libraryCount).toBe(1);
  });

  it('recherche par pseudo, statut, parrain et date', async () => {
    const q = await rig.call<{ accounts: any[]; total: number }>('GET', '/admin/accounts?q=ar');
    expect(q.body.accounts.map((a) => a.username)).toEqual(['carol']);
    const percent = await rig.call<{ total: number }>('GET', '/admin/accounts?q=%25');
    expect(percent.body.total).toBe(0);
    const referred = await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?referrer=alice');
    expect(referred.body.accounts.map((a) => a.username).sort()).toEqual(['bob', 'dave']);
    const future = await rig.call<{ total: number }>('GET', '/admin/accounts?createdFrom=2999-01-01');
    expect(future.body.total).toBe(0);
    const past = await rig.call<{ total: number }>('GET', '/admin/accounts?createdFrom=2000-01-01&createdTo=2999-01-01');
    expect(past.body.total).toBe(4);
    expect((await rig.call('GET', '/admin/accounts?createdFrom=hier')).status).toBe(400);
    expect((await rig.call('GET', '/admin/accounts?limit=0')).status).toBe(400);
  });

  it('pagination par curseur, sans doublon ni oubli', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { accounts: any[]; nextCursor: string | null; total: number } } = await rig.call('GET', `/admin/accounts?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...res.body.accounts.map((a) => a.username));
      expect(res.body.total).toBe(4);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);
    expect(pages).toBe(2);
    expect([...seen].sort()).toEqual(['alice', 'bob', 'carol', 'dave']);
    const oldest = await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?order=oldest&limit=1');
    expect(oldest.body.accounts[0].username).toBe('alice');
  });

  it('détail : profils (sans PIN), filleuls, sessions', async () => {
    const detail = await rig.call<any>('GET', `/admin/accounts/${await idOf(rig, 'bob')}`);
    expect(detail.status).toBe(200);
    expect(detail.body.account.username).toBe('bob');
    expect(detail.body.profiles).toHaveLength(2);
    expect(detail.body.profiles.some((p: any) => p.isKid)).toBe(true);
    expect(detail.body.invitees).toEqual([{ id: await idOf(rig, 'carol'), username: 'carol', usedAt: expect.any(String) }]);
    expect(detail.body.sessions).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{24}$/), device: null, createdAt: expect.any(String), lastSeenAt: expect.any(String), expiresAt: expect.any(String) },
    ]);
    expect(detail.body.account).toMatchObject({ online: false, sessionCount: 1 });
    expect(JSON.stringify(detail.body)).not.toMatch(SENSITIVE);
    expect((await rig.call('GET', `/admin/accounts/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await rig.call('GET', '/admin/accounts/pas-un-uuid')).status).toBe(400);
  });

  it('arbre de parrainage', async () => {
    const tree = await rig.call<{ roots: any[]; total: number; truncated: boolean }>('GET', '/admin/referrals');
    expect(tree.status).toBe(200);
    expect(tree.body.total).toBe(4);
    expect(tree.body.roots).toHaveLength(1);
    const root = tree.body.roots[0];
    expect(root.username).toBe('alice');
    expect(root.children.map((c: any) => c.username).sort()).toEqual(['bob', 'dave']);
    const bobNode = root.children.find((c: any) => c.username === 'bob');
    expect(bobNode.children.map((c: any) => c.username)).toEqual(['carol']);
  });

  it('quota d\'invitations : modifié et appliqué', async () => {
    const id = await idOf(rig, 'dave');
    const res = await rig.call<any>('PUT', `/admin/accounts/${id}/invite-quota`, { body: { quota: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.quota).toBe(1);
    const invites = await request<{ quota: number }>(rig.app, 'GET', '/user/invites', { token: dave.token });
    expect(invites.body.quota).toBe(1);
    expect((await rig.call('PUT', `/admin/accounts/${id}/invite-quota`, { body: { quota: -1 } })).status).toBe(400);
    expect((await rig.call('PUT', `/admin/accounts/${id}/invite-quota`, { body: { quota: 101 } })).status).toBe(400);
  });

  it('suspension : connexion et sessions refusées, réactivation', async () => {
    const id = await idOf(rig, 'bob');
    const suspend = await rig.call<any>('POST', `/admin/accounts/${id}/suspend`, { elevation: await rig.elevate() });
    expect(suspend.status).toBe(200);
    expect(suspend.body.status).toBe('suspended');
    // La session ouverte ne marche plus ; la connexion est refusée avec le bon mot de passe.
    expect((await request(rig.app, 'GET', '/user/me', { token: bob.token })).status).toBe(401);
    const login = await request<{ error: string }>(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } });
    expect(login.status).toBe(403);
    expect(login.body.error).toBe('account_suspended');
    const listed = await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?status=suspended');
    expect(listed.body.accounts.map((a) => a.username)).toEqual(['bob']);
    expect((await rig.call<any>('GET', '/admin/accounts?status=active')).body.total).toBe(3);

    const reactivate = await rig.call<any>('POST', `/admin/accounts/${id}/reactivate`);
    expect(reactivate.body.status).toBe('active');
    const again = await request<{ token: string }>(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } });
    expect(again.status).toBe(200);
    expect((await request(rig.app, 'GET', '/user/me', { token: again.body.token })).status).toBe(200);
  });

  it('révocation de toutes les sessions', async () => {
    const id = await idOf(rig, 'carol');
    const second = await request<{ token: string }>(rig.app, 'POST', '/user/login', { body: { username: 'carol', password: PASSWORD } });
    expect((await request(rig.app, 'GET', '/user/me', { token: second.body.token })).status).toBe(200);
    expect((await rig.call('POST', `/admin/accounts/${id}/revoke-sessions`)).status).toBe(403);
    expect((await rig.call('POST', `/admin/accounts/${id}/revoke-sessions`, { elevation: await rig.elevate() })).status).toBe(204);
    expect((await request(rig.app, 'GET', '/user/me', { token: carol.token })).status).toBe(401);
    expect((await request(rig.app, 'GET', '/user/me', { token: second.body.token })).status).toBe(401);
    // Le compte reste utilisable : une nouvelle connexion réussit.
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'carol', password: PASSWORD } })).status).toBe(200);
  });

  it('révocation unitaire d\'une session : élévation exigée, 404 hors du compte, audit', async () => {
    const carolId = await idOf(rig, 'carol');
    const bobId = await idOf(rig, 'bob');
    const second = await request<{ token: string }>(rig.app, 'POST', '/user/login', { body: { username: 'carol', password: PASSWORD } });
    const before = (await rig.call<any>('GET', `/admin/accounts/${carolId}`)).body.sessions as { id: string }[];
    expect(before).toHaveLength(2);
    const [target] = before;
    const path = `/admin/accounts/${carolId}/sessions/${target.id}`;

    expect((await rig.call('DELETE', path)).status).toBe(403);
    // Session de carol désignée sous le compte de bob, identifiant inconnu, identifiant mal formé : refusés, rien révoqué.
    expect((await rig.call('DELETE', `/admin/accounts/${bobId}/sessions/${target.id}`, { elevation: await rig.elevate() })).status).toBe(404);
    expect((await rig.call('DELETE', `/admin/accounts/${carolId}/sessions/${'0'.repeat(24)}`, { elevation: await rig.elevate() })).status).toBe(404);
    expect((await rig.call('DELETE', `/admin/accounts/${carolId}/sessions/pas-une-session`, { elevation: await rig.elevate() })).status).toBe(400);
    expect((await rig.call<any>('GET', `/admin/accounts/${carolId}`)).body.sessions).toHaveLength(2);

    expect((await rig.call('DELETE', path, { elevation: await rig.elevate() })).status).toBe(204);
    const after = (await rig.call<any>('GET', `/admin/accounts/${carolId}`)).body.sessions as { id: string }[];
    expect(after.map((s) => s.id)).not.toContain(target.id);
    expect(after).toHaveLength(1);
    // Exactement une des deux sessions reste ouverte ; une seconde révocation de la même session donne 404.
    const statuses = await Promise.all([carol.token, second.body.token].map(async (token) => (await request(rig.app, 'GET', '/user/me', { token })).status));
    expect(statuses.sort()).toEqual([200, 401]);
    expect((await rig.call('DELETE', path, { elevation: await rig.elevate() })).status).toBe(404);

    const audit = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=account.session.revoke');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({ actor: 'alice', target: 'carol', detail: { accountId: carolId, sessionId: target.id } });
    expect(JSON.stringify(audit.body)).not.toMatch(SENSITIVE);
  });

  it('compteurs : sessions ouvertes et présence (deux minutes)', async () => {
    const carolId = await idOf(rig, 'carol');
    await request(rig.app, 'POST', '/user/login', { body: { username: 'carol', password: PASSWORD } });
    const row = (await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?q=carol')).body.accounts[0];
    expect(row).toMatchObject({ username: 'carol', online: false, sessionCount: 2 });

    await rig.backend.social().setPresence(carolId, carol.profile, null, false, new Date().toISOString());
    expect((await rig.call<any>('GET', `/admin/accounts/${carolId}`)).body.account).toMatchObject({ online: true, sessionCount: 2 });
    expect((await rig.call<{ accounts: any[] }>('GET', '/admin/accounts?q=carol')).body.accounts[0].online).toBe(true);

    await rig.backend.social().setPresence(carolId, carol.profile, null, false, new Date(Date.now() - 3 * 60_000).toISOString());
    expect((await rig.call<any>('GET', `/admin/accounts/${carolId}`)).body.account.online).toBe(false);
  });

  it('bibliothèque du compte dans le détail', async () => {
    const bobId = await idOf(rig, 'bob');
    await request(rig.app, 'PUT', `/user/profiles/${bob.profile}/library/movie/603`, { token: bob.token, body: { title: 'Matrix' } });
    expect((await rig.call<any>('GET', `/admin/accounts/${bobId}`)).body.libraryCount).toBe(1);
  });

  it('suppression : compte et données disparus, élévation exigée', async () => {
    const id = await idOf(rig, 'carol');
    expect((await rig.call('DELETE', `/admin/accounts/${id}`)).status).toBe(403);
    expect((await rig.call('GET', `/admin/accounts/${id}`)).status).toBe(200);
    expect((await rig.call('DELETE', `/admin/accounts/${id}`, { elevation: await rig.elevate() })).status).toBe(204);
    expect((await rig.call('GET', `/admin/accounts/${id}`)).status).toBe(404);
    expect((await request(rig.app, 'GET', '/user/me', { token: carol.token })).status).toBe(401);
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'carol', password: PASSWORD } })).status).toBe(401);
    expect((await rig.call<any>('GET', '/admin/accounts')).body.total).toBe(3);
    expect((await rig.call('DELETE', `/admin/accounts/${id}`, { elevation: await rig.elevate() })).status).toBe(404);
  });

  it('le propriétaire ne peut ni se suspendre ni se supprimer', async () => {
    const ownerId = await idOf(rig, 'alice');
    const elevation = await rig.elevate();
    for (const [method, path] of [
      ['POST', `/admin/accounts/${ownerId}/suspend`],
      ['DELETE', `/admin/accounts/${ownerId}`],
    ] as const) {
      const res = await rig.call<{ error: string }>(method, path, { elevation });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toBe('cannot_target_owner');
    }
    expect((await request(rig.app, 'GET', '/user/me', { token: rig.owner.token })).status).toBe(200);
    expect((await rig.call<any>('GET', `/admin/accounts/${ownerId}`)).body.account.status).toBe('active');
  });

  it('lien de réinitialisation : usage unique, 24 h, sessions révoquées, public', async () => {
    const id = await idOf(rig, 'dave');
    expect((await rig.call('POST', `/admin/accounts/${id}/reset-link`)).status).toBe(403);
    const link = await rig.call<{ token: string; expiresAt: string; url: string }>('POST', `/admin/accounts/${id}/reset-link`, { elevation: await rig.elevate() });
    expect(link.status).toBe(201);
    const ttl = Date.parse(link.body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(23.9 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
    expect(link.body.url).toContain(`token=${link.body.token}`);

    // Route publique (aucune session).
    expect((await request(rig.app, 'POST', '/user/password-reset', { body: { token: 'x'.repeat(43), password: 'nouveau-mot-de-passe' } })).status).toBe(400);
    expect((await request(rig.app, 'POST', '/user/password-reset', { body: { token: link.body.token, password: 'court' } })).status).toBe(400);
    const used = await request(rig.app, 'POST', '/user/password-reset', { body: { token: link.body.token, password: 'nouveau-mot-de-passe' } });
    expect(used.status).toBe(204);
    // Deuxième usage refusé ; anciennes sessions mortes ; ancien mot de passe invalide, nouveau valide.
    expect((await request(rig.app, 'POST', '/user/password-reset', { body: { token: link.body.token, password: 'encore-un-autre-mdp' } })).status).toBe(400);
    expect((await request(rig.app, 'GET', '/user/me', { token: dave.token })).status).toBe(401);
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'dave', password: PASSWORD } })).status).toBe(401);
    expect((await request(rig.app, 'POST', '/user/login', { body: { username: 'dave', password: 'nouveau-mot-de-passe' } })).status).toBe(200);
    // Le jeton n'apparaît ni dans le journal d'audit ni dans les listes.
    const audit = await rig.call('GET', '/admin/audit');
    expect(JSON.stringify(audit.body)).not.toContain(link.body.token);
  });

  it('lien de réinitialisation expiré refusé ; un nouveau lien remplace le précédent', async () => {
    const id = await idOf(rig, 'dave');
    const first = await rig.call<{ token: string }>('POST', `/admin/accounts/${id}/reset-link`, { elevation: await rig.elevate() });
    const second = await rig.call<{ token: string }>('POST', `/admin/accounts/${id}/reset-link`, { elevation: await rig.elevate() });
    expect((await request(rig.app, 'POST', '/user/password-reset', { body: { token: first.body.token, password: 'nouveau-mot-de-passe' } })).status).toBe(400);
    expect((await request(rig.app, 'POST', '/user/password-reset', { body: { token: second.body.token, password: 'nouveau-mot-de-passe' } })).status).toBe(204);
  });

  it('journal d\'audit : qui, quoi, quand — et rien de sensible', async () => {
    const id = await idOf(rig, 'bob');
    await rig.call('PUT', `/admin/accounts/${id}/invite-quota`, { body: { quota: 2 } });
    await rig.call('POST', `/admin/accounts/${id}/suspend`, { elevation: await rig.elevate() });
    await rig.call('POST', '/admin/elevate', { body: { password: 'mauvais-mot-de-passe' } });
    const audit = await rig.call<{ entries: any[]; nextBefore: number | null }>('GET', '/admin/audit');
    expect(audit.status).toBe(200);
    const actions = audit.body.entries.map((entry) => entry.action);
    expect(actions).toEqual(['elevate.failed', 'account.suspend', 'elevate', 'account.invite_quota']);
    const suspend = audit.body.entries.find((entry) => entry.action === 'account.suspend');
    expect(suspend).toMatchObject({ actor: 'alice', target: 'bob', detail: { accountId: id } });
    expect(Date.parse(suspend.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(audit.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit.body)).not.toContain('mauvais-mot-de-passe');

    const page = await rig.call<{ entries: any[]; nextBefore: number | null }>('GET', '/admin/audit?limit=2');
    expect(page.body.entries).toHaveLength(2);
    expect(page.body.nextBefore).not.toBeNull();
    const next = await rig.call<{ entries: any[] }>('GET', `/admin/audit?limit=2&before=${page.body.nextBefore}`);
    expect(next.body.entries.map((e) => e.action)).toEqual(['elevate', 'account.invite_quota']);
    const filtered = await rig.call<{ entries: any[] }>('GET', '/admin/audit?action=account.suspend');
    expect(filtered.body.entries).toHaveLength(1);
  });
});
