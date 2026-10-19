import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { request, createProfileVia } from './user-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type MeBody, type Persona } from './social-v2-harness.js';

interface ViewBody {
  pid: string;
  handle: { name: string; tag: string; full: string };
  avatarColor: string;
  household: boolean;
  status: string;
  watching?: { title: string; season?: number; episode?: number };
  lastSeen?: number;
}
interface RequestBody {
  pid: string;
  handle: { name: string; tag: string; full: string };
  avatarColor: string;
  createdAt: number;
}
interface FriendsBody {
  friends: ViewBody[];
  household: ViewBody[];
  incoming: RequestBody[];
  outgoing: RequestBody[];
}

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  app = await startApp({});
  cast = await castOf(app);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const friendsOf = (who: Acting) => as<FriendsBody>(app, who, 'GET', '/user/social/friends');
const ask = (from: Persona, handle: string) => as<{ request?: RequestBody; friend?: ViewBody } & ErrorBodyV2>(app, from, 'POST', '/user/social/requests', { body: { handle } });

describe('identité (GET /user/social/me)', () => {
  it('renvoie pid, handle Nom#TAG, statut et couleur, sans identifiant interne', async () => {
    const res = await as<MeBody>(app, cast.alice, 'GET', '/user/social/me');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['avatarColor', 'handle', 'pid', 'status']);
    expect(res.body.pid).toMatch(/^[A-Z2-7]{16}$/);
    expect(res.body.handle.name).toBe('alice');
    expect(res.body.handle.tag).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(res.body.handle.full).toBe(`alice#${res.body.handle.tag}`);
    expect(res.body.status).toBe('online');
    expect(JSON.stringify(res.body)).not.toContain(cast.alice.profile);
  });

  it('refuse sans session, sans profil agissant, pour un profil inconnu, un profil d’un autre compte ou un enfant', async () => {
    expect((await request(app, 'GET', '/user/social/me')).status).toBe(401);
    const noHeader = await request<ErrorBodyV2>(app, 'GET', '/user/social/me', { token: cast.alice.token });
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error).toBe('profile_required');
    const unknown = await as<ErrorBodyV2>(app, { token: cast.alice.token, profile: 'inconnu' }, 'GET', '/user/social/me');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('profile_not_found');
    const other = await as<ErrorBodyV2>(app, { token: cast.bob.token, profile: cast.alice.profile }, 'GET', '/user/social/me');
    expect(other.status).toBe(404);
    const kid = await as<ErrorBodyV2>(app, cast.kid, 'GET', '/user/social/me');
    expect(kid.status).toBe(403);
    expect(kid.body.error).toBe('kid_profile');
  });

  it('profil protégé par PIN : X-Profile-Token exigé, puis accepté', async () => {
    const pinned = await createProfileVia<{ id: string }>(app, cast.alice.token, { name: 'Coffre', pin: '4321' });
    const who: Acting = { token: cast.alice.token, profile: pinned.body.id };
    const blocked = await as<ErrorBodyV2>(app, who, 'GET', '/user/social/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('pin_required');
    const unlock = await request<{ token: string }>(app, 'POST', `/user/profiles/${pinned.body.id}/unlock`, { token: cast.alice.token, body: { pin: '4321' } });
    const ok = await as<MeBody>(app, who, 'GET', '/user/social/me', { headers: { 'x-profile-token': unlock.body.token } });
    expect(ok.status).toBe(200);
    expect(ok.body.handle.name).toBe('Coffre');
  });
});

describe('statut (PUT /user/social/status)', () => {
  it('change le statut choisi et refuse une valeur hors liste ou une clé inconnue', async () => {
    const set = await as<{ status: string }>(app, cast.alice, 'PUT', '/user/social/status', { body: { status: 'away' } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ status: 'away' });
    expect((await as<MeBody>(app, cast.alice, 'GET', '/user/social/me')).body.status).toBe('away');
    expect((await as<ErrorBodyV2>(app, cast.alice, 'PUT', '/user/social/status', { body: { status: 'busy' } })).body.error).toBe('invalid_body');
    expect((await as<ErrorBodyV2>(app, cast.alice, 'PUT', '/user/social/status', { body: { status: 'dnd', extra: 1 } })).body.error).toBe('invalid_body');
  });
});

