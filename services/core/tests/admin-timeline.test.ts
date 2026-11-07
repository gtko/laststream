/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AdminRig, inviteAndRegister, type Member, PASSWORD, request, startAdmin } from './admin-harness.js';

async function idOf(rig: AdminRig, username: string): Promise<string> {
  const list = await rig.call<{ accounts: { id: string; username: string }[] }>('GET', `/admin/accounts?q=${username}`);
  const found = list.body.accounts.find((account) => account.username === username);
  if (found === undefined) throw new Error(`compte ${username} introuvable`);
  return found.id;
}

const SENSITIVE = /password|hash|scrypt|pin_hash|token_hash|secret|apikey/i;

describe('/admin : chronologie d’un compte', () => {
  let rig: AdminRig;
  let bob: Member;

  beforeEach(async () => {
    rig = await startAdmin();
    bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    await inviteAndRegister(rig.app, bob, 'carol');
    await inviteAndRegister(rig.app, rig.owner, 'dave');
    const bobId = await idOf(rig, 'bob');
    // Une seconde connexion de bob, un salon hébergé par bob, un signalement contre bob (envoyé par carol).
    await request(rig.app, 'POST', '/user/login', { body: { username: 'bob', password: PASSWORD } });
    await rig.backend.social().addPartyRoom({
      id: 'salon-bob-1',
      hostId: bobId,
      visibility: 'public',
      title: 'Soirée Matrix',
      poster: null,
      language: 'fr',
      mediaType: 'movie',
      createdAt: new Date().toISOString(),
    });
    await rig.backend.admin().addReport({
      roomId: 'salon-bob-1',
      messageId: 'message-1',
      by: 'carol',
      againstId: bobId,
      against: 'bob',
      text: 'texte du message signalé',
      reason: 'harcèlement',
      at: Date.now(),
    });
    // Actions de l'administrateur : sur bob (quota, lien de réinitialisation : sans toucher aux sessions) et sur dave
    // (suspension, qui ne doit pas apparaître chez bob).
    await rig.call('PUT', `/admin/accounts/${bobId}/invite-quota`, { body: { quota: 3 } });
    await rig.call('POST', `/admin/accounts/${bobId}/reset-link`, { elevation: await rig.elevate() });
    await rig.call('POST', `/admin/accounts/${await idOf(rig, 'dave')}/suspend`, { elevation: await rig.elevate() });
  });
  afterEach(async () => {
    await rig.app.close();
  });

  it('types, libellés, auteur des actions, récent d’abord', async () => {
    const bobId = await idOf(rig, 'bob');
    const res = await rig.call<{ events: any[] }>('GET', `/admin/accounts/${bobId}/timeline`);
    expect(res.status).toBe(200);
    const events = res.body.events;
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set(['audit', 'signup', 'invite', 'session', 'party']));

    for (let index = 1; index < events.length; index += 1) {
      expect(Date.parse(events[index - 1].at)).toBeGreaterThanOrEqual(Date.parse(events[index].at));
    }
    expect(events).toContainEqual({ at: expect.any(String), kind: 'signup', label: 'Inscription', detail: 'parrainé par alice' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'audit', label: 'Lien de réinitialisation créé', detail: 'par alice' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'audit', label: 'Quota d’invitations modifié', detail: 'par alice' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'invite', label: 'Invitation utilisée', detail: 'carol' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'invite', label: 'Invitation créée' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'party', label: 'Salon créé', detail: 'Soirée Matrix' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'party', label: 'Signalé dans un salon', detail: 'harcèlement' }));
    expect(JSON.stringify(events)).not.toContain('texte du message signalé');
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);

    // Un événement de session par session ouverte, comme dans le détail du compte.
    const detail = await rig.call<any>('GET', `/admin/accounts/${bobId}`);
    expect(events.filter((event) => event.kind === 'session')).toHaveLength(detail.body.sessions.length);
    expect(events.filter((event) => event.kind === 'session').every((event) => event.label === 'Connexion')).toBe(true);
  });

  it('ne contient que les événements du compte (ni ceux des autres comptes, ni ceux de dave)', async () => {
    const bobId = await idOf(rig, 'bob');
    const events = (await rig.call<{ events: any[] }>('GET', `/admin/accounts/${bobId}/timeline`)).body.events;
    // La suspension de dave (même administrateur, même journal) n'apparaît pas chez bob.
    expect(events.some((event) => event.label === 'Compte suspendu')).toBe(false);
    expect(events.some((event) => event.detail === 'dave')).toBe(false);
    const daveEvents = (await rig.call<{ events: any[] }>('GET', `/admin/accounts/${await idOf(rig, 'dave')}/timeline`)).body.events;
    expect(daveEvents).toContainEqual(expect.objectContaining({ kind: 'audit', label: 'Compte suspendu', detail: 'par alice' }));
    // Le signalement envoyé par carol contre bob apparaît chez carol, pas chez bob.
    expect(events.some((event) => event.label === 'Signalement envoyé')).toBe(false);
    const carolEvents = (await rig.call<{ events: any[] }>('GET', `/admin/accounts/${await idOf(rig, 'carol')}/timeline`)).body.events;
    expect(carolEvents).toContainEqual(expect.objectContaining({ kind: 'party', label: 'Signalement envoyé', detail: 'contre bob' }));
    expect(carolEvents.some((event) => event.kind === 'audit')).toBe(false);
  });

  it('actions de l’administrateur : sa propre chronologie (ré-authentification, échec)', async () => {
    await rig.call('POST', '/admin/elevate', { body: { password: 'mauvais-mot-de-passe' } });
    await rig.elevate();
    const aliceId = await idOf(rig, 'alice');
    const events = (await rig.call<{ events: any[] }>('GET', `/admin/accounts/${aliceId}/timeline`)).body.events;
    expect(events).toContainEqual(expect.objectContaining({ kind: 'audit', label: 'Échec de ré-authentification' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'audit', label: 'Ré-authentification' }));
    // Les actions faites par alice n'ont pas de « par » : c'est elle qui agit.
    expect(events.find((event) => event.label === 'Compte suspendu')).not.toHaveProperty('detail');
    expect(events.filter((event) => event.kind === 'signup')).toEqual([expect.objectContaining({ detail: 'sans parrain' })]);
  });

  it('limite : 50 par défaut, 1 à 200, la plus récente en tête', async () => {
    const bobId = await idOf(rig, 'bob');
    const all = (await rig.call<{ events: any[] }>('GET', `/admin/accounts/${bobId}/timeline?limit=200`)).body.events;
    expect(all.length).toBeLessThanOrEqual(200);
    const three = await rig.call<{ events: any[] }>('GET', `/admin/accounts/${bobId}/timeline?limit=3`);
    expect(three.body.events).toEqual(all.slice(0, 3));
    const defaults = await rig.call<{ events: any[] }>('GET', `/admin/accounts/${bobId}/timeline`);
    expect(defaults.body.events.length).toBeLessThanOrEqual(50);
    expect((await rig.call('GET', `/admin/accounts/${bobId}/timeline?limit=0`)).status).toBe(400);
    expect((await rig.call('GET', `/admin/accounts/${bobId}/timeline?limit=201`)).status).toBe(400);
  });

  it('erreurs : 404 compte inconnu, 400 identifiant mal formé, 401 sans session, 403 hors propriétaire', async () => {
    expect((await rig.call('GET', `/admin/accounts/${crypto.randomUUID()}/timeline`)).status).toBe(404);
    expect((await rig.call('GET', '/admin/accounts/pas-un-uuid/timeline')).status).toBe(400);
    const bobId = await idOf(rig, 'bob');
    expect((await request(rig.app, 'GET', `/admin/accounts/${bobId}/timeline`)).status).toBe(401);
    const asBob = await request<{ error: string }>(rig.app, 'GET', `/admin/accounts/${bobId}/timeline`, {
      token: bob.token,
      headers: { 'x-profile-id': bob.profile },
    });
    expect(asBob.status).toBe(403);
    expect(asBob.body.error).toBe('owner_only');
  });
});
