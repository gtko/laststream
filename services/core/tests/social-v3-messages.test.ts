import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Messages v3 : conversations `dm:<pid>` (vue de chacun), charges riches, réactions, sondages, frappe, lecture. */

interface ReactionBody {
  emoji: string;
  count: number;
  mine: boolean;
}

interface PollBody {
  id: string;
  question: string;
  options: { id: string; label: string; votes: number; mine: boolean }[];
  closed: boolean;
}

interface MessageBody {
  id: string;
  conv: string;
  from: string;
  to?: string;
  kind: string;
  body: string;
  context?: { type: string; tmdbId: number; season?: number; episode?: number; pos?: number };
  title?: { type: string; tmdbId: number; title: string; poster?: string; year?: number; rating?: number };
  moment?: { type: string; tmdbId: number; season?: number; episode?: number; title: string; pos: number; still?: string };
  party?: { partyId: string; title: string };
  poll?: PollBody;
  reactions: ReactionBody[];
  replyTo?: string;
  createdAt: number;
  readAt?: number;
}

interface ConversationBody {
  conv: string;
  pid?: string;
  group?: { id: string; name: string; members: { pid: string; household: boolean }[] };
  last?: MessageBody;
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
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Place l'horloge à `ms` après le début du scénario. */
const at = (ms: number): void => {
  vi.setSystemTime(new Date(START + ms));
};

/** Conversation avec le profil `pid`, telle que je la vois. */
const dm = (pid: string): string => `dm:${pid}`;

const sendConv = (who: Acting, conv: string, body: unknown) =>
  as<{ message: MessageBody } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/messages`, { body });
const listConv = (who: Acting, conv: string, query = '') =>
  as<{ messages: MessageBody[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/conv/${conv}/messages${query}`);
const react = (who: Acting, conv: string, id: string, emoji: string) =>
  as<{ reactions: ReactionBody[] } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/messages/${id}/reactions`, { body: { emoji } });
const vote = (who: Acting, conv: string, pollId: string, optionId: string) =>
  as<{ poll: PollBody } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/polls/${pollId}/vote`, { body: { optionId } });