describe('demandes d’ami (POST /user/social/requests)', () => {
  it('demande par handle exact : 201 avec la demande, visible des deux côtés', async () => {
    const sent = await ask(cast.alice, cast.bob.full);
    expect(sent.status).toBe(201);
    expect(sent.body.request?.pid).toBe(cast.bob.pid);
    expect(sent.body.request?.handle.full).toBe(cast.bob.full);
    expect(typeof sent.body.request?.createdAt).toBe('number');
    expect((await friendsOf(cast.alice)).body.outgoing.map((r) => r.pid)).toEqual([cast.bob.pid]);
    expect((await friendsOf(cast.bob)).body.incoming.map((r) => r.pid)).toEqual([cast.alice.pid]);
  });

  it('le handle est insensible à la casse', async () => {
    expect((await ask(cast.alice, cast.bob.full.toLowerCase())).status).toBe(201);
  });

  it('erreurs : handle inconnu 404, mal formé 400, soi-même 400, clé inconnue 400', async () => {
    const unknown = await ask(cast.alice, 'personne#A2B3');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('handle_not_found');
    expect((await ask(cast.alice, 'bob')).body.error).toBe('invalid_body');
    expect((await ask(cast.alice, 'bob#ABC')).body.error).toBe('invalid_body');
    expect((await ask(cast.alice, 'bob#AB0O')).body.error).toBe('invalid_body');
    const self = await ask(cast.alice, cast.alice.full);
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('self');
    const extra = await as<ErrorBodyV2>(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.bob.full, pid: cast.bob.pid } });
    expect(extra.body.error).toBe('invalid_body');
  });

  it('doublon : 409 already_requested ; une fois amis : 409 already_friends', async () => {
    expect((await ask(cast.alice, cast.bob.full)).status).toBe(201);
    const dup = await ask(cast.alice, cast.bob.full);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_requested');
    expect((await as(app, cast.bob, 'POST', `/user/social/requests/${cast.alice.pid}/accept`)).status).toBe(200);
    const again = await ask(cast.alice, cast.bob.full);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_friends');
  });

  it('demande croisée : 200 avec l’ami, sans seconde demande', async () => {
    await ask(cast.alice, cast.bob.full);
    const crossed = await ask(cast.bob, cast.alice.full);
    expect(crossed.status).toBe(200);
    expect(crossed.body.friend?.pid).toBe(cast.alice.pid);
    expect(crossed.body.friend?.household).toBe(false);
    const alice = await friendsOf(cast.alice);
    expect(alice.body.friends.map((f) => f.pid)).toEqual([cast.bob.pid]);
    expect(alice.body.incoming).toEqual([]);
    expect(alice.body.outgoing).toEqual([]);
  });
});

