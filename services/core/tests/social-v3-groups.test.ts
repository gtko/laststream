import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Groupes v3 : création entre amis, membres seuls, messages et lecture par membre, modification, départ, profil enfant. */

interface GroupMessage {
  id: string;
  conv: string;
  from: string;
  to?: string;
  body: string;
  kind: string;
  reactions: { emoji: string; count: number; mine: boolean }[];
  createdAt: number;
}

interface ConversationBody {
  conv: string;
  pid?: string;
  group?: { id: string; name: string; members: { pid: string; household: boolean }[] };
  last?: GroupMessage;
  unread: number;
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const NOW = '2026-05-01T10:00:00.000Z';
const START = Date.parse(NOW);

const emitted: Emitted[] = [];

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  emitted.length = 0;
  app = await startApp({
    extra: {
      socialEvents: (pids, event) => {
        emitted.push({ pids: [...pids], event });
      },
    },
  });
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
  await befriend(app, cast.alice, cast.carol);
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const at = (ms: number): void => {
  vi.setSystemTime(new Date(START + ms));
};

const createGroup = (who: Acting, body: unknown) => as<ConversationBody & ErrorBodyV2>(app, who, 'POST', '/user/social/groups', { body });
const updateGroup = (who: Acting, id: string, body: unknown) =>
  as<ConversationBody & ErrorBodyV2>(app, who, 'PUT', `/user/social/groups/${id}`, { body });
const leaveGroup = (who: Acting, id: string) => as<ErrorBodyV2>(app, who, 'DELETE', `/user/social/groups/${id}/me`);
const conversationsOf = (who: Acting) =>
  as<{ conversations: ConversationBody[] } & ErrorBodyV2>(app, who, 'GET', '/user/social/conversations');
const sendTo = (who: Acting, id: string, body: string) =>
  as<{ message: GroupMessage } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/g:${id}/messages`, { body: { kind: 'text', body } });
const listGroup = (who: Acting, id: string) => as<{ messages: GroupMessage[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/conv/g:${id}/messages`);

/** Conversation de groupe telle que `who` la voit, dans sa liste. */
async function groupOf(who: Acting, id: string): Promise<ConversationBody | undefined> {
  return (await conversationsOf(who)).body.conversations.find((c) => c.conv === `g:${id}`);
}

/** Groupe créé par alice avec bob et carol. */
async function makeGroup(name = 'Week-end'): Promise<string> {
  const res = await createGroup(cast.alice, { name, members: [cast.bob.pid, cast.carol.pid] });
  expect(res.status).toBe(201);
  return res.body.group?.id ?? '';
}

describe('création (POST /user/social/groups)', () => {
  it('amis seulement : 201 avec la conversation vue du créateur, membres sans lui', async () => {
    const res = await createGroup(cast.alice, { name: 'Week-end', members: [cast.bob.pid, cast.carol.pid] });
    expect(res.status).toBe(201);
    const id = res.body.group?.id ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.conv).toBe(`g:${id}`);
    expect(res.body.group?.name).toBe('Week-end');
    expect(res.body.group?.members.map((m) => m.pid).sort()).toEqual([cast.bob.pid, cast.carol.pid].sort());
    expect(res.body.unread).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain(cast.alice.profile);
  });

  it('refus : non-ami ou foyer 403 not_friend ; moi-même 400 self ; trop peu ou doublons 400 ; nom vide ou trop long 400', async () => {
    expect((await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid, cast.alice2.pid] })).body.error).toBe('not_friend');
    expect((await createGroup(cast.bob, { name: 'G', members: [cast.carol.pid, cast.alice.pid] })).body.error).toBe('not_friend');
    expect((await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid, cast.alice.pid] })).body.error).toBe('self');
    expect((await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid] })).status).toBe(400);
    expect((await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid, cast.bob.pid] })).status).toBe(400);
    expect((await createGroup(cast.alice, { name: '   ', members: [cast.bob.pid, cast.carol.pid] })).status).toBe(400);
    expect((await createGroup(cast.alice, { name: 'x'.repeat(41), members: [cast.bob.pid, cast.carol.pid] })).status).toBe(400);
    expect((await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid, cast.carol.pid], extra: 1 })).status).toBe(400);
    expect((await conversationsOf(cast.alice)).body.conversations.some((c) => c.group !== undefined)).toBe(false);
  });

  it('un kid ne crée rien (403 kid_profile)', async () => {
    const res = await createGroup(cast.kid, { name: 'G', members: [cast.bob.pid, cast.carol.pid] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
  });
});

