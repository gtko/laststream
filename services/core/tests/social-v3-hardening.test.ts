import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, createApp } from '../src/app.js';
import { isTmdbImageRef } from '../src/user/social-v2-validation.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';
import { request } from './user-harness.js';

/**
 * Durcissement social v3 : identité retirée sans résidu, blocage dans les groupes, vues minimales des inconnus, groupes à
 * propriétaire, limites de débit persistantes, liens publics (expiration, suppression), images TMDB strictes, salons.
 */

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

interface Msg {
  id: string;
  from: string;
  body: string;
  kind: string;
  poll?: { id: string };
}

interface ConversationBody {
  conv: string;
  group?: { id: string; name: string; ownerPid: string; members: { pid: string; status: string; household: boolean; watching?: unknown; lastSeen?: number; customStatus?: unknown }[] };
}

interface LinkBody {
  url: string;
  code: string;
  inviteCode?: string;
}

interface OwnLinks {
  links: { code: string; url: string; title: string; createdAt: number; expiresAt: number; expired: boolean; inviteCode?: string }[];
}

interface InviteList {
  invites: { code: string; state: string }[];
}

const NOW = '2026-05-01T10:00:00.000Z';
const START = Date.parse(NOW);
const DAY = 24 * 3_600_000;
const MATRIX = { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg' };

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
const updateGroup = (who: Acting, id: string, body: unknown) => as<ConversationBody & ErrorBodyV2>(app, who, 'PUT', `/user/social/groups/${id}`, { body });
const leaveGroup = (who: Acting, id: string) => as<ErrorBodyV2>(app, who, 'DELETE', `/user/social/groups/${id}/me`);
const conversationsOf = (who: Acting) => as<{ conversations: ConversationBody[] }>(app, who, 'GET', '/user/social/conversations');
const groupOf = async (who: Acting, id: string): Promise<ConversationBody | undefined> =>
  (await conversationsOf(who)).body.conversations.find((c) => c.conv === `g:${id}`);
const sendTo = (who: Acting, conv: string, body: unknown) => as<{ message: Msg } & ErrorBodyV2>(app, who, 'POST', `/user/social/conv/${conv}/messages`, { body });
const textTo = (who: Acting, conv: string, text: string) => sendTo(who, conv, { kind: 'text', body: text });
const messagesOf = (who: Acting, conv: string) => as<{ messages: Msg[] } & ErrorBodyV2>(app, who, 'GET', `/user/social/conv/${conv}/messages`);
const block = (who: Acting, target: Persona) => as(app, who, 'POST', `/user/social/blocks/${target.pid}`);

async function makeGroup(owner: Persona = cast.alice, members: Persona[] = [cast.bob, cast.carol]): Promise<string> {
  const res = await createGroup(owner, { name: 'Week-end', members: members.map((m) => m.pid) });
  expect(res.status).toBe(201);
  return res.body.group?.id ?? '';
}

/** Événements reçus par un profil (pid) : types dans l'ordre. */
const eventsFor = (pid: string): string[] => emitted.filter((entry) => entry.pids.includes(pid)).map((entry) => entry.event.t);

describe('1. identité retirée (passage en enfant) sans résidu', () => {
  it('profil avec activité, lien public, liste, éléments ajoutés chez les autres et groupe : passage en enfant 200, tout disparaît', async () => {
    await befriend(app, cast.bob, cast.carol);
    // Liste de bob avec un élément (activité « listed ») et lien public de bob.
    const ownList = await as<{ id: string }>(app, cast.bob, 'POST', '/user/social/lists', { body: { name: 'À voir', members: [cast.alice.pid] } });
    expect(ownList.status).toBe(201);
    expect((await as(app, cast.bob, 'POST', `/user/social/lists/${ownList.body.id}/items`, { body: { type: 'movie', tmdbId: 603, title: 'Matrix' } })).status).toBe(201);
    expect((await as(app, cast.bob, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } })).status).toBe(201);
    // Liste d'alice où bob ajoute un élément.
    const aliceList = await as<{ id: string }>(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'Alice', members: [cast.bob.pid] } });
    expect((await as(app, cast.bob, 'POST', `/user/social/lists/${aliceList.body.id}/items`, { body: { type: 'movie', tmdbId: 604, title: 'Reloaded' } })).status).toBe(201);
    // Groupe créé par bob avec alice et carol.
    const groupId = await makeGroup(cast.bob, [cast.alice, cast.carol]);

    const kid = await as<ErrorBodyV2>(app, cast.bob, 'PATCH', `/user/profiles/${cast.bob.profile}`, { body: { isKid: true } });
    expect(kid.status).toBe(200);

    const list = await as<{ items: unknown[]; members: { pid: string }[] }>(app, cast.alice, 'GET', `/user/social/lists/${aliceList.body.id}`);
    expect(list.body.items).toEqual([]);
    expect(list.body.members.map((m) => m.pid)).toEqual([cast.alice.pid]);
    expect((await as(app, cast.alice, 'GET', `/user/social/lists/${ownList.body.id}`)).status).toBe(404);
    // Le groupe survit, la propriété passe à un membre restant.
    const group = await groupOf(cast.alice, groupId);
    expect([cast.alice.pid, cast.carol.pid]).toContain(group?.group?.ownerPid);
    expect(group?.group?.members.map((m) => m.pid)).toEqual([cast.carol.pid]);
  });
});