const typing = (who: Acting, conv: string) => as<ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/typing`);
const readConv = (who: Acting, conv: string) => as<ErrorBodyV2>(app, who, 'PUT', `/user/social/conv/${conv}/read`);
const conversationsOf = (who: Acting) =>
  as<{ conversations: ConversationBody[] } & ErrorBodyV2>(app, who, 'GET', '/user/social/conversations');

/** Texte simple, envoyé par `who` à `conv`. */
const text = (who: Acting, conv: string, body: string) => sendConv(who, conv, { kind: 'text', body });

/** Option `index` d'un sondage (identifiant). */
const optionId = (poll: PollBody, index: number): string => poll.options[index]?.id ?? '';

describe('compatibilité v2 : les DM sont la conversation dm:<pid>', () => {
  it('un message envoyé par la route v2 apparaît en v3, vu de chaque côté, avec kind text', async () => {
    at(1_000);
    const sent = await as<{ message: MessageBody }>(app, cast.alice, 'POST', `/user/social/messages/${cast.bob.pid}`, { body: { body: 'v2' } });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ kind: 'text', conv: dm(cast.bob.pid), reactions: [] });

    const v3 = await listConv(cast.bob, dm(cast.alice.pid));
    expect(v3.status).toBe(200);
    expect(v3.body.messages).toHaveLength(1);
    expect(v3.body.messages[0]).toMatchObject({ body: 'v2', kind: 'text', conv: dm(cast.alice.pid), from: cast.alice.pid, to: cast.bob.pid });

    const v2 = await as<{ messages: MessageBody[] }>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(v2.body.messages.map((m) => m.id)).toEqual(v3.body.messages.map((m) => m.id));

    const list = await conversationsOf(cast.bob);
    expect(list.body.conversations.find((c) => c.conv === dm(cast.alice.pid))?.last?.body).toBe('v2');
  });

  it('un message v3 texte apparaît dans la liste v2 et le pair reçoit la vue de sa conversation', async () => {
    const sent = await text(cast.alice, dm(cast.bob.pid), 'salut');
    expect(sent.status).toBe(201);
    expect(sent.body.message.conv).toBe(dm(cast.bob.pid));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.bob.pid]);
    expect(emitted[0]?.event).toMatchObject({ t: 'message', message: { conv: dm(cast.alice.pid), body: 'salut', kind: 'text' } });
    const v2 = await as<{ messages: MessageBody[] }>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(v2.body.messages[0]?.body).toBe('salut');
  });

  it('limite : 30 messages par minute, toutes conversations confondues ; 429 avec Retry-After', async () => {
    for (let i = 0; i < 30; i++) expect((await text(cast.bob, dm(cast.alice.pid), `m${i}`)).status).toBe(201);
    const blocked = await text(cast.bob, dm(cast.alice.pid), 'trop');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('60');
  });
});

describe('charges riches (titre, moment, invitation, sondage)', () => {
  it('titre : vu par le pair avec sa charge ; note sur 5', async () => {
    const title = { type: 'movie', tmdbId: 438631, title: 'Dune', poster: '/dune.jpg', year: 2021, rating: 4.5 };
    const res = await sendConv(cast.alice, dm(cast.bob.pid), { kind: 'title', title });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ kind: 'title', title });
    const seen = await listConv(cast.bob, dm(cast.alice.pid));
    expect(seen.body.messages[0]).toMatchObject({ kind: 'title', title, body: '' });
  });

  it('moment : la saison est ignorée pour un film ; la légende est facultative', async () => {
    const res = await sendConv(cast.alice, dm(cast.bob.pid), {
      kind: 'moment',
      body: 'Ici !',
      moment: { type: 'movie', tmdbId: 438631, season: 2, title: 'Dune', pos: 754, still: '/still.jpg' },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.moment).toEqual({ type: 'movie', tmdbId: 438631, title: 'Dune', pos: 754, still: '/still.jpg' });
    expect(res.body.message.body).toBe('Ici !');
  });

  it('invitation de salon : refusée par /conv (400 kind_not_allowed), seule POST /party/:id/invite en crée', async () => {
    const res = await sendConv(cast.alice, dm(cast.bob.pid), { kind: 'party', party: { partyId: 'abcd1234', title: 'Soirée' } });
    expect(res.status).toBe(400);
    expect((res.body as unknown as { error: string }).error).toBe('kind_not_allowed');
  });

  it('charges invalides refusées (400), sans rien écrire : charge absente, hors kind, champs inconnus, bornes, images, sondage', async () => {
    const title = { type: 'movie', tmdbId: 438631, title: 'Dune' };
    const bad: unknown[] = [
      { kind: 'title' },
      { kind: 'text', body: 'x', title },
      { kind: 'title', title: { ...title, rating: 6 } },
      { kind: 'title', title: { ...title, extra: true } },
      { kind: 'title', title: { ...title, poster: 'https://evil.example/x.jpg' } },
      { kind: 'title', title: { ...title, title: '   ' } },
      { kind: 'title', title: { ...title, title: 'Dune\u0007' } },
      { kind: 'moment', moment: { type: 'series', tmdbId: 1399, title: 'GoT', pos: -1 } },
      { kind: 'party', party: { partyId: 'a b', title: 'Salon' } },
      { kind: 'poll', poll: { question: 'Ça marche ?', options: ['Oui'] } },
      { kind: 'poll', poll: { question: 'Ça marche ?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } },
      { kind: 'poll', poll: { question: 'Ça marche ?', options: ['Oui', 'oui'] } },
      { kind: 'poll', poll: { question: '   ', options: ['Oui', 'Non'] } },
      { kind: 'text' },
      { kind: 'text', body: '' },
      { kind: 'carte', body: 'x' },
      { kind: 'text', body: 'x', extra: 1 },
    ];
    for (const payload of bad) {
      const res = await sendConv(cast.alice, dm(cast.bob.pid), payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
    expect((await listConv(cast.bob, dm(cast.alice.pid))).body.messages).toHaveLength(0);
  });

  it('réponse : vise un message de la même conversation seulement', async () => {
    const first = await text(cast.alice, dm(cast.bob.pid), 'un');
    const reply = await sendConv(cast.bob, dm(cast.alice.pid), { kind: 'text', body: 'deux', replyTo: first.body.message.id });
    expect(reply.status).toBe(201);
    expect(reply.body.message.replyTo).toBe(first.body.message.id);

    const unknown = await sendConv(cast.bob, dm(cast.alice.pid), { kind: 'text', body: 'x', replyTo: 'inconnu' });
    expect(unknown.status).toBe(400);

    const inner = await text(cast.alice, dm(cast.alice2.pid), 'interne');
    const elsewhere = await sendConv(cast.alice, dm(cast.bob.pid), { kind: 'text', body: 'x', replyTo: inner.body.message.id });
    expect(elsewhere.status).toBe(400);
  });
});

describe('sondages : vote unique', () => {
  it('un vote par profil, votes et choix visibles par chacun', async () => {
    const created = await sendConv(cast.alice, dm(cast.bob.pid), { kind: 'poll', poll: { question: 'Ce soir ?', options: ['Oui', 'Non', 'Peut-être'] } });
    expect(created.status).toBe(201);
    const pollId = created.body.message.id;
    expect(created.body.message.poll).toMatchObject({ id: pollId, question: 'Ce soir ?', closed: false });
    expect(created.body.message.poll?.options.map((o) => o.label)).toEqual(['Oui', 'Non', 'Peut-être']);

    emitted.length = 0;
    const first = await vote(cast.bob, dm(cast.alice.pid), pollId, optionId(created.body.message.poll ?? { id: '', question: '', options: [], closed: false }, 0));
    expect(first.status).toBe(200);
    expect(first.body.poll.options[0]).toMatchObject({ votes: 1, mine: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.alice.pid]);
    expect(emitted[0]?.event).toMatchObject({ t: 'poll', conv: dm(cast.bob.pid), poll: { id: pollId } });

    const aliceSees = await listConv(cast.alice, dm(cast.bob.pid));
    expect(aliceSees.body.messages[0]?.poll?.options[0]).toMatchObject({ votes: 1, mine: false });

    const again = await vote(cast.bob, dm(cast.alice.pid), pollId, optionId(first.body.poll, 1));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_voted');

    const other = await vote(cast.alice, dm(cast.bob.pid), pollId, optionId(first.body.poll, 1));
    expect(other.status).toBe(200);
    expect(other.body.poll.options.map((o) => [o.votes, o.mine])).toEqual([
      [1, false],
      [1, true],
      [0, false],
    ]);
  });

  it('option inconnue : 400 ; sondage inconnu ou hors conversation : 404', async () => {
    const created = await sendConv(cast.alice, dm(cast.bob.pid), { kind: 'poll', poll: { question: 'Ce soir ?', options: ['Oui', 'Non'] } });
    const pollId = created.body.message.id;
    const unknownOption = await vote(cast.bob, dm(cast.alice.pid), pollId, 'nope');
    expect(unknownOption.status).toBe(400);
    expect(unknownOption.body.error).toBe('invalid_body');
    expect((await vote(cast.bob, dm(cast.alice.pid), 'inconnu', 'nope')).status).toBe(404);
    const inner = await sendConv(cast.alice, dm(cast.alice2.pid), { kind: 'poll', poll: { question: 'Interne', options: ['A', 'B'] } });
    expect((await vote(cast.bob, dm(cast.alice.pid), inner.body.message.id, optionId(inner.body.message.poll ?? { id: '', question: '', options: [], closed: false }, 0))).status).toBe(404);
  });
});

describe('réactions : bascule, compte et vue par profil', () => {
  it('pose, retire, compte et mine par profil ; emoji invalide refusé', async () => {
    const sent = await text(cast.alice, dm(cast.bob.pid), 'salut');
    const id = sent.body.message.id;

    const mine = await react(cast.alice, dm(cast.bob.pid), id, '👍');
    expect(mine.status).toBe(200);
    expect(mine.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);

    const theirs = await react(cast.bob, dm(cast.alice.pid), id, '👍');
    expect(theirs.body.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect((await listConv(cast.alice, dm(cast.bob.pid))).body.messages[0]?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    const removed = await react(cast.alice, dm(cast.bob.pid), id, '👍');
    expect(removed.body.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);

    const invalid = await react(cast.alice, dm(cast.bob.pid), id, 'abc');
    expect(invalid.status).toBe(400);
    expect(invalid.body.issues).toContain('emoji:not_emoji');
  });

  it('message inconnu ou hors conversation : 404 message_not_found ; les membres reçoivent leur vue', async () => {
    const sent = await text(cast.alice, dm(cast.bob.pid), 'salut');
    const inner = await text(cast.alice, dm(cast.alice2.pid), 'interne');
    expect((await react(cast.alice, dm(cast.bob.pid), 'inconnu', '❤️')).body.error).toBe('message_not_found');
    expect((await react(cast.alice, dm(cast.bob.pid), inner.body.message.id, '❤️')).body.error).toBe('message_not_found');

    emitted.length = 0;
    await react(cast.bob, dm(cast.alice.pid), sent.body.message.id, '🔥');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.alice.pid]);
    expect(emitted[0]?.event).toEqual({
      t: 'reaction',
      conv: dm(cast.bob.pid),
      id: sent.body.message.id,
      reactions: [{ emoji: '🔥', count: 1, mine: false }],
    });
  });
});

describe('frappe : une notification par tranche de 1/3 s, au pair seulement', () => {
  it('limitée par conversation, aux destinataires seulement', async () => {
    at(10_000);
    emitted.length = 0;
    expect((await typing(cast.alice, dm(cast.bob.pid))).status).toBe(204);
    expect(emitted).toEqual([{ pids: [cast.bob.pid], event: { t: 'typing', conv: dm(cast.alice.pid), pid: cast.alice.pid } }]);

    at(10_100);
    const early = await typing(cast.alice, dm(cast.bob.pid));
    expect(early.status).toBe(429);
    expect(early.body.error).toBe('rate_limited');
    expect(emitted).toHaveLength(1);

    at(10_400);
    expect((await typing(cast.alice, dm(cast.bob.pid))).status).toBe(204);
    expect(emitted).toHaveLength(2);
  });
});

describe('lecture de la conversation', () => {
  it('marque lu ; le pair n’est notifié que s’il reste quelque chose à lire', async () => {
    at(20_000);
    await text(cast.alice, dm(cast.bob.pid), 'un');
    emitted.length = 0;
    at(21_000);
    expect((await readConv(cast.bob, dm(cast.alice.pid))).status).toBe(204);
    expect(emitted).toEqual([{ pids: [cast.alice.pid], event: { t: 'read', pid: cast.bob.pid, at: START + 21_000 } }]);
    expect((await readConv(cast.bob, dm(cast.alice.pid))).status).toBe(204);
    expect(emitted).toHaveLength(1);
  });
});

describe('droits et formes de conversation', () => {
  it('non-ami : 403 not_friend partout ; soi-même : 400 self ; pid inconnu : 404 ; forme inconnue : 404 conv_not_found ; profil enfant : 403', async () => {
    const outsider = await listConv(cast.carol, dm(cast.bob.pid));
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe('not_friend');
    expect((await text(cast.carol, dm(cast.bob.pid), 'salut')).body.error).toBe('not_friend');
    expect((await typing(cast.carol, dm(cast.bob.pid))).body.error).toBe('not_friend');
    expect((await readConv(cast.carol, dm(cast.bob.pid))).body.error).toBe('not_friend');

    expect((await listConv(cast.alice, dm(cast.alice.pid))).body.error).toBe('self');
    expect((await listConv(cast.alice, 'dm:AAAAAAAAAAAAAAAA')).body.error).toBe('profile_not_found');
    expect((await listConv(cast.alice, 'xx:12')).body.error).toBe('conv_not_found');
    expect((await listConv(cast.alice, 'g:pas-un-groupe')).body.error).toBe('conv_not_found');

    const kid = await listConv(cast.kid, dm(cast.bob.pid));
    expect(kid.status).toBe(403);
    expect(kid.body.error).toBe('kid_profile');
  });

  it('foyer : un autre profil du même compte échange sans demande d’ami', async () => {
    expect((await text(cast.alice, dm(cast.alice2.pid), 'coucou')).status).toBe(201);
    expect((await listConv(cast.alice2, dm(cast.alice.pid))).body.messages).toHaveLength(1);
  });

  it('pagination : ?before et ?limit bornés comme en v2', async () => {
    for (let i = 1; i <= 3; i++) {
      at(i * 1_000);
      expect((await text(cast.alice, dm(cast.bob.pid), `m${i}`)).status).toBe(201);
    }
    const page = await listConv(cast.bob, dm(cast.alice.pid), `?before=${START + 3_000}&limit=1`);
    expect(page.body.messages.map((m) => m.body)).toEqual(['m2']);
    expect((await listConv(cast.bob, dm(cast.alice.pid), '?limit=51')).body.error).toBe('invalid_body');
  });
});
