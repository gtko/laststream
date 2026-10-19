import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { liveFrame } from '../src/user/social-v2-live.js';
import type { FriendView } from '../src/user/social-v2-store.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';
import { request } from './user-harness.js';

/** Préférences, relations, blocages, signalements et demandes de rejoindre (contrat S2). Chaque règle a son test. */

interface ViewBody {
  pid: string;
  handle: { name: string; tag: string; full: string };
  status: string;
  household: boolean;
  favorite: boolean;
  muted: boolean;
  nickname?: string;
  watching?: { type: string; tmdbId: number; title: string; pos?: number; at?: number; paused: boolean };
  lastSeen?: number;
}

interface FriendsBody extends ErrorBodyV2 {
  friends: ViewBody[];
  household: ViewBody[];
  incoming: { pid: string }[];
  outgoing: { pid: string }[];
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const NOW = '2026-05-01T10:00:00.000Z';

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
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const prefsOf = (who: Acting) => as<Record<string, unknown> & ErrorBodyV2>(app, who, 'GET', '/user/social/prefs');
const setPrefs = (who: Acting, body: Record<string, unknown>) => as<Record<string, unknown> & ErrorBodyV2>(app, who, 'PUT', '/user/social/prefs', { body });
const friendsOf = (who: Acting) => as<FriendsBody>(app, who, 'GET', '/user/social/friends');
/** Vue de `pid` telle que `who` la reçoit dans sa liste (amis ou foyer). */
const viewOf = async (who: Acting, pid: string): Promise<ViewBody | undefined> => {
  const list = (await friendsOf(who)).body;
  return [...list.friends, ...list.household].find((view) => view.pid === pid);
};
const relation = (who: Acting, pid: string, body: Record<string, unknown>) =>
  as<ViewBody & ErrorBodyV2>(app, who, 'PUT', `/user/social/friends/${pid}/relation`, { body });
const beat = (who: Acting, watching?: Record<string, unknown>) =>
  as<ErrorBodyV2>(app, who, 'PUT', '/user/social/presence', { body: watching === undefined ? {} : { watching } });
const watchingNow = () => ({ type: 'series', tmdbId: 1399, title: 'Game of Thrones', season: 2, episode: 4, pos: 754, paused: false, at: Date.now() });
const sendTo = (who: Acting, pid: string, body = 'salut') => as<ErrorBodyV2>(app, who, 'POST', `/user/social/messages/${pid}`, { body: { body } });
const threadWith = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'GET', `/user/social/messages/${pid}`);
const askFriend = (from: Persona, to: Persona) => as<ErrorBodyV2>(app, from, 'POST', '/user/social/requests', { body: { handle: to.full } });
const libraryOf = (who: Persona, pid: string) => as<{ items: unknown[]; total: number } & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/library`);
const historyOf = (who: Persona, pid: string) => as<{ items: unknown[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/history`);
const block = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'POST', `/user/social/blocks/${pid}`);
const unblock = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'DELETE', `/user/social/blocks/${pid}`);
const report = (who: Acting, body: Record<string, unknown>) => as<ErrorBodyV2>(app, who, 'POST', '/user/social/reports', { body });
const joinRequest = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'POST', `/user/social/friends/${pid}/join-request`);
const joinAnswer = (who: Acting, pid: string, body: Record<string, unknown>) =>
  as<ErrorBodyV2>(app, who, 'POST', `/user/social/join-requests/${pid}`, { body });
