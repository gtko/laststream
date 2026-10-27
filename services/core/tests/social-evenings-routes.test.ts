import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Evening, EveningPage } from '@laststream/protocol/social';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, block, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/**
 * Routes des soirées planifiées (LAST-198, lot L2) : les onze routes `/user/social/evenings*`, de bout en bout (HTTP).
 * Droits : non-participant 404 `evening_not_found` ; invité qui modifie 403 `not_host` ; non-ami, demande en attente, blocage
 * dans un sens ou dans l'autre, et foyer : le même 403 `not_friend` ; profil enfant 403 `kid_profile` sur les onze routes.
 * Chaque assertion « absent » a un témoin « présent » dans le même test.
 */

const NOW_MS = Date.parse('2026-05-01T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Soirée ponctuelle à venir : deux heures après NOW. */
const START = NOW_MS + 2 * HOUR;
/** Mardi 5 mai 2026, 20:00 à Paris : première occurrence des séries de test (le jour et l'heure de la règle en viennent). */
const ANCHOR = Date.parse('2026-05-05T18:00:00.000Z');
/** Identifiant de soirée bien formé, mais inconnu. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const EVENINGS = '/user/social/evenings';
const NOT_FRIEND = { status: 403, body: { error: 'not_friend' } };
const FOUR_SCHEDULED = ['scheduled', 'scheduled', 'scheduled', 'scheduled'];
const FOUR_CANCELLED = ['cancelled', 'cancelled', 'cancelled', 'cancelled'];

type Json = Record<string, unknown>;
type EveningReply = Evening & Partial<ErrorBodyV2>;
type PageReply = EveningPage & Partial<ErrorBodyV2>;

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  app = await startApp({});
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Chemin d'une soirée. */
const evening = (id: string): string => `${EVENINGS}/${id}`;

/** Corps valide d'une soirée ponctuelle à venir, sauf les champs donnés. */
function draft(overrides: Json = {}): Json {
  return { title: 'Film du soir', startsAt: START, tz: 'Europe/Paris', guests: [], ...overrides };
}

/** Corps valide d'une série hebdomadaire qui commence à ANCHOR. */
function seriesDraft(overrides: Json = {}): Json {
  return draft({ startsAt: ANCHOR, recurrence: { freq: 'weekly', interval: 1 }, ...overrides });
}

/** Crée une soirée et renvoie son corps (201 attendu). */
async function createEvening(who: Acting, body: Json): Promise<EveningReply> {
  const res = await as<EveningReply>(app, who, 'POST', EVENINGS, { body });
  expect(res.status).toBe(201);
  return res.body;
}

const detailOf = (who: Acting, id: string) => as<EveningReply>(app, who, 'GET', evening(id));
const listOf = (who: Acting, query = '') => as<PageReply>(app, who, 'GET', `${EVENINGS}${query}`);

/** Identifiants de la liste à venir de `who` (50 au plus). */
async function upcomingIds(who: Acting): Promise<string[]> {
  const res = await listOf(who, '?limit=50');
  expect(res.status).toBe(200);
  return res.body.items.map((item) => item.id);
}

/** Occurrences d'une série visibles par `who` dans sa liste à venir. */
async function seriesItems(who: Acting, seriesId: string | undefined): Promise<Evening[]> {
  const res = await listOf(who, '?limit=50');
  expect(res.status).toBe(200);
  return res.body.items.filter((item) => seriesId !== undefined && item.seriesId === seriesId);
}

async function statusesOf(who: Acting, seriesId: string | undefined): Promise<string[]> {
  return (await seriesItems(who, seriesId)).map((item) => item.status);
}

/** Invité `pid` d'une soirée, tel que le protocole le renvoie. */
function guestOf(body: Evening, pid: string) {
  return body.guests.find((guest) => guest.profile.pid === pid);
}

/** Statut et corps seuls d'une réponse (les en-têtes ne se comparent pas). */
function shape(res: { status: number; body: unknown }): { status: number; body: unknown } {
  return { status: res.status, body: res.body };
}

/** Création d'une soirée qui invite `guest` : statut et corps. */
async function createInviting(guest: Persona) {
  return shape(await as(app, cast.alice, 'POST', EVENINGS, { body: draft({ guests: [guest.pid] }) }));
}

/** Ajout de `guest` aux invités d'une soirée existante d'Alice : statut et corps. */
async function addInvite(id: string, guest: Persona) {
  return shape(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body: { pids: [guest.pid] } }));
}

