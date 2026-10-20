import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { migrate } from '../src/user/migrations.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Réconciliations S1 / S2 / S3a / S3b : partage = vrais messages v3, accès (blocage, messagesFrom) et historique masqué. */

interface Msg {
  id: string;
  conv: string;
  from: string;
  to?: string;
  kind: string;
  body: string;
  title?: { tmdbId: number; title: string };
  moment?: { tmdbId: number; pos: number };
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const MATRIX = { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg' };

const emitted: Emitted[] = [];
let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
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

const share = (who: Acting, body: unknown) => as<{ messages: Msg[] } & ErrorBodyV2>(app, who, 'POST', '/user/social/share', { body });
const convMessages = (who: Acting, conv: string) => as<{ messages: Msg[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/conv/${conv}/messages`);
const convSend = (who: Acting, conv: string, body: unknown) =>
  as<{ message: Msg } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/messages`, { body });
const setPrefs = (who: Acting, body: unknown) => as(app, who, 'PUT', '/user/social/prefs', { body });
const block = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'POST', `/user/social/blocks/${pid}`);

describe('migrations : le payload de partage n a plus de table propre', () => {
  it('message_payloads n existe plus ; les colonnes de messages portent le contenu', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(names).not.toContain('message_payloads');
    expect(names).toEqual(expect.arrayContaining(['messages', 'share_links', 'shared_lists', 'social_groups']));
  });
});

describe('partage : de vrais messages v3', () => {
  it('un titre partagé est un message kind title lisible par /conv, /messages et dans la liste des conversations', async () => {
    const res = await share(cast.alice, { to: [{ pid: cast.bob.pid }], kind: 'title', title: MATRIX, body: 'à voir' });
    expect(res.status).toBe(201);
    expect(res.body.messages[0]).toMatchObject({ conv: `dm:${cast.bob.pid}`, kind: 'title', body: 'à voir', title: { tmdbId: 603, title: 'Matrix' } });

    const viaConv = await convMessages(cast.bob, `dm:${cast.alice.pid}`);
    expect(viaConv.body.messages).toHaveLength(1);
    expect(viaConv.body.messages[0]).toMatchObject({ kind: 'title', from: cast.alice.pid, title: { tmdbId: 603 } });
    const viaV2 = await as<{ messages: Msg[] }>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(viaV2.body.messages[0]?.kind).toBe('title');

    const bobEvents = emitted.filter((entry) => entry.pids.includes(cast.bob.pid) && entry.event.t === 'message');
    expect(bobEvents).toHaveLength(1);
    const conversations = await as<{ conversations: { conv: string; last?: Msg; unread: number }[] }>(app, cast.bob, 'GET', '/user/social/conversations');
    expect(conversations.body.conversations.find((c) => c.conv === `dm:${cast.alice.pid}`)).toMatchObject({ unread: 1, last: { kind: 'title' } });
  });

  it('un moment, vers un ami et un groupe à la fois', async () => {
    const group = await as<{ conv: string }>(app, cast.alice, 'POST', '/user/social/groups', { body: { name: 'Ciné', members: [cast.bob.pid, cast.carol.pid] } });
    expect(group.status).toBe(201);
    const id = group.body.conv.slice(2);
    emitted.length = 0;
    const res = await share(cast.alice, {
      to: [{ pid: cast.bob.pid }, { group: id }],
      kind: 'moment',
      moment: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 754 },
    });
    expect(res.status).toBe(201);
    expect(res.body.messages.map((m) => m.conv).sort()).toEqual([`dm:${cast.bob.pid}`, `g:${id}`].sort());
    expect(res.body.messages.every((m) => m.kind === 'moment' && m.moment?.pos === 754)).toBe(true);

    const inGroup = await convMessages(cast.carol, `g:${id}`);
    expect(inGroup.body.messages).toHaveLength(1);
    expect(inGroup.body.messages[0]).toMatchObject({ kind: 'moment', moment: { tmdbId: 603, pos: 754 } });
    // Bob reçoit un message dans le DM et un dans le groupe ; carol un seul (groupe).
    const messageEvents = (pid: string) => emitted.filter((e) => e.pids.includes(pid) && e.event.t === 'message').length;
    expect(messageEvents(cast.bob.pid)).toBe(2);
    expect(messageEvents(cast.carol.pid)).toBe(1);
  });

  it('un titre ne porte pas un moment (kind et charge doivent concorder)', async () => {
    const res = await share(cast.alice, { to: [{ pid: cast.bob.pid }], kind: 'title', title: MATRIX, moment: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 1 } });
    expect(res.status).toBe(400);
  });
});