describe('2. blocage dans les groupes', () => {
  it('A et B bloqués : A ne reçoit rien de B (message, réaction, sondage, frappe) et ne lit pas ses messages, et inversement ; personne n’est retiré', async () => {
    const id = await makeGroup();
    expect((await block(cast.bob, cast.carol)).status).toBe(204);
    const conv = `g:${id}`;
    emitted.length = 0;

    const fromCarol = await textTo(cast.carol, conv, 'de carol');
    const fromBob = await textTo(cast.bob, conv, 'de bob');
    const fromAlice = await textTo(cast.alice, conv, 'de alice');
    expect([fromCarol.status, fromBob.status, fromAlice.status]).toEqual([201, 201, 201]);

    // Messages : bob et carol ne voient pas ceux de l'autre, alice voit tout.
    expect((await messagesOf(cast.bob, conv)).body.messages.map((m) => m.body)).toEqual(['de bob', 'de alice']);
    expect((await messagesOf(cast.carol, conv)).body.messages.map((m) => m.body)).toEqual(['de carol', 'de alice']);
    expect((await messagesOf(cast.alice, conv)).body.messages.map((m) => m.body)).toEqual(['de carol', 'de bob', 'de alice']);

    // WS : bob n'a reçu que les messages de bob... et d'alice, jamais celui de carol.
    const messageEvents = emitted.filter((entry) => entry.event.t === 'message');
    const toBob = messageEvents.filter((entry) => entry.pids.includes(cast.bob.pid)).map((entry) => (entry.event as { message: Msg }).message.body);
    const toCarol = messageEvents.filter((entry) => entry.pids.includes(cast.carol.pid)).map((entry) => (entry.event as { message: Msg }).message.body);
    expect(toBob).toEqual(['de alice']);
    expect(toCarol).toEqual(['de alice']);

    // Réaction, frappe et sondage de carol : bob ne reçoit rien.
    emitted.length = 0;
    const reacted = await as(app, cast.carol, 'POST', `/user/social/conv/${conv}/messages/${fromAlice.body.message.id}/reactions`, { body: { emoji: '👍' } });
    expect(reacted.status).toBe(200);
    expect((await as(app, cast.carol, 'POST', `/user/social/conv/${conv}/typing`)).status).toBe(204);
    const poll = await sendTo(cast.carol, conv, { kind: 'poll', poll: { question: 'On y va ?', options: ['Oui', 'Non'] } });
    expect(poll.status).toBe(201);
    expect(eventsFor(cast.bob.pid)).toEqual([]);
    expect(eventsFor(cast.alice.pid).sort()).toEqual(['message', 'reaction', 'typing']);
    // Bob ne peut pas voter sur le sondage de carol (introuvable pour lui).
    const vote = await as<ErrorBodyV2>(app, cast.bob, 'POST', `/user/social/conv/${conv}/polls/${poll.body.message.id}/vote`, { body: { optionId: 'x' } });
    expect(vote.status).toBe(404);

    // Personne n'est retiré du groupe.
    expect((await groupOf(cast.alice, id))?.group?.members.map((m) => m.pid).sort()).toEqual([cast.bob.pid, cast.carol.pid].sort());
    expect(await groupOf(cast.bob, id)).toBeDefined();
    expect(await groupOf(cast.carol, id)).toBeDefined();
  });
});

