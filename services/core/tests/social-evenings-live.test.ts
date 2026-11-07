import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Evening, EveningEvent } from '@laststream/protocol/social';
import type { PartyBackend, PartyRoomStub } from '../src/party/backend.js';
import type { RoomInfo, RoomMeta } from '../src/party/protocol.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { liveFrame } from '../src/user/social-v2-live.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/**
 * Soirées planifiées, lot L3 : trames temps réel (invitation, modification, réponse, ouverture), ouverture du salon, retrait des
 * soirées d'un profil bloqué ou retiré des amis, purge au passage en profil enfant. Chaque assertion « absent » a son témoin
 * « présent » dans le même test. Les rappels (tick, alarme) sont testés avec le store (social-evenings-store.test.ts).
 */

const NOW_MS = Date.parse('2026-05-01T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = NOW_MS + 2 * HOUR;
const EVENINGS = '/user/social/evenings';
const evening = (id: string): string => `${EVENINGS}/${id}`;

type EveningReply = Evening & Partial<ErrorBodyV2>;

/** Salons simulés : un salon existe de son `init` à son `close`. */
function fakeParty(): { backend: PartyBackend; rooms: Map<string, RoomMeta> } {
  const rooms = new Map<string, RoomMeta>();
  const backend: PartyBackend = {
    room: (id) =>
      ({
        init: (meta: RoomMeta) => {
          if (rooms.has(meta.id)) return Promise.resolve('exists');
          rooms.set(meta.id, meta);
          return Promise.resolve('ok');
        },
        info: () => {
          const meta = rooms.get(id);
          return Promise.resolve(meta === undefined ? null : ({ id, title: meta.title, visibility: meta.visibility } as unknown as RoomInfo));
        },
        close: () => Promise.resolve(rooms.delete(id) ? 'ok' : 'not_found'),
      }) as unknown as PartyRoomStub,
  };
  return { backend, rooms };
}

let app: RunningApp;
let cast: Cast;
let party: ReturnType<typeof fakeParty>;
const emitted: { pids: string[]; event: SocialEvent }[] = [];

beforeEach(async () => {
  emitted.length = 0;
  party = fakeParty();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  app = await startApp({
    extra: {
      party: party.backend,
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

/** Trames de soirée émises depuis le dernier `emitted.length = 0`, avec leurs destinataires triés. */
function frames(type?: EveningEvent['type']): { pids: string[]; event: EveningEvent }[] {
  const out: { pids: string[]; event: EveningEvent }[] = [];
  for (const entry of emitted) {
    if (entry.event.t === 'evening' && (type === undefined || entry.event.event.type === type)) out.push({ pids: [...entry.pids].sort(), event: entry.event.event });
  }
  return out;
}

const sorted = (...personas: Persona[]): string[] => personas.map((persona) => persona.pid).sort();

async function createEvening(guests: Persona[], overrides: Record<string, unknown> = {}): Promise<EveningReply> {
  const res = await as<EveningReply>(app, cast.alice, 'POST', EVENINGS, {
    body: { title: 'Film du soir', startsAt: START, tz: 'Europe/Paris', guests: guests.map((guest) => guest.pid), ...overrides },
  });
  expect(res.status).toBe(201);
  return res.body;
}

const respond = (who: Acting, id: string, response: string) => as(app, who, 'PUT', `${evening(id)}/response`, { body: { response } });

describe('trames : invitation', () => {
  it('la création envoie evening_invite aux invités seulement, avec l hôte au format du protocole', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    const invites = frames('evening_invite');
    expect(invites).toHaveLength(1);
    // Absent : l'hôte n'est pas invité à sa propre soirée. Témoin : bob et carol le sont.
    expect(invites[0]?.pids).toEqual(sorted(cast.bob, cast.carol));
    expect(invites[0]?.pids).not.toContain(cast.alice.pid);
    expect(invites[0]?.event).toMatchObject({
      type: 'evening_invite',
      eveningId: created.id,
      title: 'Film du soir',
      startsAt: START,
      tz: 'Europe/Paris',
      host: { pid: cast.alice.pid, handle: { full: cast.alice.full } },
    });
  });

  it('sans invité, aucune trame ; l ajout d un invité n invite que le nouvel arrivant', async () => {
    const created = await createEvening([cast.bob]);
    emitted.length = 0;
    const solo = await createEvening([], { title: 'Seul' });
    expect(solo.title).toBe('Seul');
    expect(frames()).toEqual([]);
    expect((await as(app, cast.alice, 'POST', `${evening(created.id)}/guests`, { body: { pids: [cast.bob.pid, cast.carol.pid] } })).status).toBe(204);
    const invites = frames('evening_invite');
    expect(invites).toHaveLength(1);
    expect(invites[0]?.pids).toEqual([cast.carol.pid]);
    expect(invites[0]?.pids).not.toContain(cast.bob.pid);
  });

  it('la trame sortante ne porte que les champs du contrat', () => {
    const wire = liveFrame({
      t: 'evening',
      event: {
        type: 'evening_invite',
        eveningId: 'e1',
        title: 'T',
        startsAt: 1,
        tz: 'UTC',
        host: { pid: 'P', handle: { name: 'a', tag: '1', full: 'a#1' }, avatarColor: '#fff', secret: 'x' } as never,
      },
    });
    expect(wire).toEqual({
      type: 'evening_invite',
      eveningId: 'e1',
      title: 'T',
      startsAt: 1,
      tz: 'UTC',
      host: { pid: 'P', handle: { name: 'a', tag: '1', full: 'a#1' }, avatarColor: '#fff' },
    });
  });
});

describe('trames : modification, annulation, réponse', () => {
  it('evening_update « updated » va à l hôte et aux invités qui n ont pas dit non', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    expect((await respond(cast.carol, created.id, 'no')).status).toBe(204);
    emitted.length = 0;
    expect((await as(app, cast.alice, 'PATCH', evening(created.id), { body: { title: 'Autre film', scope: 'occurrence' } })).status).toBe(204);
    const updates = frames('evening_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.event).toEqual({ type: 'evening_update', eveningId: created.id, change: 'updated' });
    expect(updates[0]?.pids).toEqual(sorted(cast.alice, cast.bob));
    expect(updates[0]?.pids).not.toContain(cast.carol.pid);
  });

  it('l annulation envoie « cancelled » ; l arrêt d une série aussi', async () => {
    const created = await createEvening([cast.bob]);
    emitted.length = 0;
    expect((await as(app, cast.alice, 'DELETE', `${evening(created.id)}?scope=occurrence`)).status).toBe(204);
    expect(frames('evening_update')).toEqual([{ pids: sorted(cast.alice, cast.bob), event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } }]);

    emitted.length = 0;
    const ANCHOR = Date.parse('2026-05-05T18:00:00.000Z');
    const series = await createEvening([cast.bob], { startsAt: ANCHOR, recurrence: { freq: 'weekly', interval: 1 } });
    emitted.length = 0;
    expect((await as(app, cast.alice, 'POST', `${evening(series.id)}/stop`)).status).toBe(204);
    expect(frames('evening_update')).toEqual([{ pids: sorted(cast.alice, cast.bob), event: { type: 'evening_update', eveningId: series.id, change: 'cancelled' } }]);
  });

  it('un refus (non-hôte) n émet rien', async () => {
    const created = await createEvening([cast.bob]);
    emitted.length = 0;
    expect((await as(app, cast.bob, 'DELETE', `${evening(created.id)}?scope=occurrence`)).status).toBe(403);
    expect(frames()).toEqual([]);
  });

  it('evening_response va aux autres participants, jamais au répondant ni à ceux qui ont dit non', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    expect((await respond(cast.carol, created.id, 'no')).status).toBe(204);
    emitted.length = 0;
    expect((await respond(cast.bob, created.id, 'maybe')).status).toBe(204);
    const responses = frames('evening_response');
    expect(responses).toEqual([{ pids: [cast.alice.pid], event: { type: 'evening_response', eveningId: created.id, pid: cast.bob.pid, response: 'maybe' } }]);
    // Témoin : alice (hôte) reçoit ; absents : bob (répondant) et carol (non).
    expect(responses[0]?.pids).not.toContain(cast.bob.pid);
    expect(responses[0]?.pids).not.toContain(cast.carol.pid);
  });

  it('quitter une soirée envoie evening_response « no » aux autres, jamais « pending »', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    expect((await as(app, cast.bob, 'POST', `${evening(created.id)}/leave`, { body: { scope: 'occurrence' } })).status).toBe(204);
    const responses = frames('evening_response');
    expect(responses).toHaveLength(1);
    expect(responses[0]?.event).toEqual({ type: 'evening_response', eveningId: created.id, pid: cast.bob.pid, response: 'no' });
    expect(responses[0]?.pids).toEqual(sorted(cast.alice, cast.carol));
    expect(frames().some((entry) => (entry.event as { response?: string }).response === 'pending')).toBe(false);
  });

  it('retirer un invité l en prévient (« cancelled »), et l hôte et les invités restants voient la liste changer (« updated »)', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    expect((await as(app, cast.alice, 'DELETE', `${evening(created.id)}/guests/${cast.bob.pid}`)).status).toBe(204);
    expect(frames('evening_update')).toEqual([
      { pids: [cast.bob.pid], event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } },
      { pids: [cast.alice.pid, cast.carol.pid].sort(), event: { type: 'evening_update', eveningId: created.id, change: 'updated' } },
    ]);
  });
});