describe('accès : /conv/* et /share respectent messagesFrom et le blocage', () => {
  it('messagesFrom « favorites » : ni /conv ni /share ne passent pour un non-favori, et rien n est écrit', async () => {
    await setPrefs(cast.bob, { messagesFrom: 'favorites' });
    const text = await convSend(cast.alice, `dm:${cast.bob.pid}`, { kind: 'text', body: 'salut' });
    expect(text.status).toBe(403);
    expect(text.body.error).toBe('not_allowed');
    const titled = await share(cast.alice, { to: [{ pid: cast.carol.pid }, { pid: cast.bob.pid }], kind: 'title', title: MATRIX });
    expect(titled.status).toBe(403);
    expect(titled.body.error).toBe('not_allowed');
    // Tout ou rien : carol n'a rien reçu non plus.
    expect((await convMessages(cast.carol, `dm:${cast.alice.pid}`)).body.messages).toHaveLength(0);
    expect((await convMessages(cast.alice, `dm:${cast.bob.pid}`)).body.messages).toHaveLength(0);

    // Bob met alice en favori : le message passe.
    expect((await as(app, cast.bob, 'PUT', `/user/social/friends/${cast.alice.pid}/relation`, { body: { favorite: true } })).status).toBe(200);
    expect((await convSend(cast.alice, `dm:${cast.bob.pid}`, { kind: 'text', body: 'salut' })).status).toBe(201);
    expect((await share(cast.alice, { to: [{ pid: cast.bob.pid }], kind: 'title', title: MATRIX })).status).toBe(201);
  });

  it('blocage : le profil bloqué est invisible sur /conv et /share, dans les deux sens', async () => {
    expect((await block(cast.bob, cast.alice.pid)).status).toBe(204);
    for (const [who, other] of [
      [cast.alice, cast.bob],
      [cast.bob, cast.alice],
    ] as const) {
      expect((await convMessages(who, `dm:${other.pid}`)).status).toBe(404);
      expect((await convSend(who, `dm:${other.pid}`, { kind: 'text', body: 'x' })).status).toBe(404);
      expect((await as(app, who, 'POST', `/user/social/conv/dm:${other.pid}/typing`)).status).toBe(404);
      expect((await share(who, { to: [{ pid: other.pid }], kind: 'title', title: MATRIX })).status).toBe(404);
    }
  });
});

describe('profil d un ami : historyVisible', () => {
  it('heures regardées et notes sont retirées quand l ami masque son historique', async () => {
    const before = await as<{ stats: Record<string, number> }>(app, cast.alice, 'GET', `/user/social/friends/${cast.bob.pid}/profile`);
    expect(before.body.stats).toEqual({ hoursWatched: 0, notes: 0, friends: 1 });
    await setPrefs(cast.bob, { historyVisible: false });
    const hidden = await as<{ stats: Record<string, number> }>(app, cast.alice, 'GET', `/user/social/friends/${cast.bob.pid}/profile`);
    expect(hidden.body.stats).toEqual({ friends: 1 });
    // Son propre profil reste complet.
    const mine = await as<{ stats: Record<string, number> }>(app, cast.bob, 'GET', '/user/social/profile');
    expect(mine.body.stats).toEqual({ hoursWatched: 0, notes: 0, friends: 1 });
  });
});
