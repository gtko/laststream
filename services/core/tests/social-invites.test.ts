import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, personaOf } from './social-v2-harness.js';
import { bootstrapOwner, type InviteBody, inviteAndRegister, type Member } from './social-harness.js';
import { type AccountBody, type ErrorBody, PASSWORD, request } from './user-harness.js';

interface FriendsBody {
  friends: { handle: { name: string } }[];
  incoming: unknown[];
  outgoing: unknown[];
}

/** Amis vus par le profil principal d'un membre (API sociale v2, par pid). */
const friendsOf = async (member: Member, name: string) => {
  const me = await personaOf(app, member.token, member.profile, name);
  return as<FriendsBody>(app, me, 'GET', '/user/social/friends');
};

let app: RunningApp;
let alice: Member;

beforeEach(async () => {
  app = await startApp({});
  alice = await bootstrapOwner(app);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

const invites = (member: Member) => request<InviteBody>(app, 'GET', '/user/invites', { token: member.token });
const register = (username: string, invite?: string) =>
  request<AccountBody | ErrorBody>(app, 'POST', '/user/register', { body: { username, password: PASSWORD, ...(invite === undefined ? {} : { invite }) } });

describe('parrainage : inscription par lien', () => {
  it('sans lien, l’inscription d’un second compte est refusée ; un lien inconnu aussi', async () => {
    expect((await register('bob')).body).toEqual({ error: 'signup_disabled' });
    const res = await register('bob', 'lien-inexistant-0123456789');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'invite_invalid' });
  });

  it('chaque compte a 4 liens libres, distincts, créés à la demande', async () => {
    const res = await invites(alice);
    expect(res.status).toBe(200);
    expect(res.body.quota).toBe(4);
    expect(res.body.invites).toHaveLength(4);
    expect(res.body.invites.every((invite) => invite.state === 'free' && invite.invitee === null)).toBe(true);
    expect(new Set(res.body.invites.map((invite) => invite.code)).size).toBe(4);
    // Relire ne crée rien de plus et garde les mêmes codes.
    expect((await invites(alice)).body.invites.map((i) => i.code)).toEqual(res.body.invites.map((i) => i.code));
  });

  it('un lien = une inscription : le filleul est créé sans droits de propriétaire, le lien passe « utilisé » avec son pseudo', async () => {
    const code = (await invites(alice)).body.invites[0]?.code ?? '';
    const res = await register('bob', code);
    expect(res.status).toBe(201);
    expect((res.body as AccountBody).account).toMatchObject({ username: 'bob', isOwner: false });
    const used = (await invites(alice)).body.invites.filter((invite) => invite.state === 'used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ invitee: 'bob', code });
    // Réutilisation refusée, y compris pour un autre pseudo.
    const again = await register('carol', code);
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ error: 'invite_invalid' });
  });

  it('deux inscriptions simultanées avec le même lien : une seule réussit', async () => {
    const code = (await invites(alice)).body.invites[0]?.code ?? '';
    const results = await Promise.all([register('bob', code), register('carol', code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
  });

  it('un nom déjà pris ne consomme pas le lien', async () => {
    const code = (await invites(alice)).body.invites[0]?.code ?? '';
    const res = await register('alice', code);
    expect(res.status).toBe(409);
    expect((await invites(alice)).body.invites.find((i) => i.code === code)?.state).toBe('free');
    expect((await register('bob', code)).status).toBe(201);
  });

  it('le filleul devient automatiquement ami du parrain (amitié acceptée des deux côtés)', async () => {
    const bob = await inviteAndRegister(app, alice, 'bob');
    const mine = await friendsOf(alice, 'alice');
    expect(mine.body.friends.map((f) => f.handle.name)).toEqual(['bob']);
    expect(mine.body.incoming).toEqual([]);
    const his = await friendsOf(bob, 'bob');
    expect(his.body.friends.map((f) => f.handle.name)).toEqual(['alice']);
  });

  it('quota de 4 : après 4 inscriptions plus aucun lien libre ; le propriétaire peut l’augmenter', async () => {
    for (const name of ['bob', 'carol', 'dave', 'erin']) await inviteAndRegister(app, alice, name);
    const full = await invites(alice);
    expect(full.body.invites).toHaveLength(4);
    expect(full.body.invites.every((invite) => invite.state === 'used')).toBe(true);
    const up = await request(app, 'PUT', '/user/accounts/alice/invite-quota', { token: alice.token, body: { quota: 6 } });
    expect(up.status).toBe(200);
    const more = await invites(alice);
    expect(more.body.quota).toBe(6);
    expect(more.body.invites.filter((invite) => invite.state === 'free')).toHaveLength(2);
  });

  it('réduire le quota supprime les liens libres en trop mais jamais un lien utilisé', async () => {
    await inviteAndRegister(app, alice, 'bob');
    await invites(alice);
    await request(app, 'PUT', '/user/accounts/alice/invite-quota', { token: alice.token, body: { quota: 0 } });
    const res = await invites(alice);
    expect(res.body.quota).toBe(0);
    expect(res.body.invites.map((invite) => invite.state)).toEqual(['used']);
  });

  it('seul le propriétaire ajuste un quota ; valeurs et pseudos inconnus refusés', async () => {
    const bob = await inviteAndRegister(app, alice, 'bob');
    const denied = await request<ErrorBody>(app, 'PUT', '/user/accounts/alice/invite-quota', { token: bob.token, body: { quota: 50 } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('owner_only');
    expect((await request(app, 'PUT', '/user/accounts/zoe/invite-quota', { token: alice.token, body: { quota: 1 } })).status).toBe(404);
    expect((await request(app, 'PUT', '/user/accounts/bob/invite-quota', { token: alice.token, body: { quota: -1 } })).status).toBe(400);
    expect((await request(app, 'PUT', '/user/accounts/bob/invite-quota', { token: alice.token, body: { quota: 500 } })).status).toBe(400);
    expect((await request(app, 'PUT', '/user/accounts/bob/invite-quota', { token: alice.token, body: { quota: 7 } })).status).toBe(200);
    expect((await invites(bob)).body.quota).toBe(7);
  });

  it('marquer « envoyé » est indicatif ; réversible tant que le lien n’est pas utilisé', async () => {
    const [first] = (await invites(alice)).body.invites;
    const sent = await request(app, 'PUT', `/user/invites/${first?.id}/sent`, { token: alice.token, body: { sent: true } });
    expect(sent.status).toBe(204);
    expect((await invites(alice)).body.invites.find((i) => i.id === first?.id)?.state).toBe('sent');
    await request(app, 'PUT', `/user/invites/${first?.id}/sent`, { token: alice.token, body: { sent: false } });
    expect((await invites(alice)).body.invites.find((i) => i.id === first?.id)?.state).toBe('free');
  });

  it('révoquer un lien non utilisé : l’ancien code meurt, l’emplacement reçoit un nouveau code libre', async () => {
    const [first] = (await invites(alice)).body.invites;
    await request(app, 'PUT', `/user/invites/${first?.id}/sent`, { token: alice.token, body: { sent: true } });
    const revoked = await request<{ invite: InviteBody['invites'][number] }>(app, 'DELETE', `/user/invites/${first?.id}`, { token: alice.token });
    expect(revoked.status).toBe(200);
    expect(revoked.body.invite.id).toBe(first?.id);
    expect(revoked.body.invite.code).not.toBe(first?.code);
    expect(revoked.body.invite.state).toBe('free');
    expect((await register('bob', first?.code)).body).toEqual({ error: 'invite_invalid' });
    expect((await register('bob', revoked.body.invite.code)).status).toBe(201);
    // Toujours 4 emplacements.
    expect((await invites(alice)).body.invites).toHaveLength(4);
  });

  it('un lien utilisé ne se révoque pas (409) ; le lien d’un autre compte reste introuvable (404)', async () => {
    const bob = await inviteAndRegister(app, alice, 'bob');
    const used = (await invites(alice)).body.invites.find((invite) => invite.state === 'used');
    const res = await request<ErrorBody>(app, 'DELETE', `/user/invites/${used?.id}`, { token: alice.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invite_used');
    const other = (await invites(alice)).body.invites.find((invite) => invite.state === 'free');
    expect((await request(app, 'DELETE', `/user/invites/${other?.id}`, { token: bob.token })).status).toBe(404);
    expect((await request(app, 'PUT', `/user/invites/${other?.id}/sent`, { token: bob.token, body: { sent: true } })).status).toBe(404);
  });

  it('vérification publique d’un lien : valide avec le pseudo du parrain, invalide une fois utilisé', async () => {
    const code = (await invites(alice)).body.invites[0]?.code ?? '';
    expect((await request(app, 'GET', `/user/invites/check?code=${code}`)).body).toEqual({ valid: true, inviter: 'alice' });
    await register('bob', code);
    expect((await request(app, 'GET', `/user/invites/check?code=${code}`)).body).toEqual({ valid: false, inviter: null });
    expect((await request(app, 'GET', '/user/invites/check?code=inconnu-inconnu')).body).toEqual({ valid: false, inviter: null });
    expect((await request(app, 'GET', '/user/invites/check')).status).toBe(400);
  });

  it('les routes de parrainage exigent une session', async () => {
    expect((await request(app, 'GET', '/user/invites')).status).toBe(401);
  });

  it('supprimer le compte du filleul laisse le lien « utilisé » sans pseudo', async () => {
    const bob = await inviteAndRegister(app, alice, 'bob');
    await request(app, 'DELETE', '/user/account', { token: bob.token, body: { password: PASSWORD } });
    const used = (await invites(alice)).body.invites.filter((invite) => invite.state === 'used');
    expect(used).toHaveLength(1);
    expect(used[0]?.invitee).toBeNull();
    const friends = await friendsOf(alice, 'alice');
    expect(friends.body.friends).toEqual([]);
  });

  it('LASTADDON_ALLOW_SIGNUP=1 reste une option de serveur perso : inscription sans lien', async () => {
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    expect((await register('bob')).status).toBe(201);
  });
});
