import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Evening, EveningEvent, EveningPage } from '@laststream/protocol/social';
import type { PartyBackend, PartyRoomStub } from '../src/party/backend.js';
import type { RoomInfo, RoomMeta } from '../src/party/protocol.js';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, block, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/**
 * Soirées planifiées, sécurité et confidentialité (LAST-198, lot L4). Complète social-evenings-routes.test.ts (droits de
 * base, codes d'erreur) et social-evenings-live.test.ts (trames, ouverture, blocage) : refus d'ami sans écriture ni
 * diffusion, même corps dans les deux sens du blocage, profil enfant visé, listes d'un tiers et d'un invité retiré,
 * diffusion aux seuls participants, invité bloqué masqué, salon absent pour un non-participant, même foyer.
 * Chaque assertion « absent » a son témoin « présent » dans le même test.
 */

const NOW_MS = Date.parse('2026-05-01T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Soirée à venir : deux heures après NOW. */
const START = NOW_MS + 2 * HOUR;
const EVENINGS = '/user/social/evenings';
/** Refus d'ami : le même corps pour un non-ami, une demande en attente et un blocage dans un sens ou dans l'autre. */
const NOT_FRIEND = { status: 403, body: { error: 'not_friend' } };
const NOT_FOUND = { status: 404, body: { error: 'evening_not_found' } };

type Json = Record<string, unknown>;
type EveningReply = Evening & Partial<ErrorBodyV2>;

/** Salons simulés : un salon existe de son `init` à son `close` (même principe que social-evenings-live.test.ts). */
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
  // Seul bob est ami d'alice au départ : carol sert de non-ami, et de demandeur en attente.
  await befriend(app, cast.alice, cast.bob);
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const evening = (id: string): string => `${EVENINGS}/${id}`;
const detailOf = (who: Acting, id: string) => as<EveningReply>(app, who, 'GET', evening(id));

/** Statut et corps seuls d'une réponse (les en-têtes ne se comparent pas). */
function shape(res: { status: number; body: unknown }): { status: number; body: unknown } {
  return { status: res.status, body: res.body };
}

function draft(overrides: Json = {}): Json {
  return { title: 'Film du soir', startsAt: START, tz: 'Europe/Paris', guests: [], ...overrides };
}

/** Crée une soirée d'alice qui invite `guests` (201 attendu). */
async function createEvening(guests: readonly Persona[], overrides: Json = {}): Promise<EveningReply> {
  const res = await as<EveningReply>(app, cast.alice, 'POST', EVENINGS, { body: draft({ guests: guests.map((guest) => guest.pid), ...overrides }) });
  expect(res.status).toBe(201);
  return res.body;
}

/** Création par `who` d'une soirée qui invite `pids` : statut et corps. */
async function createAs(who: Acting, pids: readonly string[]) {
  return shape(await as(app, who, 'POST', EVENINGS, { body: draft({ guests: pids }) }));
}

/** Ajout d'invités par alice à la soirée `id` : statut et corps. */
async function addAs(id: string, pids: readonly string[]) {
  return shape(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body: { pids } }));
}

/** Identifiants des soirées de `who` dans une liste (50 au plus), triés. */
async function idsOf(who: Acting, scope: 'upcoming' | 'past' | 'invites'): Promise<string[]> {
  const res = await as<EveningPage>(app, who, 'GET', `${EVENINGS}?scope=${scope}&limit=50`);
  expect(res.status).toBe(200);
  return res.body.items.map((item) => item.id).sort();
}

const idsOfEvenings = (...evenings: EveningReply[]): string[] => evenings.map((item) => item.id).sort();
const guestPidsOf = (body: Evening): string[] => body.guests.map((guest) => guest.profile.pid).sort();
const sorted = (...personas: Persona[]): string[] => personas.map((persona) => persona.pid).sort();

/** Trames de soirée émises depuis le dernier `emitted.length = 0`, avec leurs destinataires triés. */
function frames(type?: EveningEvent['type']): { pids: string[]; event: EveningEvent }[] {
  const out: { pids: string[]; event: EveningEvent }[] = [];
  for (const entry of emitted) {
    if (entry.event.t === 'evening' && (type === undefined || entry.event.event.type === type)) out.push({ pids: [...entry.pids].sort(), event: entry.event.event });
  }
  return out;
}

