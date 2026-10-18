import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { addKidProfile, bootstrapOwner, inviteAndRegister, type Member } from './social-harness.js';
import { type ErrorBody, request } from './user-harness.js';

interface FriendsBody {
  friends: { username: string; avatarColor: string; status: 'online' | 'watching' | 'offline'; watching: { title: string; type: string; season: number | null; episode: number | null } | null }[];
  incoming: { username: string }[];
  outgoing: { username: string }[];
}

let app: RunningApp;
let alice: Member;
let bob: Member;
let carol: Member;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
  app = await startApp({});
  alice = await bootstrapOwner(app);
  // bob et carol sont filleuls d'alice (donc ses amis) ; on retire ces amitiés pour tester les demandes à partir de rien.
  bob = await inviteAndRegister(app, alice, 'bob');
  carol = await inviteAndRegister(app, alice, 'carol');
  await request(app, 'DELETE', '/user/friends/bob', { token: alice.token });
  await request(app, 'DELETE', '/user/friends/carol', { token: alice.token });
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const friends = (member: Member) => request<FriendsBody>(app, 'GET', '/user/friends', { token: member.token });
const ask = (from: Member, username: string) => request<{ status?: string } & ErrorBody>(app, 'POST', '/user/friends/requests', { token: from.token, body: { username } });

describe('amis', () => {
  it('demande par pseudo exact, acceptation, puis liste des deux côtés', async () => {
    const sent = await ask(alice, 'Bob');
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('sent');
    expect((await friends(alice)).body.outgoing.map((r) => r.username)).toEqual(['bob']);
    expect((await friends(bob)).body.incoming.map((r) => r.username)).toEqual(['alice']);
    expect((await friends(bob)).body.friends).toEqual([]);
    expect((await request(app, 'POST', '/user/friends/requests/alice/accept', { token: bob.token })).status).toBe(204);
    expect((await friends(alice)).body.friends.map((f) => f.username)).toEqual(['bob']);
    expect((await friends(bob)).body.friends.map((f) => f.username)).toEqual(['alice']);
    expect((await friends(bob)).body.incoming).toEqual([]);
  });

  it('pseudo inconnu, soi-même, doublon et déjà amis sont refusés', async () => {
    expect((await ask(alice, 'personne')).status).toBe(404);
    expect((await ask(alice, 'alice')).body.error).toBe('cannot_befriend_self');
    // Recherche exacte : un préfixe ne trouve rien.
    expect((await ask(alice, 'bobb')).status).toBe(404);
    expect((await ask(alice, 'bob')).status).toBe(201);
    const dup = await ask(alice, 'bob');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('request_pending');
    await request(app, 'POST', '/user/friends/requests/alice/accept', { token: bob.token });
    expect((await ask(alice, 'bob')).body.error).toBe('already_friends');
  });

  it('une demande croisée vaut acceptation', async () => {
    await ask(alice, 'bob');
    const crossed = await ask(bob, 'alice');
    expect(crossed.status).toBe(200);
    expect(crossed.body.status).toBe('accepted');
    expect((await friends(alice)).body.friends.map((f) => f.username)).toEqual(['bob']);
  });

  it('refus d’une demande reçue, annulation d’une demande envoyée, suppression d’un ami', async () => {
    await ask(alice, 'bob');
    expect((await request(app, 'DELETE', '/user/friends/requests/alice', { token: bob.token })).status).toBe(204);
    expect((await friends(alice)).body.outgoing).toEqual([]);
    await ask(carol, 'alice');
    expect((await request(app, 'DELETE', '/user/friends/requests/alice', { token: carol.token })).status).toBe(204);
    expect((await request(app, 'DELETE', '/user/friends/requests/alice', { token: carol.token })).status).toBe(404);
    await ask(alice, 'bob');
    await request(app, 'POST', '/user/friends/requests/alice/accept', { token: bob.token });
    expect((await request(app, 'DELETE', '/user/friends/bob', { token: alice.token })).status).toBe(204);
    expect((await friends(bob)).body.friends).toEqual([]);
    expect((await request(app, 'DELETE', '/user/friends/bob', { token: alice.token })).status).toBe(404);
  });

  it('seul le destinataire accepte une demande', async () => {
    await ask(alice, 'bob');
    expect((await request(app, 'POST', '/user/friends/requests/bob/accept', { token: alice.token })).status).toBe(404);
    expect((await request(app, 'POST', '/user/friends/requests/alice/accept', { token: carol.token })).status).toBe(404);
  });

  it('ne partage que pseudo et avatar : aucun identifiant de compte', async () => {
    await ask(alice, 'bob');
    await request(app, 'POST', '/user/friends/requests/alice/accept', { token: bob.token });
    const body = (await friends(alice)).body;
    expect(Object.keys(body.friends[0] ?? {}).sort()).toEqual(['avatarColor', 'since', 'status', 'username', 'watching']);
  });
});