/** Route de soirée, appelée sur une soirée `id` avec un corps valide. */
interface RouteCall {
  name: string;
  method: string;
  path: (id: string) => string;
  body?: Json;
}

/** Les onze routes des soirées. */
const ROUTES: RouteCall[] = [
  { name: 'GET liste', method: 'GET', path: () => EVENINGS },
  { name: 'GET détail', method: 'GET', path: evening },
  { name: 'POST création', method: 'POST', path: () => EVENINGS, body: draft() },
  { name: 'PATCH', method: 'PATCH', path: evening, body: { title: 'Renommée', scope: 'occurrence' } },
  { name: 'DELETE', method: 'DELETE', path: (id) => `${evening(id)}?scope=occurrence` },
  { name: 'POST invités', method: 'POST', path: (id) => `${evening(id)}/guests`, body: { pids: ['pid-inconnu'] } },
  { name: 'DELETE invité', method: 'DELETE', path: (id) => `${evening(id)}/guests/pid-inconnu` },
  { name: 'PUT réponse', method: 'PUT', path: (id) => `${evening(id)}/response`, body: { response: 'yes' } },
  { name: 'POST leave', method: 'POST', path: (id) => `${evening(id)}/leave`, body: { scope: 'occurrence' } },
  { name: 'POST stop', method: 'POST', path: (id) => `${evening(id)}/stop` },
  { name: 'POST open', method: 'POST', path: (id) => `${evening(id)}/open` },
];

/** Routes qui agissent sur une soirée existante (sans la liste ni la création). */
const ON_EVENING = ROUTES.filter((route) => route.name !== 'GET liste' && route.name !== 'POST création');

/** Routes réservées à l'hôte, plus la suppression de série (même route que DELETE, `?scope=series`). */
const HOST_ONLY: RouteCall[] = [
  ...ROUTES.filter((route) => ['PATCH', 'DELETE', 'POST invités', 'DELETE invité', 'POST stop'].includes(route.name)),
  { name: 'DELETE série', method: 'DELETE', path: (id) => `${evening(id)}?scope=series` },
];