describe('ouverture du salon (POST /open)', () => {
  /** Soirée de bob et carol, ouverte aux participants dix minutes avant le début. */
  async function ready(): Promise<EveningReply> {
    const created = await createEvening([cast.bob, cast.carol]);
    vi.setSystemTime(START - 10 * MINUTE);
    emitted.length = 0;
    return created;
  }

  it('hôte : salon privé au titre de la soirée, rattaché, evening_open aux participants qui n ont pas dit non', async () => {
    const created = await ready();
    expect((await respond(cast.carol, created.id, 'no')).status).toBe(204);
    emitted.length = 0;
    // Avant : pas de salon dans le JSON, pour l'hôte comme pour l'invité.
    expect((await as<EveningReply>(app, cast.bob, 'GET', evening(created.id))).body.party).toBeUndefined();

    const opened = await as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`);
    expect(opened.status).toBe(200);
    const partyId = opened.body.party?.partyId;
    expect(typeof partyId).toBe('string');
    expect(opened.body.party?.title).toBe('Film du soir');
    expect(party.rooms.size).toBe(1);
    expect(party.rooms.get(partyId ?? '')).toMatchObject({ title: 'Film du soir', visibility: 'private' });

    // Après : l'invité voit le salon.
    expect((await as<EveningReply>(app, cast.bob, 'GET', evening(created.id))).body.party).toEqual({ partyId, title: 'Film du soir' });
    const open = frames('evening_open');
    expect(open).toEqual([{ pids: sorted(cast.alice, cast.bob), event: { type: 'evening_open', eveningId: created.id, party: { partyId, title: 'Film du soir' } } }]);
    expect(open[0]?.pids).not.toContain(cast.carol.pid);
  });

  it('un invité reçoit 403 not_host et aucun salon n est créé ; un non-participant, 404', async () => {
    const created = await ready();
    const asGuest = await as<ErrorBodyV2>(app, cast.bob, 'POST', `${evening(created.id)}/open`);
    expect(asGuest).toMatchObject({ status: 403, body: { error: 'not_host' } });
    expect(party.rooms.size).toBe(0);
    expect(frames('evening_open')).toEqual([]);
    const outsider = await as<ErrorBodyV2>(app, cast.alice2, 'POST', `${evening(created.id)}/open`);
    expect(outsider).toMatchObject({ status: 404, body: { error: 'evening_not_found' } });
    // Témoin : l'hôte, lui, peut ouvrir.
    expect((await as(app, cast.alice, 'POST', `${evening(created.id)}/open`)).status).toBe(200);
  });

  it('hors fenêtre (plus de 15 min avant, plus de 2 h après) : 409 evening_not_open ; dans la fenêtre : accepté', async () => {
    const created = await createEvening([cast.bob]);
    const open = () => as<ErrorBodyV2>(app, cast.alice, 'POST', `${evening(created.id)}/open`);
    expect(await open()).toMatchObject({ status: 409, body: { error: 'evening_not_open' } });
    vi.setSystemTime(START + 2 * HOUR + MINUTE);
    expect(await open()).toMatchObject({ status: 409, body: { error: 'evening_not_open' } });
    expect(party.rooms.size).toBe(0);
    vi.setSystemTime(START - 15 * MINUTE);
    expect((await open()).status).toBe(200);
    expect(party.rooms.size).toBe(1);
  });

  it('une soirée annulée : 409 evening_closed', async () => {
    const created = await ready();
    expect((await as(app, cast.alice, 'DELETE', `${evening(created.id)}?scope=occurrence`)).status).toBe(204);
    expect(await as<ErrorBodyV2>(app, cast.alice, 'POST', `${evening(created.id)}/open`)).toMatchObject({ status: 409, body: { error: 'evening_closed' } });
    expect(party.rooms.size).toBe(0);
  });

  it('idempotent : un second appel renvoie le même salon, sans nouvelle trame ni nouveau salon', async () => {
    const created = await ready();
    const first = await as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`);
    emitted.length = 0;
    const second = await as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`);
    expect(second.status).toBe(200);
    expect(second.body.party?.partyId).toBe(first.body.party?.partyId);
    expect(party.rooms.size).toBe(1);
    expect(frames('evening_open')).toEqual([]);
  });

  it('deux ouvertures simultanées : un seul salon survit, les deux réponses portent le même identifiant', async () => {
    const created = await ready();
    const [one, two] = await Promise.all([
      as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`),
      as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.party?.partyId).toBeDefined();
    expect(one.body.party?.partyId).toBe(two.body.party?.partyId);
    expect([...party.rooms.keys()]).toEqual([one.body.party?.partyId]);
    expect(frames('evening_open')).toHaveLength(1);
  });

  it('plafond de salons de l hôte atteint : 429 too_many_rooms, la soirée reste sans salon', async () => {
    const created = await ready();
    let status = 201;
    for (let index = 0; index < 10 && status === 201; index += 1) {
      status = (
        await as(app, cast.alice, 'POST', '/party', { body: { profileId: cast.alice.profile, title: `Salon ${index}`, media: { type: 'movie', tmdbId: 603 } } })
      ).status;
    }
    expect(status).toBe(429);
    const before = party.rooms.size;
    expect(await as<ErrorBodyV2>(app, cast.alice, 'POST', `${evening(created.id)}/open`)).toMatchObject({ status: 429, body: { error: 'too_many_rooms' } });
    expect(party.rooms.size).toBe(before);
    expect((await as<EveningReply>(app, cast.alice, 'GET', evening(created.id))).body.party).toBeUndefined();
    expect(frames('evening_open')).toEqual([]);
  });

  it('sans service de salons : 501 party_unavailable', async () => {
    const bare = await startApp({});
    try {
      const other = await castOf(bare);
      await befriend(bare, other.alice, other.bob);
      const res = await as<EveningReply>(bare, other.alice, 'POST', EVENINGS, {
        body: { title: 'Sans salon', startsAt: START, tz: 'Europe/Paris', guests: [other.bob.pid] },
      });
      vi.setSystemTime(START - MINUTE);
      expect(await as<ErrorBodyV2>(bare, other.alice, 'POST', `${evening(res.body.id)}/open`)).toMatchObject({ status: 501, body: { error: 'party_unavailable' } });
    } finally {
      await bare.close();
    }
  });
});