describe('refus d ami : ni ligne, ni trame', () => {
  it('non-ami puis demande en attente : 403 not_friend, rien n est créé ni diffusé ; l ami accepté est invité et reçoit evening_invite', async () => {
    expect(await createAs(cast.alice, [cast.carol.pid])).toEqual(NOT_FRIEND);
    expect((await as(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.carol.full } })).status).toBe(201);
    expect(await createAs(cast.alice, [cast.carol.pid])).toEqual(NOT_FRIEND);
    expect(frames()).toEqual([]);
    expect(await idsOf(cast.alice, 'upcoming')).toEqual([]);
    expect(await idsOf(cast.carol, 'upcoming')).toEqual([]);

    // Témoin : bob, ami accepté, est invité, reçoit evening_invite et voit la soirée en attente.
    const created = await createEvening([cast.bob]);
    expect(frames('evening_invite')).toEqual([
      expect.objectContaining({ pids: [cast.bob.pid], event: expect.objectContaining({ type: 'evening_invite', eveningId: created.id }) }),
    ]);
    expect(await idsOf(cast.bob, 'invites')).toEqual([created.id]);
    expect(await idsOf(cast.carol, 'upcoming')).toEqual([]);
  });
});

describe('refus d ami : même corps dans les deux sens du blocage', () => {
  it('bloqué par moi (A vers B) : même corps que pour un non-ami, à la création comme à l ajout d invité', async () => {
    const id = (await createEvening([])).id;
    const reference = { create: await createAs(cast.alice, [cast.carol.pid]), add: await addAs(id, [cast.carol.pid]) };
    expect(reference).toEqual({ create: NOT_FRIEND, add: NOT_FRIEND });

    await block(app, cast.alice, cast.bob);
    expect(await createAs(cast.alice, [cast.bob.pid])).toEqual(reference.create);
    expect(await addAs(id, [cast.bob.pid])).toEqual(reference.add);
    expect(frames()).toEqual([]);
    // Témoin : la soirée d alice n a que l hôte, bob ne la voit pas ; un ami non bloqué peut être ajouté.
    expect(guestPidsOf((await detailOf(cast.alice, id)).body)).toEqual(sorted(cast.alice));
    expect(await idsOf(cast.bob, 'upcoming')).toEqual([]);
    await befriend(app, cast.alice, cast.carol);
    expect(await addAs(id, [cast.carol.pid])).toMatchObject({ status: 204 });
    expect(guestPidsOf((await detailOf(cast.alice, id)).body)).toEqual(sorted(cast.alice, cast.carol));
  });

  it('bloqué par lui (B vers A) : même corps que pour un non-ami, à la création comme à l ajout d invité', async () => {
    const id = (await createEvening([])).id;
    await block(app, cast.bob, cast.alice);
    expect(await createAs(cast.alice, [cast.bob.pid])).toEqual(NOT_FRIEND);
    expect(await addAs(id, [cast.bob.pid])).toEqual(NOT_FRIEND);
    expect(guestPidsOf((await detailOf(cast.alice, id)).body)).toEqual(sorted(cast.alice));
    // Témoin : un ami non bloqué passe sur la même soirée.
    await befriend(app, cast.alice, cast.carol);
    expect(await addAs(id, [cast.carol.pid])).toMatchObject({ status: 204 });
    expect(frames('evening_invite')).toEqual([{ pids: [cast.carol.pid], event: expect.objectContaining({ type: 'evening_invite', eveningId: id }) }]);
  });
});

describe('profil enfant visé', () => {
  it('ami devenu profil enfant : 403 not_friend comme un non-ami ; un ami adulte reste invitable', async () => {
    await befriend(app, cast.alice, cast.carol);
    const id = (await createEvening([])).id;
    // bob passe en profil enfant : son identité sociale (pid, amitiés) disparaît.
    expect(await as(app, cast.bob, 'PATCH', `/user/profiles/${cast.bob.profile}`, { body: { isKid: true } })).toMatchObject({ status: 200 });

    expect(await createAs(cast.alice, [cast.bob.pid])).toEqual(NOT_FRIEND);
    expect(await addAs(id, [cast.bob.pid])).toEqual(NOT_FRIEND);
    expect(guestPidsOf((await detailOf(cast.alice, id)).body)).toEqual(sorted(cast.alice));
    // Témoin : un ami adulte (carol) est invité.
    expect(await addAs(id, [cast.carol.pid])).toMatchObject({ status: 204 });
    expect(guestPidsOf((await detailOf(cast.alice, id)).body)).toEqual(sorted(cast.alice, cast.carol));
  });
});