describe('visibilité : seuls les membres voient et écrivent', () => {
  it('membres : groupe dans leur liste ; non-membre : 404 conv_not_found, y compris pour écrire', async () => {
    const id = await makeGroup();
    expect(await groupOf(cast.bob, id)).toBeDefined();
    expect(await groupOf(cast.carol, id)).toBeDefined();
    expect(await groupOf(cast.alice2, id)).toBeUndefined();

    expect((await listGroup(cast.bob, id)).status).toBe(200);
    const outsider = await listGroup(cast.alice2, id);
    expect(outsider.status).toBe(404);
    expect(outsider.body.error).toBe('conv_not_found');
    expect((await sendTo(cast.alice2, id, 'coucou')).body.error).toBe('conv_not_found');
    expect((await listGroup(cast.bob, 'pas-un-uuid')).body.error).toBe('conv_not_found');
  });

  it('message : vue sans destinataire, notifié aux autres membres seulement, avec la conversation de groupe', async () => {
    const id = await makeGroup();
    at(1_000);
    const sent = await sendTo(cast.alice, id, 'bonjour');
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ conv: `g:${id}`, from: cast.alice.pid, body: 'bonjour', kind: 'text' });
    expect(sent.body.message.to).toBeUndefined();

    const notified = emitted.filter((e) => e.event.t === 'message');
    expect(notified.map((e) => e.pids[0]).sort()).toEqual([cast.bob.pid, cast.carol.pid].sort());
    for (const e of notified) expect(e.event).toMatchObject({ t: 'message', message: { conv: `g:${id}`, body: 'bonjour' } });

    const seen = await listGroup(cast.bob, id);
    expect(seen.body.messages.map((m) => m.body)).toEqual(['bonjour']);
  });

  it('non-lus par membre : le message de chacun compte pour les autres, lecture par membre', async () => {
    const id = await makeGroup();
    at(1_000);
    await sendTo(cast.alice, id, 'un');
    expect((await groupOf(cast.bob, id))?.unread).toBe(1);
    expect((await groupOf(cast.carol, id))?.unread).toBe(1);
    expect((await groupOf(cast.alice, id))?.unread).toBe(0);

    at(2_000);
    expect((await as<ErrorBodyV2>(app, cast.bob, 'PUT', `/user/social/conv/g:${id}/read`)).status).toBe(204);
    expect((await groupOf(cast.bob, id))?.unread).toBe(0);
    expect((await groupOf(cast.carol, id))?.unread).toBe(1);

    at(3_000);
    await sendTo(cast.bob, id, 'deux');
    expect((await groupOf(cast.alice, id))?.unread).toBe(1);
    expect((await groupOf(cast.bob, id))?.unread).toBe(0);
    expect((await groupOf(cast.alice, id))?.last?.body).toBe('deux');
  });

  it('réaction dans un groupe : chaque autre membre reçoit sa vue, le non-membre rien', async () => {
    const id = await makeGroup();
    const sent = await sendTo(cast.alice, id, 'bonjour');
    emitted.length = 0;
    const react = await as<{ reactions: { emoji: string; count: number; mine: boolean }[] } & ErrorBodyV2>(
      app,
      cast.bob,
      'POST',
      `/user/social/conv/g:${id}/messages/${sent.body.message.id}/reactions`,
      { body: { emoji: '🎉' } },
    );
    expect(react.body.reactions).toEqual([{ emoji: '🎉', count: 1, mine: true }]);
    expect(emitted.map((e) => e.pids[0]).sort()).toEqual([cast.alice.pid, cast.carol.pid].sort());
    for (const e of emitted) {
      expect(e.event).toEqual({ t: 'reaction', conv: `g:${id}`, id: sent.body.message.id, reactions: [{ emoji: '🎉', count: 1, mine: false }] });
    }
  });
});