describe('blocage et retrait d ami', () => {
  it('le blocage retire chacun des soirées futures de l autre ; l hôte bloqué n est pas prévenu', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    expect((await as(app, cast.bob, 'POST', `/user/social/blocks/${cast.alice.pid}`)).status).toBe(204);
    // Absent pour bob, présent pour carol et alice.
    expect((await as<ErrorBodyV2>(app, cast.bob, 'GET', evening(created.id))).status).toBe(404);
    const detail = await as<EveningReply>(app, cast.alice, 'GET', evening(created.id));
    expect(detail.body.guests.map((guest) => guest.profile.pid).sort()).toEqual(sorted(cast.alice, cast.carol));
    expect((await as(app, cast.carol, 'GET', evening(created.id))).status).toBe(200);
    // Bob apprend que la soirée disparaît ; alice, bloquée, ne reçoit aucune trame de soirée.
    const updates = frames('evening_update');
    expect(updates).toEqual([{ pids: [cast.bob.pid], event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } }]);
  });

  it('un blocage dans l autre sens retire aussi l hôte de la soirée de l invité', async () => {
    // Bob héberge et invite alice ; alice bloque bob : elle quitte sa soirée.
    const res = await as<EveningReply>(app, cast.bob, 'POST', EVENINGS, {
      body: { title: 'Chez Bob', startsAt: START, tz: 'Europe/Paris', guests: [cast.alice.pid] },
    });
    expect(res.status).toBe(201);
    expect((await as(app, cast.alice, 'POST', `/user/social/blocks/${cast.bob.pid}`)).status).toBe(204);
    expect((await as(app, cast.alice, 'GET', evening(res.body.id))).status).toBe(404);
    expect((await as(app, cast.bob, 'GET', evening(res.body.id))).status).toBe(200);
  });

  it('le retrait d ami fait quitter les soirées, prévient l invité (« cancelled ») et l hôte (« updated »)', async () => {
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    expect((await as(app, cast.alice, 'DELETE', `/user/social/friends/${cast.bob.pid}`)).status).toBe(204);
    expect((await as(app, cast.bob, 'GET', evening(created.id))).status).toBe(404);
    expect((await as(app, cast.carol, 'GET', evening(created.id))).status).toBe(200);
    expect(frames('evening_update')).toEqual(
      expect.arrayContaining([
        { pids: [cast.bob.pid], event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } },
        { pids: [cast.alice.pid], event: { type: 'evening_update', eveningId: created.id, change: 'updated' } },
      ]),
    );
    expect(frames('evening_update')).toHaveLength(2);
  });
});

