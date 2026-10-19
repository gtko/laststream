import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

interface MessageBody {
  id: string;
  from: string;
  to: string;
  body: string;
  context?: { type: string; tmdbId: number; season?: number; episode?: number; pos?: number };
  createdAt: number;
  readAt?: number;
}

interface ConversationBody {
  pid: string;
  handle: { name: string; tag: string; full: string };
  avatarColor: string;
  last?: MessageBody;
  unread: number;
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const NOW = '2026-05-01T10:00:00.000Z';
const START = Date.parse(NOW);

/** Événements émis pendant le test (gestionnaire injecté dans l'application). */
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

const send = (who: Acting, pid: string, body: unknown) =>
  as<{ message: MessageBody } & ErrorBodyV2>(app, who, 'POST', `/user/social/messages/${pid}`, { body });
const thread = (who: Acting, pid: string, query = '') =>
  as<{ messages: MessageBody[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/messages/${pid}${query}`);
const markRead = (who: Acting, pid: string) => as<ErrorBodyV2>(app, who, 'PUT', `/user/social/messages/${pid}/read`);
const conversationsOf = (who: Acting) =>
  as<{ conversations: ConversationBody[] } & ErrorBodyV2>(app, who, 'GET', '/user/social/conversations');

describe('conversations (GET /user/social/conversations)', () => {
  it('amis et foyer seulement, avec le dernier message et les non-lus', async () => {
    at(1_000);
    expect((await send(cast.alice, cast.bob.pid, { body: 'salut' })).status).toBe(201);
    at(2_000);
    expect((await send(cast.bob, cast.alice.pid, { body: 'hey' })).status).toBe(201);

    const list = await conversationsOf(cast.alice);
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((c) => c.pid)).toEqual([cast.bob.pid, cast.alice2.pid]);
    const bob = list.body.conversations[0];
    expect(bob?.handle.full).toBe(cast.bob.full);
    expect(bob?.last?.body).toBe('hey');
    expect(bob?.unread).toBe(1);
    const twin = list.body.conversations[1];
    expect(twin?.last).toBeUndefined();
    expect(twin?.unread).toBe(0);
    expect(JSON.stringify(list.body)).not.toContain(cast.alice.profile);
  });

  it('un message lu ne compte plus parmi les non-lus', async () => {
    at(1_000);
    await send(cast.alice, cast.bob.pid, { body: 'salut' });
    expect((await conversationsOf(cast.bob)).body.conversations[0]?.unread).toBe(1);
    at(3_000);
    expect((await markRead(cast.bob, cast.alice.pid)).status).toBe(204);
    expect((await conversationsOf(cast.bob)).body.conversations[0]?.unread).toBe(0);
  });
});

describe('envoi (POST /user/social/messages/:pid)', () => {
  it('ami : 201 avec le message, sans identifiant interne', async () => {
    const res = await send(cast.alice, cast.bob.pid, { body: 'salut' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ from: cast.alice.pid, to: cast.bob.pid, body: 'salut', createdAt: START });
    expect(res.body.message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.message.readAt).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(cast.alice.profile);
  });

  it('texte : espaces de bord retirés ; 1 à 1000 caractères, sans contrôle (saut de ligne admis)', async () => {
    expect((await send(cast.alice, cast.bob.pid, { body: '  salut  ' })).body.message.body).toBe('salut');
    expect((await send(cast.alice, cast.bob.pid, { body: 'a' })).status).toBe(201);
    expect((await send(cast.alice, cast.bob.pid, { body: 'x'.repeat(1000) })).status).toBe(201);
    expect((await send(cast.alice, cast.bob.pid, { body: '\u{1F600}'.repeat(1000) })).status).toBe(201);
    expect((await send(cast.alice, cast.bob.pid, { body: 'ligne\nune' })).status).toBe(201);
    for (const body of ['', '   ', 'x'.repeat(1001), '\u{1F600}'.repeat(1001), 'bon\u0007jour', 42]) {
      const res = await send(cast.alice, cast.bob.pid, { body });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_body');
    }
  });

  it('contexte facultatif : titre et position ; saison et épisode ignorés pour un film ; champs inconnus refusés', async () => {
    const series = await send(cast.alice, cast.bob.pid, {
      body: 'Ici',
      context: { type: 'series', tmdbId: 1399, season: 2, episode: 4, pos: 754 },
    });
    expect(series.status).toBe(201);
    expect(series.body.message.context).toEqual({ type: 'series', tmdbId: 1399, season: 2, episode: 4, pos: 754 });

    const movie = await send(cast.alice, cast.bob.pid, { body: 'Dune', context: { type: 'movie', tmdbId: 438631, season: 1, pos: 10 } });
    expect(movie.body.message.context).toEqual({ type: 'movie', tmdbId: 438631, pos: 10 });

    for (const context of [
      { type: 'movie', tmdbId: 1, extra: true },
      { type: 'anime', tmdbId: 1 },
      { type: 'movie', tmdbId: 1, pos: -1 },
    ]) {
      expect((await send(cast.alice, cast.bob.pid, { body: 'x', context })).body.error).toBe('invalid_body');
    }
    expect((await send(cast.alice, cast.bob.pid, { body: 'x', extra: 1 })).body.error).toBe('invalid_body');
  });

  it('foyer : un autre profil du même compte écrit sans demande d’ami ; un profil enfant ne peut rien envoyer', async () => {
    expect((await send(cast.alice2, cast.alice.pid, { body: 'coucou' })).status).toBe(201);
    const kid = await send(cast.kid, cast.alice.pid, { body: 'coucou' });
    expect(kid.status).toBe(403);
    expect(kid.body.error).toBe('kid_profile');
  });

  it('non ami : 403 not_friend, rien n’est écrit', async () => {
    const res = await send(cast.bob, cast.carol.pid, { body: 'salut' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_friend');
    expect((await conversationsOf(cast.carol)).body.conversations.map((c) => c.pid)).not.toContain(cast.bob.pid);
  });

  it('pid inconnu ou mal formé : 404 profile_not_found ; soi-même : 400 self', async () => {
    const unknown = await send(cast.alice, 'AAAAAAAAAAAAAAAA', { body: 'salut' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('profile_not_found');
    expect((await send(cast.alice, 'pas-un-pid', { body: 'salut' })).status).toBe(404);
    const self = await send(cast.bob, cast.bob.pid, { body: 'salut' });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('self');
  });

  it('limite : 30 messages par minute et par expéditeur ; 429 avec Retry-After, puis de nouveau permis une minute plus tard', async () => {
    for (let i = 0; i < 30; i++) expect((await send(cast.bob, cast.alice.pid, { body: `m${i}` })).status).toBe(201);
    const blocked = await send(cast.bob, cast.alice.pid, { body: 'trop' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect((await send(cast.alice, cast.bob.pid, { body: 'autre expéditeur' })).status).toBe(201);
    at(60_000);
    expect((await send(cast.bob, cast.alice.pid, { body: 'une minute plus tard' })).status).toBe(201);
  });
});

describe('fil (GET /user/social/messages/:pid)', () => {
  it('chronologique, dans les deux sens ; un non-ami ne lit rien (403)', async () => {
    at(1_000);
    await send(cast.alice, cast.bob.pid, { body: 'un' });
    at(2_000);
    await send(cast.bob, cast.alice.pid, { body: 'deux' });
    at(3_000);
    await send(cast.alice, cast.bob.pid, { body: 'trois' });

    const mine = await thread(cast.alice, cast.bob.pid);
    expect(mine.status).toBe(200);
    expect(mine.body.messages.map((m) => m.body)).toEqual(['un', 'deux', 'trois']);
    expect((await thread(cast.bob, cast.alice.pid)).body.messages.map((m) => m.body)).toEqual(['un', 'deux', 'trois']);

    const outsider = await thread(cast.carol, cast.bob.pid);
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toBe('not_friend');
  });

  it('pagination : 50 au plus, ?before= pour la page précédente, ?limit= borné', async () => {
    // 30 messages d'alice puis 30 de bob, une seconde d'écart : chaque expéditeur reste sous son quota.
    for (let i = 1; i <= 30; i++) {
      at(i * 1_000);
      expect((await send(cast.alice, cast.bob.pid, { body: `a${i}` })).status).toBe(201);
    }
    for (let i = 1; i <= 30; i++) {
      at((30 + i) * 1_000);
      expect((await send(cast.bob, cast.alice.pid, { body: `b${i}` })).status).toBe(201);
    }

    const first = await thread(cast.alice, cast.bob.pid);
    expect(first.body.messages).toHaveLength(50);
    expect(first.body.messages[0]?.createdAt).toBe(START + 11_000);
    expect(first.body.messages.at(-1)?.createdAt).toBe(START + 60_000);

    const older = await thread(cast.alice, cast.bob.pid, `?before=${START + 11_000}&limit=50`);
    expect(older.body.messages).toHaveLength(10);
    expect(older.body.messages[0]?.createdAt).toBe(START + 1_000);
    expect(older.body.messages.at(-1)?.createdAt).toBe(START + 10_000);

    expect((await thread(cast.alice, cast.bob.pid, '?limit=5')).body.messages).toHaveLength(5);
    expect((await thread(cast.alice, cast.bob.pid, '?limit=51')).body.error).toBe('invalid_body');
    expect((await thread(cast.alice, cast.bob.pid, '?limit=0')).body.error).toBe('invalid_body');
    expect((await thread(cast.alice, cast.bob.pid, '?before=hier')).body.error).toBe('invalid_body');
    expect((await thread(cast.alice, cast.bob.pid, '?extra=1')).body.error).toBe('invalid_body');
  });
});

describe('lecture (PUT /user/social/messages/:pid/read)', () => {
  it('marque tout lu : non-lus à zéro, readAt visible par l’expéditeur', async () => {
    at(1_000);
    await send(cast.alice, cast.bob.pid, { body: 'un' });
    at(2_000);
    await send(cast.alice, cast.bob.pid, { body: 'deux' });
    at(5_000);
    expect((await markRead(cast.bob, cast.alice.pid)).status).toBe(204);
    expect((await conversationsOf(cast.bob)).body.conversations[0]?.unread).toBe(0);
    const aliceSees = await thread(cast.alice, cast.bob.pid);
    expect(aliceSees.body.messages.map((m) => m.readAt)).toEqual([START + 5_000, START + 5_000]);
  });

  it('non ami : 403 not_friend ; pid inconnu : 404', async () => {
    expect((await markRead(cast.carol, cast.bob.pid)).body.error).toBe('not_friend');
    expect((await markRead(cast.bob, 'AAAAAAAAAAAAAAAA')).body.error).toBe('profile_not_found');
  });
});

describe('accès : ami retiré, profil enfant, profil devenu enfant', () => {
  it('ami retiré : plus de conversation, fil, envoi et lecture refusés (403)', async () => {
    await send(cast.alice, cast.bob.pid, { body: 'salut' });
    expect((await as(app, cast.alice, 'DELETE', `/user/social/friends/${cast.bob.pid}`)).status).toBe(204);
    expect((await conversationsOf(cast.alice)).body.conversations.map((c) => c.pid)).toEqual([cast.alice2.pid]);
    expect((await thread(cast.alice, cast.bob.pid)).body.error).toBe('not_friend');
    expect((await send(cast.alice, cast.bob.pid, { body: 'encore' })).status).toBe(403);
    expect((await markRead(cast.bob, cast.alice.pid)).status).toBe(403);
  });

  it('profil enfant : aucune route de messages (403 kid_profile)', async () => {
    const list = await as<ErrorBodyV2>(app, cast.kid, 'GET', '/user/social/conversations');
    expect(list.status).toBe(403);
    expect(list.body.error).toBe('kid_profile');
    expect((await send(cast.kid, cast.alice.pid, { body: 'salut' })).body.error).toBe('kid_profile');
    expect((await thread(cast.kid, cast.alice.pid)).body.error).toBe('kid_profile');
  });

  it('profil devenu enfant : ses messages partent avec son identité ; redevenu adulte, il repart sans historique', async () => {
    at(1_000);
    expect((await send(cast.alice2, cast.alice.pid, { body: 'coucou' })).status).toBe(201);
    const toKid = await as<ErrorBodyV2>(app, cast.alice, 'PATCH', `/user/profiles/${cast.alice2.profile}`, { body: { isKid: true } });
    expect(toKid.status).toBe(200);
    expect((await conversationsOf(cast.alice)).body.conversations.map((c) => c.pid)).toEqual([cast.bob.pid]);

    const toAdult = await as<ErrorBodyV2>(app, cast.alice, 'PATCH', `/user/profiles/${cast.alice2.profile}`, { body: { isKid: false } });
    expect(toAdult.status).toBe(200);
    const again = (await conversationsOf(cast.alice)).body.conversations.find((c) => c.pid !== cast.bob.pid);
    expect(again).toBeDefined();
    expect(again?.last).toBeUndefined();
  });
});

describe('événements temps réel (gestionnaire injecté)', () => {
  it('message : vers le destinataire seul, avec la vue du message', async () => {
    at(1_000);
    await send(cast.alice, cast.bob.pid, { body: 'salut' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.bob.pid]);
    expect(emitted[0]?.event).toMatchObject({
      t: 'message',
      message: { from: cast.alice.pid, to: cast.bob.pid, body: 'salut', createdAt: START + 1_000 },
    });
  });

  it('refus (403) : aucun événement', async () => {
    await send(cast.carol, cast.bob.pid, { body: 'salut' });
    expect(emitted).toHaveLength(0);
  });

  it('lecture : vers l’expéditeur seul, avec le lecteur et l’instant ; rien à lire, rien à notifier', async () => {
    await send(cast.alice, cast.bob.pid, { body: 'salut' });
    emitted.length = 0;
    at(9_000);
    expect((await markRead(cast.bob, cast.alice.pid)).status).toBe(204);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.alice.pid]);
    expect(emitted[0]?.event).toEqual({ t: 'read', pid: cast.bob.pid, at: START + 9_000 });
    expect((await markRead(cast.bob, cast.alice.pid)).status).toBe(204);
    expect(emitted).toHaveLength(1);
  });
});