describe('lecture : liste et détail', () => {
  it('liste : l hôte et l invité voient la soirée, un non-participant ne voit rien', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    const host = await listOf(cast.alice);
    expect(host.status).toBe(200);
    expect(host.body.items.map((item) => item.id)).toEqual([id]);
    expect(host.body.nextCursor).toBeNull();
    expect(await upcomingIds(cast.bob)).toEqual([id]);
    expect(await listOf(cast.carol)).toMatchObject({ status: 200, body: { items: [], nextCursor: null } });
  });

  it('nextCursor : une chaîne tant qu il reste une page, null à la dernière', async () => {
    const ids: string[] = [];
    for (const hours of [0, 1, 2]) {
      const created = await createEvening(cast.alice, draft({ title: `Soirée ${hours}`, startsAt: START + hours * HOUR, guests: [cast.bob.pid] }));
      ids.push(created.id);
    }
    const first = await listOf(cast.bob, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    // Témoin « présent » : la première page annonce une suite.
    expect(typeof first.body.nextCursor).toBe('string');
    const cursor = String(first.body.nextCursor);
    const second = await listOf(cast.bob, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.body.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(second.body.nextCursor).toBeNull();
  });

  it('scope=past : une soirée commencée passe dans les passées et sort des soirées à venir', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await upcomingIds(cast.bob)).toEqual([id]);
    vi.setSystemTime(START + MINUTE);
    expect((await listOf(cast.bob, '?scope=past')).body.items.map((item) => item.id)).toEqual([id]);
    expect(await upcomingIds(cast.bob)).toEqual([]);
  });

  it('scope=invites : une invitation sans réponse ; ma réponse la retire, l hôte n y figure jamais', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await listOf(cast.bob, '?scope=invites')).body.items.map((item) => item.id)).toEqual([id]);
    expect((await listOf(cast.alice, '?scope=invites')).body.items).toEqual([]);
    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response: 'yes' } })).toMatchObject({ status: 204 });
    expect((await listOf(cast.bob, '?scope=invites')).body.items).toEqual([]);
    expect(await upcomingIds(cast.bob)).toEqual([id]);
  });

  it('myResponse : absent pour l hôte, présent pour l invité, en liste comme en détail', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    const [hostItem] = (await listOf(cast.alice)).body.items;
    const [guestItem] = (await listOf(cast.bob)).body.items;
    expect(hostItem).toMatchObject({ id, isHost: true });
    expect(hostItem).not.toHaveProperty('myResponse');
    expect(guestItem).toMatchObject({ id, isHost: false, myResponse: 'pending' });
    expect((await detailOf(cast.alice, id)).body).not.toHaveProperty('myResponse');
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'pending');
  });

  it('party : absent du JSON tant qu aucun salon n est rattaché', async () => {
    // Témoin « présent » de `party` : impossible par HTTP à ce lot, puisqu aucune route ne rattache de salon
    // (EveningStore.attachParty, testé au niveau du store). Le témoin porte ici sur les champs optionnels voisins.
    const one = await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }));
    expect(one).not.toHaveProperty('party');
    expect(one).toMatchObject({ id: one.id, host: { pid: cast.alice.pid } });
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    expect(series).not.toHaveProperty('party');
    expect(series).toMatchObject({ seriesId: expect.any(String), recurrence: { freq: 'weekly', interval: 1 } });
    expect((await detailOf(cast.bob, series.id)).body).not.toHaveProperty('party');
  });

  it('détail : 404 evening_not_found pour un identifiant mal formé ou inconnu', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await detailOf(cast.bob, 'pas-un-identifiant')).toMatchObject({ status: 404, body: { error: 'evening_not_found' } });
    expect(await detailOf(cast.bob, UNKNOWN_ID)).toMatchObject({ status: 404, body: { error: 'evening_not_found' } });
    expect((await detailOf(cast.bob, id)).status).toBe(200);
  });

  it.each(['?scope=passe', '?limit=0', '?limit=51', '?limit=abc', '?cursor=n-importe-quoi', '?inconnu=1'])(
    'liste : paramètre refusé %s, 400 invalid_body',
    async (query) => {
      await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }));
      expect(await listOf(cast.alice, query)).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
      // Témoin : les bornes valides passent.
      expect(await listOf(cast.alice, '?limit=50&scope=upcoming')).toMatchObject({ status: 200 });
    },
  );
});