describe('présence', () => {
  beforeEach(async () => {
    await ask(alice, 'bob');
    await request(app, 'POST', '/user/friends/requests/alice/accept', { token: bob.token });
  });

  const heartbeat = (member: Member, body: Record<string, unknown> = {}) =>
    request(app, 'PUT', '/user/presence', { token: member.token, body: { profileId: member.profile, ...body } });

  it('hors ligne par défaut, en ligne après un battement, hors ligne après 90 s', async () => {
    expect((await friends(alice)).body.friends[0]?.status).toBe('offline');
    expect((await heartbeat(bob)).status).toBe(204);
    expect((await friends(alice)).body.friends[0]).toMatchObject({ status: 'online', watching: null });
    vi.setSystemTime(new Date('2026-05-01T10:01:20.000Z'));
    expect((await friends(alice)).body.friends[0]?.status).toBe('online');
    vi.setSystemTime(new Date('2026-05-01T10:01:31.000Z'));
    expect((await friends(alice)).body.friends[0]?.status).toBe('offline');
  });

  it('« en train de regarder » avec le titre, l’épisode, puis retour à « en ligne »', async () => {
    await heartbeat(bob, { watching: { type: 'series', tmdbId: 1399, title: 'Game of Thrones', season: 2, episode: 4 } });
    expect((await friends(alice)).body.friends[0]).toMatchObject({
      status: 'watching',
      watching: { type: 'series', title: 'Game of Thrones', season: 2, episode: 4 },
    });
    await heartbeat(bob, { watching: null });
    expect((await friends(alice)).body.friends[0]).toMatchObject({ status: 'online', watching: null });
  });

  it('mode invisible : apparaît hors ligne ; déconnexion explicite efface la présence', async () => {
    await heartbeat(bob, { invisible: true });
    expect((await friends(alice)).body.friends[0]?.status).toBe('offline');
    await heartbeat(bob);
    expect((await friends(alice)).body.friends[0]?.status).toBe('online');
    expect((await request(app, 'DELETE', '/user/presence', { token: bob.token })).status).toBe(204);
    expect((await friends(alice)).body.friends[0]?.status).toBe('offline');
  });

  it('un profil enfant n’annonce jamais de titre ; un non-ami ne voit rien', async () => {
    const kid = await addKidProfile(app, bob);
    await request(app, 'PUT', '/user/presence', { token: bob.token, body: { profileId: kid, watching: { type: 'movie', tmdbId: 5, title: 'Secret' } } });
    expect((await friends(alice)).body.friends[0]).toMatchObject({ status: 'online', watching: null });
    await heartbeat(carol, { watching: { type: 'movie', tmdbId: 6, title: 'Autre' } });
    expect((await friends(alice)).body.friends.map((f) => f.username)).toEqual(['bob']);
  });

  it('profil étranger, titre sans identifiant : refusés', async () => {
    expect((await request(app, 'PUT', '/user/presence', { token: bob.token, body: { profileId: alice.profile } })).status).toBe(404);
    expect((await heartbeat(bob, { watching: { type: 'movie', title: 'Sans id' } })).status).toBe(400);
  });
});
