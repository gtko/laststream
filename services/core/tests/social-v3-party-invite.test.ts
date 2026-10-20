import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartyBackend, PartyRoomStub } from '../src/party/backend.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Réconciliation S4 / S3a : POST /party/:id/invite {pid} dépose un message v3 kind « party » dans le DM. */

const ROOM = 'abcdefghijklmnop1234';

interface Msg {
  id: string;
  conv: string;
  from: string;
  to?: string;
  kind: string;
  body: string;
  party?: { partyId: string; title: string };
}

/** Salon simulé : alice y est connectée, le titre contient un caractère de contrôle à nettoyer. */
function stubParty(): PartyBackend {
  const stub = {
    info: () => Promise.resolve({ id: ROOM, title: 'Soirée\u0007 Matrix', media: { type: 'movie', tmdbId: 603, season: null, episode: null } }),
    connected: () => Promise.resolve(true),
  } as unknown as PartyRoomStub;
  return { room: () => stub };
}

const emitted: { pids: string[]; event: SocialEvent }[] = [];
let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  emitted.length = 0;
  app = await startApp({
    extra: {
      party: stubParty(),
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
  await app.close();
});

const invite = (pid: string) =>
  as<{ message: Msg } & ErrorBodyV2>(app, cast.alice, 'POST', `/party/${ROOM}/invite`, { body: { pid } });

describe('invitation d un ami à un salon', () => {
  it('crée un message v3 kind party dans le DM, lisible par /conv, et diffuse party_invite', async () => {
    const res = await invite(cast.bob.pid);
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ conv: `dm:${cast.bob.pid}`, kind: 'party', party: { partyId: ROOM, title: 'Soirée  Matrix' } });

    const inbox = await as<{ messages: Msg[] }>(app, cast.bob, 'GET', `/user/social/conv/dm:${cast.alice.pid}/messages`);
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0]).toMatchObject({ kind: 'party', from: cast.alice.pid, party: { partyId: ROOM } });

    const toBob = emitted.filter((entry) => entry.pids.includes(cast.bob.pid)).map((entry) => entry.event.t);
    expect(toBob).toEqual(['message', 'party_invite']);
  });

  it('respecte messagesFrom et le blocage comme les autres messages', async () => {
    await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { messagesFrom: 'favorites' } });
    const refused = await invite(cast.bob.pid);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_allowed');

    await as(app, cast.bob, 'POST', `/user/social/blocks/${cast.alice.pid}`);
    const blocked = await invite(cast.bob.pid);
    expect(blocked.status).toBe(404);
    expect(emitted.filter((entry) => entry.event.t === 'party_invite')).toHaveLength(0);
  });

  it('un non-ami est refusé (403 not_friend)', async () => {
    const res = await invite(cast.carol.pid);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_friend');
  });
});