describe('création (POST)', () => {
  it('201 : la soirée, l hôte parmi les invités en oui, les invités en attente, titre épuré', async () => {
    const res = await as<EveningReply>(app, cast.alice, 'POST', EVENINGS, {
      body: draft({ title: '  Soirée jeux  ', guests: [cast.bob.pid] }),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Soirée jeux',
      tz: 'Europe/Paris',
      startsAt: START,
      isHost: true,
      status: 'scheduled',
      overridden: false,
      host: { pid: cast.alice.pid },
    });
    expect(guestOf(res.body, cast.alice.pid)?.response).toBe('yes');
    expect(guestOf(res.body, cast.bob.pid)?.response).toBe('pending');
    expect(res.body).not.toHaveProperty('myResponse');
    // Témoin « présent » : l invité, lui, voit sa réponse.
    expect((await detailOf(cast.bob, res.body.id)).body).toHaveProperty('myResponse', 'pending');
  });

  it('série : seriesId et recurrence présents, une soirée ponctuelle ne les porte pas ; quatre occurrences à venir', async () => {
    const one = await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }));
    expect(one).not.toHaveProperty('seriesId');
    expect(one).not.toHaveProperty('recurrence');
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    expect(series).toMatchObject({ seriesId: expect.any(String), recurrence: { freq: 'weekly', interval: 1 }, startsAt: ANCHOR });
    expect(await seriesItems(cast.alice, series.seriesId)).toHaveLength(4);
  });

  it.each<[string, Json]>([
    ['titre vide', { title: '   ' }],
    ['titre de 81 caractères', { title: 'x'.repeat(81) }],
    ['sans titre', { title: undefined }],
    ['début passé', { startsAt: NOW_MS - HOUR }],
    ['début à moins d une minute', { startsAt: NOW_MS + 30_000 }],
    ['début à plus de 90 jours', { startsAt: NOW_MS + 91 * DAY }],
    ['fuseau inconnu', { tz: 'Mars/Olympus' }],
    ['fuseau vide', { tz: '' }],
    ['clé inconnue', { extra: true }],
    ['récurrence à trois semaines', { recurrence: { freq: 'weekly', interval: 3 } }],
  ])('400 invalid_body : %s', async (_label, overrides) => {
    const res = await as(app, cast.alice, 'POST', EVENINGS, { body: draft(overrides) });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    // Témoin : rien n a été créé, et le même corps valide passe.
    expect(await upcomingIds(cast.alice)).toEqual([]);
    expect((await as(app, cast.alice, 'POST', EVENINGS, { body: draft() })).status).toBe(201);
  });

  it('bornes acceptées : titre de 80 caractères, début à une minute, début à 90 jours', async () => {
    for (const body of [draft({ title: 'x'.repeat(80) }), draft({ startsAt: NOW_MS + MINUTE }), draft({ startsAt: NOW_MS + 90 * DAY })]) {
      expect((await as(app, cast.alice, 'POST', EVENINGS, { body })).status).toBe(201);
    }
  });

  it('invités : 20 pids refusés par le schéma (400), 19 passent le schéma et tombent en not_friend (403)', async () => {
    const pids = Array.from({ length: 20 }, (_, i) => `pid-${i}`);
    expect(await as(app, cast.alice, 'POST', EVENINGS, { body: draft({ guests: pids }) })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect(await as(app, cast.alice, 'POST', EVENINGS, { body: draft({ guests: pids.slice(0, 19) }) })).toMatchObject({
      status: 403,
      body: { error: 'not_friend' },
    });
  });

  it('plafond : la 11e soirée à venir est refusée (429 too_many_evenings)', async () => {
    for (let i = 0; i < 10; i += 1) {
      await createEvening(cast.alice, draft({ title: `Soirée ${i}`, startsAt: START + i * HOUR }));
    }
    expect(await as(app, cast.alice, 'POST', EVENINGS, { body: draft({ startsAt: START + 10 * HOUR }) })).toMatchObject({
      status: 429,
      body: { error: 'too_many_evenings' },
    });
    expect(await upcomingIds(cast.alice)).toHaveLength(10);
  });

  it('plafond : la sixième série active est refusée (429) ; les occurrences ne comptent pas parmi les soirées', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createEvening(cast.alice, seriesDraft({ title: `Série ${i}` }));
    }
    expect(await as(app, cast.alice, 'POST', EVENINGS, { body: seriesDraft({ title: 'Série 6' }) })).toMatchObject({
      status: 429,
      body: { error: 'too_many_evenings' },
    });
    // Témoin : une soirée ponctuelle reste possible.
    expect((await as(app, cast.alice, 'POST', EVENINGS, { body: draft() })).status).toBe(201);
  });

  it('non-ami et foyer : 403 not_friend ; un ami accepté passe (témoin)', async () => {
    expect((await createInviting(cast.bob)).status).toBe(201);
    expect(await createInviting(cast.carol)).toEqual(NOT_FRIEND);
    expect(await createInviting(cast.alice2)).toEqual(NOT_FRIEND);
  });

  it('demande en attente : même refus que pour un non-ami', async () => {
    expect((await createInviting(cast.bob)).status).toBe(201);
    expect(await createInviting(cast.carol)).toEqual(NOT_FRIEND);
    expect((await as(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.carol.full } })).status).toBe(201);
    expect(await createInviting(cast.carol)).toEqual(NOT_FRIEND);
  });

  it('bloqué par moi (A vers B) : même refus à la création et à l invitation', async () => {
    const id = (await createEvening(cast.alice, draft())).id;
    expect((await createInviting(cast.bob)).status).toBe(201);
    await block(app, cast.alice, cast.bob);
    expect(await createInviting(cast.bob)).toEqual(NOT_FRIEND);
    expect(await addInvite(id, cast.bob)).toEqual(NOT_FRIEND);
    expect(await addInvite(id, cast.carol)).toEqual(NOT_FRIEND);
  });

  it('bloqué par lui (B vers A) : même refus à la création', async () => {
    expect((await createInviting(cast.bob)).status).toBe(201);
    await block(app, cast.bob, cast.alice);
    expect(await createInviting(cast.bob)).toEqual(NOT_FRIEND);
    expect(await createInviting(cast.carol)).toEqual(NOT_FRIEND);
  });
});

