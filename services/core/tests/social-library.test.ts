import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { addKidProfile, bootstrapOwner, inviteAndRegister, type Member } from './social-harness.js';
import { type ErrorBody, request } from './user-harness.js';

interface LibraryBody {
  items: { type: string; tmdbId: number | null; title: string; visibility: string }[];
}
interface SharedBody {
  items: { type: string; tmdbId: number | null; imdbId: string | null; title: string; poster: string | null; addedAt: string }[];
  total: number;
  limit: number;
  offset: number;
}

let app: RunningApp;
let alice: Member;
let bob: Member;
let carol: Member;

beforeEach(async () => {
  app = await startApp({});
  alice = await bootstrapOwner(app);
  bob = await inviteAndRegister(app, alice, 'bob'); // ami d'alice
  carol = await inviteAndRegister(app, bob, 'carol'); // amie de bob seulement
});

afterEach(async () => {
  await app.close();
});

const put = (member: Member, type: string, id: number, title: string, profile = member.profile) =>
  request(app, 'PUT', `/user/profiles/${profile}/library/${type}/${id}`, { token: member.token, body: { title } });
const visibility = (member: Member, type: string, id: number, value: string, profile = member.profile) =>
  request<ErrorBody>(app, 'PUT', `/user/profiles/${profile}/library/${type}/${id}/visibility`, { token: member.token, body: { visibility: value } });
const shared = (viewer: Member, username: string, query = '') =>
  request<SharedBody & ErrorBody>(app, 'GET', `/user/friends/${username}/library${query}`, { token: viewer.token });

describe('visibilité de la bibliothèque', () => {
  it('privée par défaut : un ami ne voit rien tant que rien n’est partagé', async () => {
    await put(alice, 'movie', 1, 'Matrix');
    const own = await request<LibraryBody>(app, 'GET', `/user/profiles/${alice.profile}/library`, { token: alice.token });
    expect(own.body.items[0]?.visibility).toBe('private');
    const res = await shared(bob, 'alice');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('un titre passé en « friends » devient lisible par les amis, et redevient privé', async () => {
    await put(alice, 'movie', 1, 'Matrix');
    await put(alice, 'series', 2, 'Severance');
    expect((await visibility(alice, 'movie', 1, 'friends')).status).toBe(204);
    expect((await shared(bob, 'alice')).body.items.map((i) => i.title)).toEqual(['Matrix']);
    await visibility(alice, 'movie', 1, 'private');
    expect((await shared(bob, 'alice')).body.items).toEqual([]);
  });

  it('re-ajouter un titre ne change pas sa visibilité ; un titre retiré disparaît du partage', async () => {
    await put(alice, 'movie', 1, 'Matrix');
    await visibility(alice, 'movie', 1, 'friends');
    await put(alice, 'movie', 1, 'Matrix (remaster)');
    expect((await shared(bob, 'alice')).body.items.map((i) => i.title)).toEqual(['Matrix (remaster)']);
    await request(app, 'DELETE', `/user/profiles/${alice.profile}/library/movie/1`, { token: alice.token });
    expect((await shared(bob, 'alice')).body.items).toEqual([]);
  });

  it('visibilité en bloc, avec filtre de type', async () => {
    await put(alice, 'movie', 1, 'A');
    await put(alice, 'movie', 2, 'B');
    await put(alice, 'series', 3, 'C');
    const res = await request<{ updated: number }>(app, 'PUT', `/user/profiles/${alice.profile}/library/visibility`, {
      token: alice.token,
      body: { visibility: 'friends', type: 'movie' },
    });
    expect(res.body.updated).toBe(2);
    expect((await shared(bob, 'alice')).body.items.map((i) => i.title).sort()).toEqual(['A', 'B']);
    expect((await shared(bob, 'alice', '?type=series')).body.items).toEqual([]);
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/visibility`, { token: alice.token, body: { visibility: 'friends' } });
    expect((await shared(bob, 'alice')).body.total).toBe(3);
  });

  it('seuls les amis lisent : un non-ami et un inconnu reçoivent la même réponse 404', async () => {
    await put(alice, 'movie', 1, 'Matrix');
    await visibility(alice, 'movie', 1, 'friends');
    const stranger = await shared(carol, 'alice');
    const unknown = await shared(carol, 'personne');
    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(stranger.body).toEqual(unknown.body);
    // Sans session : 401.
    expect((await request(app, 'GET', '/user/friends/alice/library')).status).toBe(401);
  });

  it('pagination limit / offset et total', async () => {
    for (let id = 1; id <= 5; id += 1) await put(alice, 'movie', id, `Film ${id}`);
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/visibility`, { token: alice.token, body: { visibility: 'friends' } });
    const first = await shared(bob, 'alice', '?limit=2&offset=0');
    const second = await shared(bob, 'alice', '?limit=2&offset=2');
    const last = await shared(bob, 'alice', '?limit=2&offset=4');
    expect(first.body).toMatchObject({ total: 5, limit: 2, offset: 0 });
    expect([...first.body.items, ...second.body.items, ...last.body.items]).toHaveLength(5);
    expect(new Set([...first.body.items, ...second.body.items, ...last.body.items].map((i) => i.title)).size).toBe(5);
    expect((await shared(bob, 'alice', '?limit=1000')).status).toBe(400);
  });

  it('un titre présent dans deux profils n’apparaît qu’une fois ; les profils enfants ne partagent rien', async () => {
    const second = await request<{ id: string }>(app, 'POST', '/user/profiles', { token: alice.token, body: { name: 'second' } });
    await put(alice, 'movie', 1, 'Matrix');
    await put(alice, 'movie', 1, 'Matrix', second.body.id);
    await visibility(alice, 'movie', 1, 'friends');
    await visibility(alice, 'movie', 1, 'friends', second.body.id);
    expect((await shared(bob, 'alice')).body.total).toBe(1);

    const kid = await addKidProfile(app, alice);
    await put(alice, 'movie', 9, 'Dessin animé', kid);
    const refused = await visibility(alice, 'movie', 9, 'friends', kid);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('kid_profile');
    const bulk = await request<ErrorBody>(app, 'PUT', `/user/profiles/${kid}/library/visibility`, { token: alice.token, body: { visibility: 'friends' } });
    expect(bulk.status).toBe(403);
    expect((await shared(bob, 'alice')).body.items.map((i) => i.title)).toEqual(['Matrix']);
  });

  it('titre absent, valeur invalide, profil d’un autre compte', async () => {
    expect((await visibility(alice, 'movie', 404, 'friends')).status).toBe(404);
    await put(alice, 'movie', 1, 'Matrix');
    expect((await visibility(alice, 'movie', 1, 'public')).status).toBe(400);
    expect((await visibility(bob, 'movie', 1, 'friends', alice.profile)).status).toBe(404);
  });
});