const putTitle = (type: 'movie' | 'series', tmdbId: number, title: string) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/library/${type}/${tmdbId}`, { token: cast.alice.token, body: { title } });
const setVisibility = (type: 'movie' | 'series', tmdbId: number, visibility: 'private' | 'friends') =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/library/${type}/${tmdbId}/visibility`, { token: cast.alice.token, body: { visibility } });
const writeProgress = (body: Record<string, unknown>) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/progress`, { token: cast.alice.token, body });

describe('préférences (GET / PUT /user/social/prefs)', () => {
  it('défauts : friends, ask, friends, friends, historique visible, anti-spoiler, all, notifications par défaut', async () => {
    const res = await prefsOf(cast.alice);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      activityVisibility: 'friends',
      watchWith: 'ask',
      libraryVisibility: 'friends',
      messagesFrom: 'friends',
      historyVisible: true,
      antiSpoiler: true,
      playbackSocial: 'all',
      notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
    });
  });

  it('PUT partiel : fusion avec l’existant, notify partiel, valeurs hors contrat refusées', async () => {
    const res = await setPrefs(cast.alice, { activityVisibility: 'nobody', notify: { sound: true } });
    expect(res.status).toBe(200);
    expect(res.body.activityVisibility).toBe('nobody');
    expect(res.body.watchWith).toBe('ask');
    expect(res.body.notify).toEqual({ messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: true });
    expect((await prefsOf(cast.alice)).body.activityVisibility).toBe('nobody');
    // Les préférences sont par profil : alice2 (foyer) garde les défauts.
    expect((await prefsOf(cast.alice2)).body.activityVisibility).toBe('friends');
    expect((await setPrefs(cast.alice, { watchWith: 'maybe' })).body.error).toBe('invalid_body');
    expect((await setPrefs(cast.alice, { inconnu: 1 })).body.error).toBe('invalid_body');
  });
});

describe('relations par ami (PUT /user/social/friends/:pid/relation)', () => {
  it('favori, surnom et sourdine : FriendView, relu par GET /friends, propre à chaque sens', async () => {
    const res = await relation(cast.alice, cast.bob.pid, { favorite: true, nickname: 'Bobby', muted: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pid: cast.bob.pid, household: false, favorite: true, nickname: 'Bobby', muted: true });
    expect(await viewOf(cast.alice, cast.bob.pid)).toMatchObject({ favorite: true, nickname: 'Bobby', muted: true });
    // La relation est posée par alice : bob ne voit pas ses réglages.
    expect(await viewOf(cast.bob, cast.alice.pid)).toMatchObject({ favorite: false, muted: false });
    expect((await viewOf(cast.bob, cast.alice.pid))?.nickname).toBeUndefined();
  });

  it('surnom vide : effacé ; surnom de plus de 32 caractères : refusé ; hors amis ou foyer : 404', async () => {
    await relation(cast.alice, cast.bob.pid, { nickname: 'Bobby' });
    const cleared = await relation(cast.alice, cast.bob.pid, { nickname: '   ' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.nickname).toBeUndefined();
    expect((await relation(cast.alice, cast.bob.pid, { nickname: 'x'.repeat(33) })).body.error).toBe('invalid_body');
    expect((await relation(cast.alice, cast.carol.pid, { favorite: true })).body.error).toBe('friend_not_found');
    expect((await relation(cast.alice, cast.alice2.pid, { favorite: true })).body.error).toBe('friend_not_found');
  });
});

describe('visibilité de l’activité et du titre en cours', () => {
  it('défaut : l’ami voit le titre en cours avec sa position et son heure', async () => {
    await beat(cast.alice, watchingNow());
    const view = await viewOf(cast.bob, cast.alice.pid);
    expect(view?.status).toBe('online');
    expect(view?.watching).toMatchObject({ tmdbId: 1399, pos: 754, paused: false });
    expect(view?.watching?.at).toBeDefined();
    expect(view?.lastSeen).toBeDefined();
  });

  it('activityVisibility « nobody » : titre et dernière activité masqués pour les amis, pas pour le foyer', async () => {
    await setPrefs(cast.alice, { activityVisibility: 'nobody' });
    await beat(cast.alice, watchingNow());
    const friend = await viewOf(cast.bob, cast.alice.pid);
    expect(friend?.status).toBe('online');
    expect(friend?.watching).toBeUndefined();
    expect(friend?.lastSeen).toBeUndefined();
    expect((await viewOf(cast.alice2, cast.alice.pid))?.watching).toMatchObject({ pos: 754 });
  });

  it('activityVisibility « favorites » : visible seulement pour les amis que alice a mis en favori', async () => {
    await setPrefs(cast.alice, { activityVisibility: 'favorites' });
    await beat(cast.alice, watchingNow());
    expect((await viewOf(cast.bob, cast.alice.pid))?.watching).toBeUndefined();
    await relation(cast.alice, cast.bob.pid, { favorite: true });
    expect((await viewOf(cast.bob, cast.alice.pid))?.watching).toMatchObject({ pos: 754 });
  });

  it('watchWith « never » : titre visible sans position ni heure', async () => {
    await setPrefs(cast.alice, { watchWith: 'never' });
    await beat(cast.alice, watchingNow());
    const view = await viewOf(cast.bob, cast.alice.pid);
    expect(view?.watching).toMatchObject({ type: 'series', tmdbId: 1399, title: 'Game of Thrones', paused: false });
    expect(view?.watching?.pos).toBeUndefined();
    expect(view?.watching?.at).toBeUndefined();
  });

  it('présence temps réel : la trame suit les mêmes règles que GET /friends', async () => {
    await setPrefs(cast.alice, { watchWith: 'never' });
    await beat(cast.alice, watchingNow());
    const frame = emitted.find((item) => item.event.t === 'presence' && item.pids.includes(cast.bob.pid));
    expect(frame?.event).toMatchObject({ t: 'presence', friend: { pid: cast.alice.pid, household: false, favorite: false, muted: false } });
    const watching = frame?.event.t === 'presence' ? frame.event.friend.watching : undefined;
    expect(watching?.pos).toBeUndefined();
    expect(watching?.at).toBeUndefined();
  });
});

describe('bibliothèque et historique', () => {
  it('libraryVisibility hors « friends » : la bibliothèque est vide pour un ami, le foyer voit tout', async () => {
    await putTitle('movie', 603, 'Matrix');
    await setVisibility('movie', 603, 'friends');
    expect((await libraryOf(cast.bob, cast.alice.pid)).body.total).toBe(1);
    await setPrefs(cast.alice, { libraryVisibility: 'household' });
    const friend = await libraryOf(cast.bob, cast.alice.pid);
    expect(friend.status).toBe(200);
    expect(friend.body).toMatchObject({ items: [], total: 0 });
    expect((await libraryOf(cast.alice2, cast.alice.pid)).body.total).toBe(1);
  });

  it('historyVisible faux : 403 hidden pour un ami, le foyer voit encore l’historique', async () => {
    await writeProgress({ type: 'movie', tmdbId: 603, positionSec: 120, durationSec: 7200 });
    expect((await historyOf(cast.bob, cast.alice.pid)).body.items).toHaveLength(1);
    await setPrefs(cast.alice, { historyVisible: false });
    const hidden = await historyOf(cast.bob, cast.alice.pid);
    expect(hidden.status).toBe(403);
    expect(hidden.body.error).toBe('hidden');
    expect((await historyOf(cast.alice2, cast.alice.pid)).status).toBe(200);
  });
});

describe('messages : messagesFrom', () => {
  it('« favorites » : un ami non favori est refusé (403 not_allowed), le foyer passe toujours', async () => {
    await setPrefs(cast.alice, { messagesFrom: 'favorites' });
    const refused = await sendTo(cast.bob, cast.alice.pid);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_allowed');
    expect((await sendTo(cast.alice2, cast.alice.pid)).status).toBe(201);
    await relation(cast.alice, cast.bob.pid, { favorite: true });
    expect((await sendTo(cast.bob, cast.alice.pid)).status).toBe(201);
  });

  it('« household » : seul le foyer écrit ; « friends » (défaut) accepte les amis', async () => {
    expect((await sendTo(cast.bob, cast.alice.pid)).status).toBe(201);
    await setPrefs(cast.alice, { messagesFrom: 'household' });
    expect((await sendTo(cast.bob, cast.alice.pid)).body.error).toBe('not_allowed');
    expect((await sendTo(cast.alice2, cast.alice.pid)).status).toBe(201);
    // Le refus n'écrit rien : la conversation avec bob ne garde que le premier message.
    const thread = await as<{ messages: unknown[] }>(app, cast.alice, 'GET', `/user/social/messages/${cast.bob.pid}`);
    expect(thread.body.messages).toHaveLength(1);
  });
});

describe('blocage (POST / GET / DELETE /user/social/blocks)', () => {
  it('bloquer retire l’amitié dans les deux sens et prévient les deux profils', async () => {
    const res = await block(cast.alice, cast.bob.pid);
    expect(res.status).toBe(204);
    expect(emitted.filter((item) => item.event.t === 'unfriend').map((item) => [item.pids, item.event])).toEqual([
      [[cast.bob.pid], { t: 'unfriend', pid: cast.alice.pid }],
      [[cast.alice.pid], { t: 'unfriend', pid: cast.bob.pid }],
    ]);
    expect((await friendsOf(cast.alice)).body.friends).toEqual([]);
    expect((await friendsOf(cast.bob)).body.friends).toEqual([]);
  });

  it('invisibles l’un pour l’autre : demandes, messages, bibliothèque, historique', async () => {
    await block(cast.alice, cast.bob.pid);
    expect((await askFriend(cast.bob, cast.alice)).body.error).toBe('handle_not_found');
    expect((await askFriend(cast.alice, cast.bob)).body.error).toBe('handle_not_found');
    expect((await sendTo(cast.bob, cast.alice.pid)).body.error).toBe('profile_not_found');
    expect((await sendTo(cast.alice, cast.bob.pid)).body.error).toBe('profile_not_found');
    expect((await threadWith(cast.bob, cast.alice.pid)).body.error).toBe('profile_not_found');
    expect((await libraryOf(cast.bob, cast.alice.pid)).body.error).toBe('friend_not_found');
    expect((await historyOf(cast.alice, cast.bob.pid)).body.error).toBe('friend_not_found');
    expect((await friendsOf(cast.bob)).body.incoming).toEqual([]);
  });

  it('présence : le bloqué ne reçoit plus les changements de présence', async () => {
    await block(cast.alice, cast.bob.pid);
    emitted.length = 0;
    await beat(cast.alice, watchingNow());
    expect(emitted.filter((item) => item.pids.includes(cast.bob.pid))).toEqual([]);
  });

  it('les demandes en attente disparaissent dans les deux sens ; une demande reçue ne peut plus être acceptée', async () => {
    await askFriend(cast.carol, cast.alice);
    expect((await friendsOf(cast.alice)).body.incoming.map((item) => item.pid)).toEqual([cast.carol.pid]);
    await block(cast.alice, cast.carol.pid);
    expect((await friendsOf(cast.alice)).body.incoming).toEqual([]);
    expect((await friendsOf(cast.carol)).body.outgoing).toEqual([]);
    const accept = await as(app, cast.alice, 'POST', `/user/social/requests/${cast.carol.pid}/accept`);
    expect(accept.status).toBe(404);
  });

  it('débloquer : liste, 204, puis 404 ; l’amitié n’est pas rétablie', async () => {
    await block(cast.alice, cast.bob.pid);
    const list = await as<{ blocked: { pid: string; handle: { full: string } }[] }>(app, cast.alice, 'GET', '/user/social/blocks');
    expect(list.body.blocked).toEqual([{ pid: cast.bob.pid, handle: expect.objectContaining({ full: cast.bob.full }) }]);
    expect((await unblock(cast.alice, cast.bob.pid)).status).toBe(204);
    expect((await unblock(cast.alice, cast.bob.pid)).body.error).toBe('block_not_found');
    expect((await friendsOf(cast.alice)).body.friends).toEqual([]);
  });

  it('erreurs : soi-même 400, foyer 400, profil inconnu 404', async () => {
    expect((await block(cast.alice, cast.alice.pid)).body.error).toBe('self');
    expect((await block(cast.alice, cast.alice2.pid)).body.error).toBe('household');
    expect((await block(cast.alice, 'AAAAAAAAAAAAAAAA')).status).toBe(404);
  });
});

describe('signalements (POST /user/social/reports)', () => {
  it('201 sans corps, y compris pour un profil sans lien', async () => {
    const res = await report(cast.carol, { pid: cast.bob.pid, reason: 'spam', details: 'liens répétés' });
    expect(res.status).toBe(201);
  });

  it('soi-même 400, profil inconnu 404, motif hors liste 400, détails trop longs 400', async () => {
    expect((await report(cast.carol, { pid: cast.carol.pid, reason: 'other' })).body.error).toBe('self');
    expect((await report(cast.carol, { pid: 'AAAAAAAAAAAAAAAA', reason: 'other' })).status).toBe(404);
    expect((await report(cast.carol, { pid: cast.bob.pid, reason: 'bizarre' })).body.error).toBe('invalid_body');
    expect((await report(cast.carol, { pid: cast.bob.pid, reason: 'other', details: 'x'.repeat(501) })).body.error).toBe('invalid_body');
  });
});

describe('demande de rejoindre (join-request, join-requests/:pid)', () => {
  it('l’ami reçoit join_request avec la vue du demandeur', async () => {
    const res = await joinRequest(cast.bob, cast.alice.pid);
    expect(res.status).toBe(204);
    expect(emitted).toEqual([
      expect.objectContaining({
        pids: [cast.alice.pid],
        event: expect.objectContaining({ t: 'join_request', from: expect.objectContaining({ pid: cast.bob.pid, household: false }) }),
      }),
    ]);
  });

  it('watchWith « never » : 403 not_allowed ; sans lien : 404 friend_not_found', async () => {
    await setPrefs(cast.alice, { watchWith: 'never' });
    expect((await joinRequest(cast.bob, cast.alice.pid)).body.error).toBe('not_allowed');
    await setPrefs(cast.alice, { watchWith: 'ask' });
    expect((await joinRequest(cast.carol, cast.alice.pid)).body.error).toBe('friend_not_found');
    expect(emitted).toEqual([]);
  });

  it('réponse de l’hôte : le demandeur reçoit join_answer ; sans demande en attente : 404', async () => {
    await joinRequest(cast.bob, cast.alice.pid);
    emitted.length = 0;
    expect((await joinAnswer(cast.alice, cast.bob.pid, { accept: true, partyId: 'salon-42' })).status).toBe(204);
    expect(emitted).toEqual([
      { pids: [cast.bob.pid], event: { t: 'join_answer', pid: cast.alice.pid, accept: true, partyId: 'salon-42' } },
    ]);
    expect((await joinAnswer(cast.alice, cast.bob.pid, { accept: false })).body.error).toBe('request_not_found');
  });

  it('un blocage annule la demande en attente', async () => {
    await joinRequest(cast.bob, cast.alice.pid);
    await block(cast.alice, cast.bob.pid);
    expect((await joinAnswer(cast.alice, cast.bob.pid, { accept: true })).body.error).toBe('request_not_found');
  });
});

describe('trames temps réel des demandes de rejoindre', () => {
  it('join_request porte la vue du demandeur ; join_answer ne porte partyId que s’il est donné', () => {
    const from: FriendView = {
      pid: 'BBBBBBBBBBBBBBBB',
      handle: { name: 'bob', tag: 'A7K2', full: 'bob#A7K2' },
      avatarColor: '#3366ff',
      household: false,
      favorite: false,
      muted: false,
      status: 'offline',
    };
    expect(liveFrame({ t: 'join_request', from })).toEqual({ t: 'join_request', from });
    const answer = liveFrame({ t: 'join_answer', pid: 'AAAAAAAAAAAAAAAA', accept: false });
    expect(answer).toEqual({ t: 'join_answer', pid: 'AAAAAAAAAAAAAAAA', accept: false });
    expect(Object.keys(answer)).not.toContain('partyId');
    expect(liveFrame({ t: 'join_answer', pid: 'AAAAAAAAAAAAAAAA', accept: true, partyId: 'salon-42' })).toEqual({
      t: 'join_answer',
      pid: 'AAAAAAAAAAAAAAAA',
      accept: true,
      partyId: 'salon-42',
    });
  });
});