describe('modification (PUT /user/social/groups/:id)', () => {
  it('nom, retrait et ajout d’un ami ; ajout d’un non-ami refusé ; soi-même et corps vide refusés', async () => {
    const id = await makeGroup();

    const renamed = await updateGroup(cast.carol, id, { name: 'Ciné' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group?.name).toBe('Ciné');

    const removed = await updateGroup(cast.alice, id, { remove: [cast.carol.pid] });
    expect(removed.status).toBe(200);
    expect(removed.body.group?.members.map((m) => m.pid)).toEqual([cast.bob.pid]);
    expect(await groupOf(cast.carol, id)).toBeUndefined();

    const readded = await updateGroup(cast.alice, id, { add: [cast.carol.pid] });
    expect(readded.body.group?.members.map((m) => m.pid).sort()).toEqual([cast.bob.pid, cast.carol.pid].sort());

    expect((await updateGroup(cast.alice, id, { add: [cast.alice2.pid] })).body.error).toBe('not_friend');
    expect((await updateGroup(cast.alice, id, { remove: [cast.alice.pid] })).body.error).toBe('self');
    expect((await updateGroup(cast.alice, id, { add: [cast.bob.pid], remove: [cast.bob.pid] })).status).toBe(400);
    expect((await updateGroup(cast.alice, id, { remove: [cast.bob.pid, cast.bob.pid] })).status).toBe(400);
    expect((await updateGroup(cast.alice, id, {})).status).toBe(400);
  });

  it('un non-membre ne modifie rien (404 group_not_found)', async () => {
    const id = await makeGroup();
    const res = await updateGroup(cast.alice2, id, { name: 'Pirate' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('group_not_found');
    expect((await groupOf(cast.bob, id))?.group?.name).toBe('Week-end');
  });
});

describe('départ (DELETE /user/social/groups/:id/me)', () => {
  it('quitter retire l’accès ; le dernier membre qui part supprime le groupe', async () => {
    const id = await makeGroup();
    expect((await leaveGroup(cast.bob, id)).status).toBe(204);
    expect((await listGroup(cast.bob, id)).body.error).toBe('conv_not_found');
    expect(await groupOf(cast.bob, id)).toBeUndefined();
    expect((await leaveGroup(cast.bob, id)).body.error).toBe('group_not_found');
    expect((await groupOf(cast.alice, id))?.group?.members.map((m) => m.pid)).toEqual([cast.carol.pid]);

    expect((await leaveGroup(cast.alice, id)).status).toBe(204);
    expect((await leaveGroup(cast.carol, id)).status).toBe(204);
    expect((await listGroup(cast.carol, id)).body.error).toBe('conv_not_found');
    expect((await conversationsOf(cast.carol)).body.conversations.some((c) => c.conv === `g:${id}`)).toBe(false);
  });

  it('un profil devenu enfant quitte ses groupes sans erreur (identité retirée)', async () => {
    const id = await makeGroup();
    const kid = await as<ErrorBodyV2>(app, cast.bob, 'PATCH', `/user/profiles/${cast.bob.profile}`, { body: { isKid: true } });
    expect(kid.status).toBe(200);
    expect((await groupOf(cast.alice, id))?.group?.members.map((m) => m.pid)).toEqual([cast.carol.pid]);
    expect((await listGroup(cast.alice, id)).status).toBe(200);
  });
});