describe('listes : un tiers ne voit rien, un invité retiré perd la soirée', () => {
  it('upcoming, invites et past : un tiers n a aucune soirée ; l invité la voit, et une fois retiré elle disparaît de ses trois listes', async () => {
    const kept = await createEvening([cast.bob]);
    const removed = await createEvening([cast.bob], { title: 'Retirée' });
    const both = idsOfEvenings(kept, removed);
    // Témoins : l hôte et l invité voient les deux ; carol, non invitée, aucune.
    expect(await idsOf(cast.alice, 'upcoming')).toEqual(both);
    expect(await idsOf(cast.bob, 'upcoming')).toEqual(both);
    expect(await idsOf(cast.bob, 'invites')).toEqual(both);
    expect(await idsOf(cast.carol, 'upcoming')).toEqual([]);
    expect(await idsOf(cast.carol, 'invites')).toEqual([]);

    expect(await as(app, cast.alice, 'DELETE', `${evening(removed.id)}/guests/${cast.bob.pid}`)).toMatchObject({ status: 204 });
    expect(await idsOf(cast.bob, 'upcoming')).toEqual([kept.id]);
    expect(await idsOf(cast.bob, 'invites')).toEqual([kept.id]);

    // Passé : au démarrage, bob ne voit que la soirée qu il n a pas perdue ; l hôte voit encore les deux.
    vi.setSystemTime(START + MINUTE);
    expect(await idsOf(cast.bob, 'past')).toEqual([kept.id]);
    expect(await idsOf(cast.alice, 'past')).toEqual(both);
    expect(await idsOf(cast.carol, 'past')).toEqual([]);
    expect(await idsOf(cast.bob, 'upcoming')).toEqual([]);
  });
});

describe('diffusion de evening_response', () => {
  it('ni l ami non invité, ni l invité retiré, ni le répondant ne reçoivent la trame ; l hôte la reçoit', async () => {
    await befriend(app, cast.alice, cast.carol);
    const first = await createEvening([cast.bob, cast.carol]);
    expect(await as(app, cast.alice, 'DELETE', `${evening(first.id)}/guests/${cast.carol.pid}`)).toMatchObject({ status: 204 });
    emitted.length = 0;
    expect(await as(app, cast.bob, 'PUT', `${evening(first.id)}/response`, { body: { response: 'maybe' } })).toMatchObject({ status: 204 });
    // Témoin : seul l hôte reçoit ; carol (retirée, amie) et bob (répondant) sont absents.
    expect(frames('evening_response')).toEqual([
      { pids: [cast.alice.pid], event: { type: 'evening_response', eveningId: first.id, pid: cast.bob.pid, response: 'maybe' } },
    ]);

    // Ami non invité : carol est amie d alice mais absente de cette soirée-ci.
    const second = await createEvening([cast.bob], { startsAt: START + HOUR });
    emitted.length = 0;
    expect(await as(app, cast.bob, 'PUT', `${evening(second.id)}/response`, { body: { response: 'yes' } })).toMatchObject({ status: 204 });
    expect(frames('evening_response')).toEqual([
      { pids: [cast.alice.pid], event: { type: 'evening_response', eveningId: second.id, pid: cast.bob.pid, response: 'yes' } },
    ]);
  });
});

describe('blocage après invitation', () => {
  it('l hôte bloque un invité : celui-ci disparaît de ses listes et ne reçoit plus de trames ; l autre invité reste informé', async () => {
    await befriend(app, cast.alice, cast.carol);
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    await block(app, cast.alice, cast.bob);

    // Absent pour bob : détail, listes. Témoin : carol voit la soirée et alice ne voit plus bob.
    expect(shape(await detailOf(cast.bob, created.id))).toEqual(NOT_FOUND);
    expect(await idsOf(cast.bob, 'upcoming')).toEqual([]);
    expect(await idsOf(cast.bob, 'invites')).toEqual([]);
    expect(await idsOf(cast.carol, 'upcoming')).toEqual([created.id]);
    expect(guestPidsOf((await detailOf(cast.alice, created.id)).body)).toEqual(sorted(cast.alice, cast.carol));
    // Bob apprend la disparition ; alice, qui l a bloqué, n est pas prévenue.
    expect(frames('evening_update')).toEqual([{ pids: [cast.bob.pid], event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } }]);

    emitted.length = 0;
    expect(await as(app, cast.alice, 'PATCH', evening(created.id), { body: { title: 'Autre film', scope: 'occurrence' } })).toMatchObject({ status: 204 });
    expect(frames('evening_update')).toEqual([
      { pids: sorted(cast.alice, cast.carol), event: { type: 'evening_update', eveningId: created.id, change: 'updated' } },
    ]);
    expect(shape(await as(app, cast.bob, 'PUT', `${evening(created.id)}/response`, { body: { response: 'yes' } }))).toEqual(NOT_FOUND);
  });
});