describe('passage en profil enfant', () => {
  it('supprime les soirées hébergées et les invitations du profil, sans erreur (clé étrangère sur pid)', async () => {
    // alice2 (même compte qu'alice) est amie de bob : elle héberge une soirée et est invitée à une autre.
    await befriend(app, cast.bob, cast.alice2);
    const hosted = await as<EveningReply>(app, cast.alice2, 'POST', EVENINGS, {
      body: { title: 'Chez Alice Deux', startsAt: START, tz: 'Europe/Paris', guests: [cast.bob.pid] },
    });
    expect(hosted.status).toBe(201);
    const invited = await as<EveningReply>(app, cast.bob, 'POST', EVENINGS, {
      body: { title: 'Chez Bob', startsAt: START + HOUR, tz: 'Europe/Paris', guests: [cast.alice2.pid] },
    });
    expect(invited.status).toBe(201);
    expect((await as(app, cast.bob, 'GET', evening(hosted.body.id))).status).toBe(200);

    const toKid = await as(app, cast.alice, 'PATCH', `/user/profiles/${cast.alice2.profile}`, { body: { isKid: true } });
    expect(toKid.status).toBe(200);

    // Absent : la soirée hébergée par le profil, et son invitation chez bob. Témoin : la soirée de bob existe toujours.
    expect((await as(app, cast.bob, 'GET', evening(hosted.body.id))).status).toBe(404);
    const stillThere = await as<EveningReply>(app, cast.bob, 'GET', evening(invited.body.id));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.guests.map((guest) => guest.profile.pid)).not.toContain(cast.alice2.pid);
  });
});
