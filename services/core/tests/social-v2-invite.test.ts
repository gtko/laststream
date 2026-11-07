import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapOwner, inviteAndRegister } from './social-harness.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, HOOK_TIMEOUT_MS, type Acting, personaOf, registerWithoutProfile } from './social-v2-harness.js';
import { createProfileVia } from './user-harness.js';

/** Parrainage en v2 : l'invitation crée une amitié entre profils principaux (voir linkInvitedPrincipals). */

interface FriendsBody {
  friends: { pid: string; handle: { full: string } }[];
}

let app: RunningApp;

beforeEach(async () => {
  app = await startApp({});
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const friendPids = async (who: Acting): Promise<string[]> => {
  const res = await as<FriendsBody>(app, who, 'GET', '/user/social/friends');
  expect(res.status).toBe(200);
  return res.body.friends.map((friend) => friend.pid).sort();
};

describe('inscription par lien d’invitation (v2)', () => {
  it('le filleul et le parrain se voient en amis, dans les deux sens', async () => {
    const alice = await bootstrapOwner(app, 'alice');
    const bob = await inviteAndRegister(app, alice, 'bob');
    const a = await personaOf(app, alice.token, alice.profile, 'alice');
    const b = await personaOf(app, bob.token, bob.profile, 'bob');

    const bobFriends = await as<FriendsBody>(app, b, 'GET', '/user/social/friends');
    expect(bobFriends.body.friends.map((friend) => friend.pid)).toEqual([a.pid]);
    expect(bobFriends.body.friends[0]?.handle.full).toBe(a.full);
    expect(await friendPids(a)).toEqual([b.pid]);
  });

  it('parrain sans profil à l’inscription : l’amitié naît quand il crée son profil principal', async () => {
    const alice = await bootstrapOwner(app, 'alice');
    const hub = await registerWithoutProfile(app, alice, 'hub');
    const bob = await inviteAndRegister(app, hub, 'bob');
    const b = await personaOf(app, bob.token, bob.profile, 'bob');
    expect(await friendPids(b)).toEqual([]);

    const created = await createProfileVia<{ id: string }>(app, hub.token, { name: 'hub' });
    const h = await personaOf(app, hub.token, created.body.id, 'hub');
    const a = await personaOf(app, alice.token, alice.profile, 'alice');
    expect(await friendPids(b)).toEqual([h.pid]);
    // Le compte hub a aussi été invité par alice : les deux liens se posent au même moment.
    expect(await friendPids(h)).toEqual([a.pid, b.pid].sort());
  });

  it('un profil adulte supplémentaire ne rétablit pas une amitié d’invitation retirée', async () => {
    const alice = await bootstrapOwner(app, 'alice');
    const bob = await inviteAndRegister(app, alice, 'bob');
    const a = await personaOf(app, alice.token, alice.profile, 'alice');
    const b = await personaOf(app, bob.token, bob.profile, 'bob');
    expect(await friendPids(b)).toEqual([a.pid]);

    const removed = await as(app, b, 'DELETE', `/user/social/friends/${a.pid}`);
    expect(removed.status).toBe(204);
    await createProfileVia(app, bob.token, { name: 'Bob deux' });
    expect(await friendPids(b)).toEqual([]);
  });
});