describe('invité bloqué par un co-invité', () => {
  it('un tiers bloqué par un invité G est masqué dans la vue de G (G est masqué dans la sienne) ; l hôte voit tous les invités', async () => {
    await befriend(app, cast.alice, cast.carol);
    const created = await createEvening([cast.bob, cast.carol]);
    await block(app, cast.bob, cast.carol);

    // Vue de bob : carol est masquée ; bob reste participant avec sa réponse.
    const bobView = await detailOf(cast.bob, created.id);
    expect(bobView.status).toBe(200);
    expect(guestPidsOf(bobView.body)).toEqual(sorted(cast.alice, cast.bob));
    expect(bobView.body).toHaveProperty('myResponse', 'pending');
    expect(await idsOf(cast.bob, 'upcoming')).toEqual([created.id]);
    // Symétrie, comme pour les groupes : carol ne voit pas bob ; l hôte voit tout le monde.
    expect(guestPidsOf((await detailOf(cast.carol, created.id)).body)).toEqual(sorted(cast.alice, cast.carol));
    expect(guestPidsOf((await detailOf(cast.alice, created.id)).body)).toEqual(sorted(cast.alice, cast.bob, cast.carol));
  });
});

describe('ouverture du salon : visibilité du salon', () => {
  it('salon absent du JSON avant l ouverture ; après, présent pour l hôte et les invités, jamais pour un non-participant', async () => {
    const created = await createEvening([cast.bob]);
    vi.setSystemTime(START - 10 * MINUTE);
    // Avant l ouverture : pas de salon dans le JSON, pour l hôte comme pour l invité.
    expect((await detailOf(cast.alice, created.id)).body).not.toHaveProperty('party');
    expect((await detailOf(cast.bob, created.id)).body).not.toHaveProperty('party');

    emitted.length = 0;
    const opened = await as<EveningReply>(app, cast.alice, 'POST', `${evening(created.id)}/open`);
    expect(opened.status).toBe(200);
    const ref = opened.body.party;
    expect(ref).toEqual({ partyId: expect.any(String), title: 'Film du soir' });
    // Présent pour les participants.
    expect((await detailOf(cast.alice, created.id)).body).toHaveProperty('party', ref);
    expect((await detailOf(cast.bob, created.id)).body).toHaveProperty('party', ref);
    // Absent pour les non-participants : le profil du même foyer et le non-ami.
    expect(shape(await detailOf(cast.alice2, created.id))).toEqual(NOT_FOUND);
    expect(shape(await detailOf(cast.carol, created.id))).toEqual(NOT_FOUND);
    expect(await idsOf(cast.alice2, 'upcoming')).toEqual([]);
    expect(await idsOf(cast.alice, 'upcoming')).toEqual([created.id]);
    // Diffusé aux seuls participants, un salon unique.
    expect(party.rooms.size).toBe(1);
    expect(frames('evening_open')).toEqual([{ pids: sorted(cast.alice, cast.bob), event: { type: 'evening_open', eveningId: created.id, party: ref } }]);
  });
});