describe('réponses aux demandes et amitiés', () => {
  it('acceptation : 200 avec l’ami ; ensuite la demande n’existe plus (404)', async () => {
    await ask(cast.alice, cast.bob.full);
    const accepted = await as<{ friend: ViewBody }>(app, cast.bob, 'POST', `/user/social/requests/${cast.alice.pid}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.friend.pid).toBe(cast.alice.pid);
    expect(accepted.body.friend.household).toBe(false);
    expect((await friendsOf(cast.alice)).body.friends.map((f) => f.pid)).toEqual([cast.bob.pid]);
    const again = await as<ErrorBodyV2>(app, cast.bob, 'POST', `/user/social/requests/${cast.alice.pid}/accept`);
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('request_not_found');
  });

  it('on ne accepte pas sa propre demande envoyée, ni un pid inconnu ou mal formé (404)', async () => {
    await ask(cast.alice, cast.bob.full);
    const own = await as<ErrorBodyV2>(app, cast.alice, 'POST', `/user/social/requests/${cast.bob.pid}/accept`);
    expect(own.status).toBe(404);
    expect(own.body.error).toBe('request_not_found');
    expect((await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/requests/AAAAAAAAAAAAAAAA/accept')).status).toBe(404);
    expect((await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/requests/pas-un-pid/accept')).status).toBe(404);
  });

  it('refus d’une demande reçue et annulation d’une demande envoyée : 204, puis 404', async () => {
    await ask(cast.alice, cast.carol.full);
    expect((await as(app, cast.carol, 'DELETE', `/user/social/requests/${cast.alice.pid}`)).status).toBe(204);
    const gone = await as<ErrorBodyV2>(app, cast.carol, 'DELETE', `/user/social/requests/${cast.alice.pid}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('request_not_found');
    await ask(cast.alice, cast.bob.full);
    expect((await as(app, cast.alice, 'DELETE', `/user/social/requests/${cast.bob.pid}`)).status).toBe(204);
    expect((await friendsOf(cast.alice)).body.outgoing).toEqual([]);
    expect((await friendsOf(cast.bob)).body.incoming).toEqual([]);
  });

  it('suppression d’un ami : 204 dans les deux sens, puis 404', async () => {
    await befriend(app, cast.alice, cast.bob);
    expect((await as(app, cast.alice, 'DELETE', `/user/social/friends/${cast.bob.pid}`)).status).toBe(204);
    expect((await friendsOf(cast.alice)).body.friends).toEqual([]);
    expect((await friendsOf(cast.bob)).body.friends).toEqual([]);
    const again = await as<ErrorBodyV2>(app, cast.alice, 'DELETE', `/user/social/friends/${cast.bob.pid}`);
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('friend_not_found');
  });
});

describe('foyer et enfants', () => {
  it('le foyer est visible sans demande, jamais en ami, et ne se demande ni ne se retire', async () => {
    const alice = await friendsOf(cast.alice);
    expect(alice.body.household.map((h) => h.pid)).toEqual([cast.alice2.pid]);
    expect(alice.body.household[0]?.household).toBe(true);
    expect(alice.body.friends).toEqual([]);
    const asked = await ask(cast.alice, cast.alice2.full);
    expect(asked.status).toBe(409);
    expect(asked.body.error).toBe('already_friends');
    expect((await as<ErrorBodyV2>(app, cast.alice, 'DELETE', `/user/social/friends/${cast.alice2.pid}`)).status).toBe(404);
    expect((await friendsOf(cast.alice2)).body.household.map((h) => h.pid)).toEqual([cast.alice.pid]);
  });

  it('un profil enfant n’a ni handle ni pid : absent du foyer, introuvable par son nom, sans aucune route sociale', async () => {
    expect((await friendsOf(cast.alice)).body.household.map((h) => h.pid)).toEqual([cast.alice2.pid]);
    expect((await ask(cast.alice, 'Petit#A2B3')).body.error).toBe('handle_not_found');
    const who = cast.kid;
    expect((await as(app, who, 'GET', '/user/social/me')).status).toBe(403);
    expect((await as(app, who, 'GET', '/user/social/friends')).status).toBe(403);
    expect((await as(app, who, 'PUT', '/user/social/status', { body: { status: 'away' } })).status).toBe(403);
    expect((await as(app, who, 'PUT', '/user/social/presence', { body: {} })).status).toBe(403);
    expect((await as(app, who, 'DELETE', '/user/social/presence')).status).toBe(403);
    expect((await as(app, who, 'POST', '/user/social/requests', { body: { handle: cast.bob.full } })).status).toBe(403);
    expect((await as(app, who, 'GET', `/user/social/friends/${cast.alice.pid}/library`)).status).toBe(403);
  });

  it('l’identifiant interne d’un profil enfant n’est jamais un pid : 404 sur les routes par pid', async () => {
    const res = await as<ErrorBodyV2>(app, cast.alice, 'GET', `/user/social/friends/${cast.kid.profile}/library`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('friend_not_found');
  });
});