describe('3. membre de groupe ni ami ni foyer : vue minimale', () => {
  it('pid, handle, avatar et couleur seulement ; statut hors ligne, ni titre en cours, ni dernière vue, ni statut personnalisé', async () => {
    const id = await makeGroup();
    const now = Date.now();
    const presence = await as(app, cast.carol, 'PUT', '/user/social/presence', {
      body: { watching: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 10, paused: false, at: now } },
    });
    expect(presence.status).toBe(204);

    const seenByBob = (await groupOf(cast.bob, id))?.group?.members.find((m) => m.pid === cast.carol.pid);
    expect(seenByBob).toBeDefined();
    expect(seenByBob?.status).toBe('offline');
    expect(seenByBob).not.toHaveProperty('watching');
    expect(seenByBob).not.toHaveProperty('lastSeen');
    expect(seenByBob).not.toHaveProperty('customStatus');
    expect(seenByBob?.household).toBe(false);

    // Témoin : une amie (alice) voit la présence réelle de carol.
    const seenByAlice = (await groupOf(cast.alice, id))?.group?.members.find((m) => m.pid === cast.carol.pid);
    expect(seenByAlice?.status).not.toBe('offline');
    expect(seenByAlice).toHaveProperty('watching');
  });
});

describe('4. groupes : propriétaire', () => {
  it('ownerPid exposé ; seul le propriétaire renomme, ajoute et retire ; chacun peut partir ; la propriété passe au plus ancien', async () => {
    const id = await makeGroup();
    expect((await groupOf(cast.bob, id))?.group?.ownerPid).toBe(cast.alice.pid);

    for (const body of [{ name: 'Pirate' }, { add: [cast.alice2.pid] }, { remove: [cast.carol.pid] }]) {
      const refused = await updateGroup(cast.bob, id, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('owner_only');
    }
    expect((await updateGroup(cast.alice, id, { name: 'Neuf' })).status).toBe(200);

    // Bob (rejoint au même instant que carol) : l'ordre est celui des pids ; le plus ancien est le premier de (joined_at, pid).
    expect((await leaveGroup(cast.alice, id)).status).toBe(204);
    const oldest = [cast.bob.pid, cast.carol.pid].sort()[0];
    const survivor = oldest === cast.bob.pid ? cast.bob : cast.carol;
    expect((await groupOf(survivor, id))?.group?.ownerPid).toBe(oldest);
    // Le nouveau propriétaire modifie le groupe, l'autre non.
    expect((await updateGroup(survivor, id, { name: 'Repris' })).status).toBe(200);
  });

  it('à la création et à l’ajout : messagesFrom et blocage refusent (403 not_allowed, pids listés)', async () => {
    const prefs = (who: Acting, messagesFrom: string) => as(app, who, 'PUT', '/user/social/prefs', { body: { messagesFrom } });
    expect((await prefs(cast.bob, 'household')).status).toBe(200);
    const refused = await createGroup(cast.alice, { name: 'G', members: [cast.bob.pid, cast.carol.pid] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_allowed');
    expect(refused.body.issues).toEqual([cast.bob.pid]);
    expect((await prefs(cast.bob, 'friends')).status).toBe(200);

    // Ajout : carol quitte, puis n'accepte plus les messages d'alice.
    const id = await makeGroup();
    expect((await leaveGroup(cast.carol, id)).status).toBe(204);
    expect((await prefs(cast.carol, 'household')).status).toBe(200);
    const byPrefs = await updateGroup(cast.alice, id, { add: [cast.carol.pid] });
    expect(byPrefs.status).toBe(403);
    expect(byPrefs.body.error).toBe('not_allowed');
    expect(byPrefs.body.issues).toEqual([cast.carol.pid]);

    // Blocage : carol bloque alice, l'ajout reste refusé.
    expect((await prefs(cast.carol, 'friends')).status).toBe(200);
    expect((await block(cast.carol, cast.alice)).status).toBe(204);
    const byBlock = await updateGroup(cast.alice, id, { add: [cast.carol.pid] });
    expect(byBlock.status).toBe(403);
    expect(byBlock.body.error).toBe('not_allowed');
    expect(byBlock.body.issues).toEqual([cast.carol.pid]);
    expect(await groupOf(cast.carol, id)).toBeUndefined();
  });

  it('10 créations de groupe par heure et par profil (fenêtre glissante)', async () => {
    for (let n = 0; n < 10; n += 1) {
      expect((await createGroup(cast.alice, { name: `G${n}`, members: [cast.bob.pid, cast.carol.pid] })).status).toBe(201);
    }
    const refused = await createGroup(cast.alice, { name: 'G10', members: [cast.bob.pid, cast.carol.pid] });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('rate_limited');
    at(3_600_001);
    expect((await createGroup(cast.alice, { name: 'G11', members: [cast.bob.pid, cast.carol.pid] })).status).toBe(201);
  });
});

describe('5. limites de débit persistantes', () => {
  it('réactions : 60 par minute, puis 6 emojis distincts au plus par message', async () => {
    const sent = await textTo(cast.alice, `dm:${cast.bob.pid}`, 'salut');
    const react = (emoji: string) => as<ErrorBodyV2>(app, cast.bob, 'POST', `/user/social/conv/dm:${cast.alice.pid}/messages/${sent.body.message.id}/reactions`, { body: { emoji } });
    for (let n = 0; n < 60; n += 1) expect((await react('👍')).status).toBe(200);
    const limited = await react('👍');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    at(60_001);
    // Après la minute : 👍 est retiré (60 bascules, paires) ; on pose 6 emojis distincts puis un 7e.
    const emojis = ['👍', '😂', '😮', '😢', '🙏', '🔥'];
    for (const emoji of emojis) expect((await react(emoji)).status).toBe(200);
    const seventh = await react('🎉');
    expect(seventh.status).toBe(409);
    expect(seventh.body.error).toBe('too_many_reactions');
    // Retirer un emoji existant reste permis.
    expect((await react('🔥')).status).toBe(200);
  });

  it('demandes de rejoindre : 5 par 10 minutes et par cible ; l’hôte n’est prévenu qu’une fois par minute', async () => {
    const join = () => as<ErrorBodyV2>(app, cast.alice, 'POST', `/user/social/friends/${cast.bob.pid}/join-request`);
    for (let n = 0; n < 5; n += 1) expect((await join()).status).toBe(204);
    expect(emitted.filter((entry) => entry.event.t === 'join_request')).toHaveLength(1);
    const limited = await join();
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    at(61_000);
    emitted.length = 0;
    // Hors fenêtre de dédoublonnage (60 s) mais toujours dans les 10 minutes : limite atteinte, aucun événement.
    expect((await join()).status).toBe(429);
    expect(emitted).toHaveLength(0);
    at(600_001);
    expect((await join()).status).toBe(204);
    expect(emitted.filter((entry) => entry.event.t === 'join_request')).toHaveLength(1);
  });

  it('signalements : 10 par jour', async () => {
    for (let n = 0; n < 10; n += 1) {
      expect((await as(app, cast.alice, 'POST', '/user/social/reports', { body: { pid: cast.bob.pid, reason: 'spam' } })).status).toBe(201);
    }
    const limited = await as<ErrorBodyV2>(app, cast.alice, 'POST', '/user/social/reports', { body: { pid: cast.bob.pid, reason: 'spam' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    at(DAY + 1);
    expect((await as(app, cast.alice, 'POST', '/user/social/reports', { body: { pid: cast.bob.pid, reason: 'spam' } })).status).toBe(201);
  });

  it('listes : 10 créations par heure', async () => {
    for (let n = 0; n < 10; n += 1) expect((await as(app, cast.alice, 'POST', '/user/social/lists', { body: { name: `L${n}` } })).status).toBe(201);
    const limited = await as<ErrorBodyV2>(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'L10' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    at(3_600_001);
    expect((await as(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'L11' } })).status).toBe(201);
  });

  it('liens publics : 30 par heure et par profil, suppression comprise', async () => {
    for (let n = 0; n < 30; n += 1) expect((await as(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } })).status).toBe(201);
    const limited = await as<ErrorBodyV2>(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    at(3_600_001);
    expect((await as(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } })).status).toBe(201);
  });

});

describe('6. lecture publique d’un lien : adresse IP', () => {
  it('sans adresse IP connue : 400 ip_required (jamais mutualisé sous « inconnu »)', async () => {
    const local = createApp({ secret: 'ip-test-secret', allowPlain: false, userDbPath: ':memory:', thumbs: { ffmpeg: null }, rangeProxy: null });
    try {
      const res = await local.request('/user/social/share-links/abcdefghijklmnop');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBodyV2).error).toBe('ip_required');
    } finally {
      closeApp(local);
    }
  });
});