describe('même foyer', () => {
  it('autre profil du même compte : ne voit pas la soirée, ne peut ni inviter ni être invité ; l hôte la voit', async () => {
    const created = await createEvening([cast.bob]);
    emitted.length = 0;
    // Absent : détail et listes du profil jumeau. Témoin : l hôte la voit.
    expect(shape(await detailOf(cast.alice2, created.id))).toEqual(NOT_FOUND);
    expect(await idsOf(cast.alice2, 'upcoming')).toEqual([]);
    expect(await idsOf(cast.alice2, 'invites')).toEqual([]);
    expect(await idsOf(cast.alice, 'upcoming')).toEqual([created.id]);

    // Invitation refusée dans les deux sens, même corps que pour un non-ami.
    expect(await addAs(created.id, [cast.alice2.pid])).toEqual(NOT_FRIEND);
    expect(shape(await as(app, cast.alice2, 'POST', EVENINGS, { body: draft({ guests: [cast.alice.pid] }) }))).toEqual(NOT_FRIEND);
    expect(guestPidsOf((await detailOf(cast.alice, created.id)).body)).toEqual(sorted(cast.alice, cast.bob));
    expect(frames()).toEqual([]);

    // Témoin : un ami adulte, lui, peut être ajouté.
    await befriend(app, cast.alice, cast.carol);
    expect(await addAs(created.id, [cast.carol.pid])).toMatchObject({ status: 204 });
    expect(frames('evening_invite')).toEqual([{ pids: [cast.carol.pid], event: expect.objectContaining({ type: 'evening_invite', eveningId: created.id }) }]);
  });
});

describe('diffusion des retraits (LAST-198, corrections de review)', () => {
  it('retrait d un invité : il apprend la disparition (cancelled), l hôte et les invités restants voient la liste changer (updated)', async () => {
    await befriend(app, cast.alice, cast.carol);
    const created = await createEvening([cast.bob, cast.carol]);
    emitted.length = 0;
    expect(await as(app, cast.alice, 'DELETE', `${evening(created.id)}/guests/${cast.bob.pid}`)).toMatchObject({ status: 204 });
    expect(frames('evening_update')).toEqual(
      expect.arrayContaining([
        { pids: [cast.bob.pid], event: { type: 'evening_update', eveningId: created.id, change: 'cancelled' } },
        { pids: sorted(cast.alice, cast.carol), event: { type: 'evening_update', eveningId: created.id, change: 'updated' } },
      ]),
    );
    expect(frames('evening_update')).toHaveLength(2);
  });

  it('série dont la règle change : les occurrences remplacées sont annoncées annulées à l hôte et aux invités ; un invité qui a dit non n est pas prévenu', async () => {
    const anchor = Date.parse('2026-05-05T18:00:00.000Z');
    await befriend(app, cast.alice, cast.carol);
    const first = await as<EveningReply>(app, cast.alice, 'POST', EVENINGS, {
      body: draft({ startsAt: anchor, recurrence: { freq: 'weekly', interval: 1 }, guests: [cast.bob.pid, cast.carol.pid] }),
    });
    expect(first.status).toBe(201);
    const before = await as<EveningPage>(app, cast.bob, 'GET', `${EVENINGS}?limit=50`);
    const oldIds = before.body.items.map((item) => item.id).sort();
    expect(oldIds).toHaveLength(4);
    expect(await as(app, cast.carol, 'PUT', `${evening(first.body.id)}/response`, { body: { response: 'no' } })).toMatchObject({ status: 204 });
    emitted.length = 0;

    // Passage au mercredi : les quatre occurrences du mardi n'existent plus.
    const patch = await as(app, cast.alice, 'PATCH', evening(first.body.id), { body: { scope: 'series', startsAt: anchor + 24 * HOUR } });
    expect(patch).toMatchObject({ status: 204 });
    const cancelled = frames('evening_update').filter((frame) => frame.event.type === 'evening_update' && frame.event.change === 'cancelled');
    expect(cancelled.map((frame) => (frame.event as { eveningId: string }).eveningId).sort()).toEqual(oldIds);
    // Bob a gardé « en attente » sur toutes ; Carol a dit non sur la première seulement.
    const carolFree = cancelled.filter((frame) => frame.pids.includes(cast.carol.pid)).length;
    expect(cancelled.every((frame) => frame.pids.includes(cast.alice.pid) && frame.pids.includes(cast.bob.pid))).toBe(true);
    expect(carolFree).toBe(3);
    // Témoin : les nouvelles occurrences existent bien (mercredi).
    const after = await as<EveningPage>(app, cast.bob, 'GET', `${EVENINGS}?limit=50`);
    expect(after.body.items.map((item) => item.id).some((id) => oldIds.includes(id))).toBe(false);
    expect(after.body.items).toHaveLength(4);
  });
});