describe('modification (PATCH)', () => {
  it('titre : 204, le nouveau titre est visible de l invité', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await detailOf(cast.bob, id)).body.title).toBe('Film du soir');
    expect(await as(app, cast.alice, 'PATCH', evening(id), { body: { title: 'Renommée', scope: 'occurrence' } })).toMatchObject({
      status: 204,
    });
    expect((await detailOf(cast.bob, id)).body.title).toBe('Renommée');
  });

  it('début d une occurrence : 204 ; l invité qui avait répondu oui repasse en attente', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response: 'yes' } })).toMatchObject({ status: 204 });
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'yes');
    expect(await as(app, cast.alice, 'PATCH', evening(id), { body: { scope: 'occurrence', startsAt: START + HOUR } })).toMatchObject({
      status: 204,
    });
    expect((await detailOf(cast.bob, id)).body).toMatchObject({ startsAt: START + HOUR, myResponse: 'pending' });
  });

  it.each<[string, Json]>([
    ['scope seul', { scope: 'occurrence' }],
    ['scope seul, série', { scope: 'series' }],
    ['scope absent', { title: 'Nouveau' }],
    ['scope inconnu', { title: 'Nouveau', scope: 'tout' }],
    ['clé en trop', { title: 'Nouveau', scope: 'occurrence', extra: true }],
    ['titre de 81 caractères', { title: 'x'.repeat(81), scope: 'occurrence' }],
    ['début passé', { startsAt: NOW_MS - HOUR, scope: 'occurrence' }],
  ])('400 invalid_body : %s', async (_label, body) => {
    const id = (await createEvening(cast.alice, draft())).id;
    expect(await as(app, cast.alice, 'PATCH', evening(id), { body })).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect((await detailOf(cast.alice, id)).body.title).toBe('Film du soir');
    // Témoin : un corps valide passe sur la même soirée.
    expect(await as(app, cast.alice, 'PATCH', evening(id), { body: { title: 'Accepté', scope: 'occurrence' } })).toMatchObject({
      status: 204,
    });
  });

  it('série : scope=series change le titre de toutes les occurrences à venir', async () => {
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    expect(await statusesOf(cast.bob, series.seriesId)).toEqual(FOUR_SCHEDULED);
    expect(await as(app, cast.alice, 'PATCH', evening(series.id), { body: { scope: 'series', title: 'Série renommée' } })).toMatchObject({
      status: 204,
    });
    const items = await seriesItems(cast.bob, series.seriesId);
    expect(items.map((item) => item.title)).toEqual(['Série renommée', 'Série renommée', 'Série renommée', 'Série renommée']);
  });
});