describe('7. images TMDB strictes', () => {
  it('chemin /abc.ext ou URL du CDN TMDB seulement, aucun caractère de contrôle', () => {
    for (const good of ['/abc123.jpg', '/A_b-1.webp', '/x.png', '/x.jpeg', 'https://image.tmdb.org/t/p/w500/abc.jpg', 'https://image.tmdb.org/t/p/original/a_b-c.png']) {
      expect(isTmdbImageRef(good)).toBe(true);
    }
    for (const bad of [
      '/img/x.jpg',
      '/x.jpg?a=1',
      '/x.jpg#f',
      '/x.gif',
      '/x.jpg\n',
      '/x\u0000.jpg',
      '//evil.example/x.jpg',
      '/\\evil.example/x.jpg',
      'https://image.tmdb.org/x.jpg',
      'https://image.tmdb.org/t/p/w500/a/b.jpg',
      'https://image.tmdb.org/t/p/w500/a.jpg?x=1',
      'http://image.tmdb.org/t/p/w500/a.jpg',
      'https://evil.example/t/p/w500/a.jpg',
      'https://image.tmdb.org.evil.example/t/p/w500/a.jpg',
      'https://image.tmdb.org/t/p/w500/a.jpg\r\nX: y',
      '',
      `/${'a'.repeat(600)}.jpg`,
    ]) {
      expect(isTmdbImageRef(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('routes : image de titre refusée (400), affiche de lien retirée sans erreur', async () => {
    const title = { type: 'movie', tmdbId: 603, title: 'Matrix' };
    const refused = await sendTo(cast.alice, `dm:${cast.bob.pid}`, { kind: 'title', title: { ...title, poster: '/posters/x.jpg' } });
    expect(refused.status).toBe(400);
    expect((await sendTo(cast.alice, `dm:${cast.bob.pid}`, { kind: 'title', title: { ...title, poster: '/x.jpg' } })).status).toBe(201);
    const link = await as<LinkBody>(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...title, poster: '/dir/x.jpg', withInvite: false } });
    expect(link.status).toBe(201);
    const view = await request<{ poster?: string }>(app, 'GET', `/user/social/share-links/${link.body.code}`);
    expect(view.body.poster).toBeUndefined();
  });
});

describe('8. liens publics : expiration, suppression, liste, en-têtes', () => {
  it('expiration à 30 jours : GET 410 expired, l’invitation réservée est libérée ; mes liens signalent expired', async () => {
    const created = await as<LinkBody>(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: true } });
    expect(created.status).toBe(201);
    const code = created.body.code;
    const inviteCode = created.body.inviteCode ?? '';
    const states = async (): Promise<string | undefined> => {
      const list = await request<InviteList>(app, 'GET', '/user/invites', { token: cast.alice.token });
      return list.body.invites.find((invite) => invite.code === inviteCode)?.state;
    };
    expect(await states()).toBe('sent');
    at(30 * DAY - 1);
    expect((await request(app, 'GET', `/user/social/share-links/${code}`)).status).toBe(200);
    at(30 * DAY);
    const gone = await request<ErrorBodyV2>(app, 'GET', `/user/social/share-links/${code}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe('expired');
    expect(await states()).toBe('free');
    const mine = await as<OwnLinks>(app, cast.alice, 'GET', '/user/social/share-links');
    expect(mine.status).toBe(200);
    expect(mine.body.links).toHaveLength(1);
    expect(mine.body.links[0]).toMatchObject({ code, expired: true, expiresAt: START + 30 * DAY });
  });

  it('GET /share-links liste mes liens (le plus récent d’abord, url complète) ; DELETE par l’auteur seulement, libère l’invitation', async () => {
    const first = await as<LinkBody>(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: true } });
    at(1000);
    const second = await as<LinkBody>(app, cast.alice, 'POST', '/user/social/share-links', { body: { ...MATRIX, title: 'Autre', withInvite: false } });
    const mine = await as<OwnLinks>(app, cast.alice, 'GET', '/user/social/share-links');
    expect(mine.body.links.map((link) => link.code)).toEqual([second.body.code, first.body.code]);
    expect(mine.body.links[1]?.url).toBe(first.body.url);
    expect(mine.body.links[1]?.inviteCode).toBe(first.body.inviteCode);
    expect(mine.body.links[0]?.expired).toBe(false);
    expect((await as(app, cast.bob, 'GET', '/user/social/share-links')).body).toEqual({ links: [] });

    // Un autre profil ne peut pas supprimer.
    expect((await as<ErrorBodyV2>(app, cast.bob, 'DELETE', `/user/social/share-links/${first.body.code}`)).status).toBe(404);
    expect((await request(app, 'GET', `/user/social/share-links/${first.body.code}`)).status).toBe(200);
    expect((await as(app, cast.alice, 'DELETE', `/user/social/share-links/${first.body.code}`)).status).toBe(204);
    expect((await request(app, 'GET', `/user/social/share-links/${first.body.code}`)).status).toBe(404);
    const invites = await request<InviteList>(app, 'GET', '/user/invites', { token: cast.alice.token });
    expect(invites.body.invites.find((invite) => invite.code === first.body.inviteCode)?.state).toBe('free');
    expect((await as<ErrorBodyV2>(app, cast.alice, 'DELETE', `/user/social/share-links/${first.body.code}`)).status).toBe(404);
  });

  it('/t/:code : Referrer-Policy no-referrer et X-Robots-Tag noindex (pas sur les autres pages)', async () => {
    const shell = await startApp({
      extra: {
        ui: {
          serve: async (_request: Request, pathname: string) =>
            pathname === '/index.html' ? new Response('<!doctype html>APP-SHELL', { headers: { 'content-type': 'text/html; charset=utf-8' } }) : null,
        },
      },
    });
    try {
      const share = await fetch(`${shell.baseUrl}/t/abcdefghijklmnop`, { headers: { accept: 'text/html' } });
      expect(share.status).toBe(200);
      expect(share.headers.get('referrer-policy')).toBe('no-referrer');
      expect(share.headers.get('x-robots-tag')).toBe('noindex');
      const other = await fetch(`${shell.baseUrl}/ailleurs`, { headers: { accept: 'text/html' } });
      expect(other.headers.get('referrer-policy')).toBeNull();
      expect(other.headers.get('x-robots-tag')).toBeNull();
    } finally {
      await shell.close();
    }
  });

});

describe('9. réponse à une demande de rejoindre : partyId strict', () => {
  it('partyId hors [A-Za-z0-9_-]{4,64} refusé (400) ; une valeur correcte atteint la demande (404 sans demande)', async () => {
    const answer = (partyId: string) => as<ErrorBodyV2>(app, cast.bob, 'POST', `/user/social/join-requests/${cast.alice.pid}`, { body: { accept: true, partyId } });
    for (const bad of ['a b', 'abc', '../x', 'a'.repeat(65), 'salon<1>']) expect((await answer(bad)).status, bad).toBe(400);
    const ok = await answer('salon_12-ab');
    expect(ok.status).toBe(404);
    expect(ok.body.error).toBe('request_not_found');
  });
});

describe('10. /conv/* : invitation de salon réservée à /party/:id/invite', () => {
  it('kind party refusé dans un DM et un groupe (400 kind_not_allowed)', async () => {
    const id = await makeGroup();
    const party = { kind: 'party', party: { partyId: 'abcd1234', title: 'Soirée' } };
    for (const conv of [`dm:${cast.bob.pid}`, `g:${id}`]) {
      const res = await sendTo(cast.alice, conv, party);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('kind_not_allowed');
    }
    expect((await messagesOf(cast.alice, `dm:${cast.bob.pid}`)).body.messages).toEqual([]);
  });
});

describe('11. frappe et réactions en DM : messagesFrom et blocage', () => {
  it('messagesFrom du destinataire respecté (403 not_allowed), blocage = profil introuvable', async () => {
    const sent = await textTo(cast.alice, `dm:${cast.bob.pid}`, 'salut');
    // La frappe est limitée à une notification par tiers de seconde et par conversation (horloge simulée : on l'avance).
    let tick = 0;
    const typing = (who: Acting, peer: Persona) => {
      tick += 1000;
      at(tick);
      return as<ErrorBodyV2>(app, who, 'POST', `/user/social/conv/dm:${peer.pid}/typing`);
    };
    const react = (who: Acting, peer: Persona) =>
      as<ErrorBodyV2>(app, who, 'POST', `/user/social/conv/dm:${peer.pid}/messages/${sent.body.message.id}/reactions`, { body: { emoji: '👍' } });
    expect((await typing(cast.alice, cast.bob)).status).toBe(204);

    expect((await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { messagesFrom: 'household' } })).status).toBe(200);
    emitted.length = 0;
    const noTyping = await typing(cast.alice, cast.bob);
    expect(noTyping.status).toBe(403);
    expect(noTyping.body.error).toBe('not_allowed');
    const noReaction = await react(cast.alice, cast.bob);
    expect(noReaction.status).toBe(403);
    expect(noReaction.body.error).toBe('not_allowed');
    expect(eventsFor(cast.bob.pid)).toEqual([]);

    // Le sens inverse reste permis : alice accepte les messages de ses amis.
    expect((await typing(cast.bob, cast.alice)).status).toBe(204);

    expect((await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { messagesFrom: 'friends' } })).status).toBe(200);
    expect((await block(cast.bob, cast.alice)).status).toBe(204);
    expect((await typing(cast.alice, cast.bob)).status).toBe(404);
    expect((await react(cast.alice, cast.bob)).status).toBe(404);
  });
});
