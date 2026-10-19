import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, castOf, type Cast, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Listes partagées (S3b) : membres = amis du propriétaire, éléments, écritures réservées au propriétaire, WS `list`. */

interface ListDetail {
  id: string;
  name: string;
  members: { pid: string; household: boolean }[];
  items: { type: string; tmdbId: number; title: string; addedBy: string }[];
}

interface ListSummary {
  id: string;
  name: string;
  count: number;
  members: { pid: string }[];
}

interface Captured {
  pids: string[];
  event: { t: string; listId?: string };
}

let app: RunningApp;
let captured: Captured[];

beforeEach(async () => {
  captured = [];
  app = await startApp({
    extra: {
      socialEvents: (pids, event) => {
        captured.push({ pids: [...pids], event: event as Captured['event'] });
      },
    },
  });
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const FILM = { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg' };

describe('listes partagées', () => {
  let cast: Cast;

  beforeEach(async () => {
    cast = await castOf(app);
    await befriend(app, cast.alice, cast.bob);
  }, HOOK_TIMEOUT_MS);

  /** Crée une liste d'Alice avec Bob pour membre ; renvoie son identifiant. */
  async function createSharedList(): Promise<string> {
    const created = await as<ListDetail>(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'Ce soir', members: [cast.bob.pid] } });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  it('création : le propriétaire et les amis membres ; un non-ami est refusé sans rien créer', async () => {
    const refused = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'Refusée', members: [cast.carol.pid] } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_friend');
    const none = await as<{ lists: ListSummary[] }>(app, cast.alice, 'GET', '/user/social/lists');
    expect(none.body.lists).toHaveLength(0);

    const id = await createSharedList();
    const detail = await as<ListDetail>(app, cast.alice, 'GET', `/user/social/lists/${id}`);
    expect(detail.body).toMatchObject({ name: 'Ce soir', items: [] });
    expect(detail.body.members.map((member) => member.pid).sort()).toEqual([cast.alice.pid, cast.bob.pid].sort());
  });

  it('un membre voit la liste et y ajoute un titre ; le propriétaire le voit avec son auteur', async () => {
    const id = await createSharedList();
    const bobLists = await as<{ lists: ListSummary[] }>(app, cast.bob, 'GET', '/user/social/lists');
    expect(bobLists.body.lists.map((list) => list.id)).toEqual([id]);

    const added = await as<{ item: { addedBy: string } }>(app, cast.bob, 'POST', `/user/social/lists/${id}/items`, { body: FILM });
    expect(added.status).toBe(201);
    expect(added.body.item.addedBy).toBe(cast.bob.pid);

    const owner = await as<ListDetail>(app, cast.alice, 'GET', `/user/social/lists/${id}`);
    expect(owner.body.items).toHaveLength(1);
    expect(owner.body.items[0]).toMatchObject({ type: 'movie', tmdbId: 603, title: 'Matrix', addedBy: cast.bob.pid });
    const summary = await as<{ lists: ListSummary[] }>(app, cast.alice, 'GET', '/user/social/lists');
    expect(summary.body.lists[0]?.count).toBe(1);
  });

  it('un titre déjà présent est refusé ; un membre retire un titre ; un second retrait est inconnu', async () => {
    const id = await createSharedList();
    await as(app, cast.alice, 'POST', `/user/social/lists/${id}/items`, { body: FILM });
    const again = await as<{ error: string }>(app, cast.bob, 'POST', `/user/social/lists/${id}/items`, { body: FILM });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('item_exists');

    const removed = await as(app, cast.bob, 'DELETE', `/user/social/lists/${id}/items/movie/603`);
    expect(removed.status).toBe(204);
    const gone = await as<{ error: string }>(app, cast.bob, 'DELETE', `/user/social/lists/${id}/items/movie/603`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('item_not_found');
  });

  it('un profil hors de la liste n’en voit rien : 404 partout', async () => {
    const id = await createSharedList();
    const detail = await as<{ error: string }>(app, cast.carol, 'GET', `/user/social/lists/${id}`);
    expect(detail.status).toBe(404);
    expect(detail.body.error).toBe('list_not_found');
    const item = await as<{ error: string }>(app, cast.carol, 'POST', `/user/social/lists/${id}/items`, { body: FILM });
    expect(item.status).toBe(404);
    const lists = await as<{ lists: ListSummary[] }>(app, cast.carol, 'GET', '/user/social/lists');
    expect(lists.body.lists).toHaveLength(0);
  });

  it('seul le propriétaire renomme, change les membres ou supprime ; un ajout exige l’amitié', async () => {
    const id = await createSharedList();
    const byMember = await as<{ error: string }>(app, cast.bob, 'PUT', `/user/social/lists/${id}`, { body: { name: 'Mienne' } });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error).toBe('owner_only');
    const byMemberDelete = await as<{ error: string }>(app, cast.bob, 'DELETE', `/user/social/lists/${id}`);
    expect(byMemberDelete.body.error).toBe('owner_only');

    const notFriend = await as<{ error: string }>(app, cast.alice, 'PUT', `/user/social/lists/${id}`, { body: { add: [cast.carol.pid] } });
    expect(notFriend.status).toBe(403);
    expect(notFriend.body.error).toBe('not_friend');

    await befriend(app, cast.alice, cast.carol);
    const renamed = await as<ListDetail>(app, cast.alice, 'PUT', `/user/social/lists/${id}`, { body: { name: 'Samedi', add: [cast.carol.pid] } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Samedi');
    expect(renamed.body.members.map((member) => member.pid)).toContain(cast.carol.pid);
  });

  it('retirer un membre le fait sortir ; un ami qui n’est plus ami perd l’accès', async () => {
    const id = await createSharedList();
    const removed = await as<ListDetail>(app, cast.alice, 'PUT', `/user/social/lists/${id}`, { body: { remove: [cast.bob.pid] } });
    expect(removed.status).toBe(200);
    expect((await as(app, cast.bob, 'GET', `/user/social/lists/${id}`)).status).toBe(404);

    await as<ListDetail>(app, cast.alice, 'PUT', `/user/social/lists/${id}`, { body: { add: [cast.bob.pid] } });
    expect((await as(app, cast.bob, 'GET', `/user/social/lists/${id}`)).status).toBe(200);
    const unfriended = await as(app, cast.alice, 'DELETE', `/user/social/friends/${cast.bob.pid}`);
    expect(unfriended.status).toBe(204);
    expect((await as(app, cast.bob, 'GET', `/user/social/lists/${id}`)).status).toBe(404);
    const alice = await as<ListDetail>(app, cast.alice, 'GET', `/user/social/lists/${id}`);
    expect(alice.body.members.map((member) => member.pid)).toEqual([cast.alice.pid]);
  });

  it('suppression par le propriétaire : la liste disparaît pour tous', async () => {
    const id = await createSharedList();
    expect((await as(app, cast.alice, 'DELETE', `/user/social/lists/${id}`)).status).toBe(204);
    expect((await as(app, cast.alice, 'GET', `/user/social/lists/${id}`)).status).toBe(404);
    expect((await as(app, cast.bob, 'GET', `/user/social/lists/${id}`)).status).toBe(404);
  });

  it('chaque écriture diffuse {t:"list", listId} à l’audience, y compris un membre qui vient d’être retiré', async () => {
    const id = await createSharedList();
    const created = captured.filter((entry) => entry.event.t === 'list' && entry.event.listId === id);
    expect(created.flatMap((entry) => entry.pids).sort()).toEqual([cast.alice.pid, cast.bob.pid].sort());

    captured = [];
    await as(app, cast.alice, 'PUT', `/user/social/lists/${id}`, { body: { remove: [cast.bob.pid] } });
    const removal = captured.filter((entry) => entry.event.t === 'list');
    expect(removal).toHaveLength(1);
    expect(removal[0]?.pids.sort()).toEqual([cast.alice.pid, cast.bob.pid].sort());

    captured = [];
    await as(app, cast.alice, 'POST', `/user/social/lists/${id}/items`, { body: FILM });
    expect(captured.filter((entry) => entry.event.t === 'list').map((entry) => entry.pids)).toEqual([[cast.alice.pid]]);
  });
});