describe('annulation (DELETE) et arrêt de série', () => {
  it('sans scope : annule l occurrence (204) ; le statut « annulée » reste visible, à venir comprises', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await detailOf(cast.bob, id)).body.status).toBe('scheduled');
    expect(await as(app, cast.alice, 'DELETE', evening(id))).toMatchObject({ status: 204 });
    expect((await detailOf(cast.alice, id)).body.status).toBe('cancelled');
    expect((await detailOf(cast.bob, id)).body.status).toBe('cancelled');
    expect(await upcomingIds(cast.bob)).toEqual([id]);
  });

  it('?scope=series sur une soirée ponctuelle, ou un scope inconnu : 400, rien n est annulé', async () => {
    const id = (await createEvening(cast.alice, draft())).id;
    expect(await as(app, cast.alice, 'DELETE', `${evening(id)}?scope=series`)).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect(await as(app, cast.alice, 'DELETE', `${evening(id)}?scope=tout`)).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect((await detailOf(cast.alice, id)).body.status).toBe('scheduled');
  });

  it('?scope=series arrête la série : 204, ses occurrences à venir passent en annulé pour tous', async () => {
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    expect(await statusesOf(cast.bob, series.seriesId)).toEqual(FOUR_SCHEDULED);
    expect(await as(app, cast.alice, 'DELETE', `${evening(series.id)}?scope=series`)).toMatchObject({ status: 204 });
    expect(await statusesOf(cast.alice, series.seriesId)).toEqual(FOUR_CANCELLED);
    expect(await statusesOf(cast.bob, series.seriesId)).toEqual(FOUR_CANCELLED);
  });
});

describe('arrêt de série (POST stop)', () => {
  it('204 sur une série, 409 si elle est déjà arrêtée, 400 sur une soirée ponctuelle', async () => {
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    const one = await createEvening(cast.alice, draft());
    expect(await as(app, cast.alice, 'POST', `${evening(one.id)}/stop`)).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect(await statusesOf(cast.bob, series.seriesId)).toEqual(FOUR_SCHEDULED);
    expect(await as(app, cast.alice, 'POST', `${evening(series.id)}/stop`)).toMatchObject({ status: 204 });
    expect(await statusesOf(cast.bob, series.seriesId)).toEqual(FOUR_CANCELLED);
    expect(await as(app, cast.alice, 'POST', `${evening(series.id)}/stop`)).toMatchObject({
      status: 409,
      body: { error: 'evening_closed' },
    });
  });
});

describe('sortie (POST leave)', () => {
  it('scope=occurrence : 204, ma réponse passe à « non », la soirée reste visible', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'pending');
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/leave`, { body: { scope: 'occurrence' } })).toMatchObject({ status: 204 });
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'no');
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid)?.response).toBe('no');
  });

  it('scope=series : 204, mes occurrences à venir disparaissent de ma liste ; celles de l hôte restent', async () => {
    const series = await createEvening(cast.alice, seriesDraft({ guests: [cast.bob.pid] }));
    expect(await seriesItems(cast.bob, series.seriesId)).toHaveLength(4);
    expect(await as(app, cast.bob, 'POST', `${evening(series.id)}/leave`, { body: { scope: 'series' } })).toMatchObject({ status: 204 });
    expect(await seriesItems(cast.bob, series.seriesId)).toHaveLength(0);
    expect(await seriesItems(cast.alice, series.seriesId)).toHaveLength(4);
  });

  it('400 : scope=series sur une soirée ponctuelle, corps invalide', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/leave`, { body: { scope: 'series' } })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/leave`, { body: {} })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/leave`, { body: { scope: 'occurrence', extra: true } })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    // Témoin : bob est toujours invité, réponse inchangée.
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'pending');
  });

  it('409 evening_closed sur une soirée annulée', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.alice, 'DELETE', evening(id))).toMatchObject({ status: 204 });
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/leave`, { body: { scope: 'occurrence' } })).toMatchObject({
      status: 409,
      body: { error: 'evening_closed' },
    });
  });
});

describe('invités (POST et DELETE …/guests)', () => {
  it('POST : 204 ; l ami invité voit la soirée en attente ; un invité déjà présent garde sa réponse', async () => {
    await befriend(app, cast.alice, cast.carol);
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await detailOf(cast.carol, id)).status).toBe(404);
    expect(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body: { pids: [cast.carol.pid] } })).toMatchObject({ status: 204 });
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.carol.pid)?.response).toBe('pending');
    expect((await detailOf(cast.carol, id)).body).toHaveProperty('myResponse', 'pending');

    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response: 'yes' } })).toMatchObject({ status: 204 });
    expect(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body: { pids: [cast.bob.pid] } })).toMatchObject({ status: 204 });
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid)?.response).toBe('yes');
  });

  it.each<[string, Json]>([
    ['corps vide', {}],
    ['pids vide', { pids: [] }],
    ['clé en trop', { pids: ['pid-inconnu'], extra: true }],
    ['20 pids', { pids: Array.from({ length: 20 }, (_, i) => `pid-${i}`) }],
  ])('400 invalid_body : %s', async (_label, body) => {
    const id = (await createEvening(cast.alice, draft())).id;
    expect(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body })).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    // Témoin : 19 pids inconnus passent le schéma et tombent en refus d ami.
    const nineteen = Array.from({ length: 19 }, (_, i) => `pid-${i}`);
    expect(await as(app, cast.alice, 'POST', `${evening(id)}/guests`, { body: { pids: nineteen } })).toMatchObject({
      status: 403,
      body: { error: 'not_friend' },
    });
  });

  it('DELETE /guests/:pid : 204, l invité retiré ne voit plus la soirée (404)', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect((await detailOf(cast.bob, id)).status).toBe(200);
    expect(await as(app, cast.alice, 'DELETE', `${evening(id)}/guests/${cast.bob.pid}`)).toMatchObject({ status: 204 });
    expect((await detailOf(cast.bob, id)).status).toBe(404);
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid)).toBeUndefined();
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.alice.pid)).toBeDefined();
  });

  it('DELETE /guests/:pid : pid inconnu ou mal formé, 204 sans effet ; l hôte ne se retire pas (400)', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.alice, 'DELETE', `${evening(id)}/guests/pid-inconnu`)).toMatchObject({ status: 204 });
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid)).toBeDefined();
    expect(await as(app, cast.alice, 'DELETE', `${evening(id)}/guests/${cast.alice.pid}`)).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' },
    });
    expect((await detailOf(cast.bob, id)).status).toBe(200);
  });
});

describe('réponse (PUT /response)', () => {
  it('204 : ma réponse change et l hôte la voit ; la date de réponse n apparaît qu après une réponse', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    const before = guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid);
    expect(before).toMatchObject({ response: 'pending' });
    expect(before).not.toHaveProperty('respondedAt');
    // Témoin « présent » : la date existe pour l hôte, dont la réponse est posée à la création.
    expect(guestOf((await detailOf(cast.alice, id)).body, cast.alice.pid)).toHaveProperty('respondedAt', NOW_MS);
    for (const response of ['yes', 'maybe', 'no'] as const) {
      expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response } })).toMatchObject({ status: 204 });
      expect(guestOf((await detailOf(cast.alice, id)).body, cast.bob.pid)).toMatchObject({ response, respondedAt: NOW_MS });
      expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', response);
    }
  });

  it.each<[string, Json]>([
    ['pending n est pas une réponse', { response: 'pending' }],
    ['valeur inconnue', { response: 'peut-etre' }],
    ['clé en trop', { response: 'yes', extra: true }],
    ['corps vide', {}],
  ])('400 invalid_body : %s', async (_label, body) => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body })).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'pending');
    // Témoin : une réponse valide passe.
    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response: 'yes' } })).toMatchObject({ status: 204 });
  });

  it('soirée annulée : 409 evening_closed, ma réponse ne bouge pas', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.alice, 'DELETE', evening(id))).toMatchObject({ status: 204 });
    expect(await as(app, cast.bob, 'PUT', `${evening(id)}/response`, { body: { response: 'yes' } })).toMatchObject({
      status: 409,
      body: { error: 'evening_closed' },
    });
    expect((await detailOf(cast.bob, id)).body).toHaveProperty('myResponse', 'pending');
  });
});

describe('droits', () => {
  it.each(ON_EVENING)('non-participant (carol) : 404 evening_not_found — $name', async (route) => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(shape(await as(app, cast.carol, route.method, route.path(id), { body: route.body }))).toEqual({
      status: 404,
      body: { error: 'evening_not_found' },
    });
    // Témoins : l invité la voit, et rien n a bougé pour l hôte.
    expect((await detailOf(cast.bob, id)).status).toBe(200);
    expect((await detailOf(cast.alice, id)).body).toMatchObject({ title: 'Film du soir', status: 'scheduled' });
  });

  it.each(HOST_ONLY)('invité (bob) : 403 not_host — $name', async (route) => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(shape(await as(app, cast.bob, route.method, route.path(id), { body: route.body }))).toEqual({
      status: 403,
      body: { error: 'not_host' },
    });
    // Témoins : bob lit toujours la soirée, et elle n a pas changé.
    expect((await detailOf(cast.bob, id)).status).toBe(200);
    expect((await detailOf(cast.alice, id)).body).toMatchObject({ title: 'Film du soir', status: 'scheduled' });
  });

  it('hôte : 403 not_host sur PUT /response et POST /leave ; témoin : l hôte lit sa soirée', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(shape(await as(app, cast.alice, 'PUT', `${evening(id)}/response`, { body: { response: 'no' } }))).toEqual({
      status: 403,
      body: { error: 'not_host' },
    });
    expect(shape(await as(app, cast.alice, 'POST', `${evening(id)}/leave`, { body: { scope: 'occurrence' } }))).toEqual({
      status: 403,
      body: { error: 'not_host' },
    });
    expect((await detailOf(cast.alice, id)).body).toHaveProperty('isHost', true);
  });
});

describe('profil enfant', () => {
  it.each(ROUTES)('403 kid_profile — $name', async (route) => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    const before = (await detailOf(cast.alice, id)).body;
    expect(shape(await as(app, cast.kid, route.method, route.path(id), { body: route.body }))).toEqual({
      status: 403,
      body: { error: 'kid_profile' },
    });
    // Témoin : rien n a bougé, et le même profil sans enfant lit toujours la soirée.
    expect((await detailOf(cast.alice, id)).body).toEqual(before);
  });
});

describe('ouverture du salon (POST /open)', () => {
  it('501 not_implemented pour un participant (hôte ou invité), 404 pour un non-participant', async () => {
    const id = (await createEvening(cast.alice, draft({ guests: [cast.bob.pid] }))).id;
    expect(await as(app, cast.bob, 'POST', `${evening(id)}/open`)).toMatchObject({ status: 501, body: { error: 'not_implemented' } });
    expect(await as(app, cast.alice, 'POST', `${evening(id)}/open`)).toMatchObject({ status: 501, body: { error: 'not_implemented' } });
    expect(await as(app, cast.carol, 'POST', `${evening(id)}/open`)).toMatchObject({ status: 404, body: { error: 'evening_not_found' } });
  });
});
