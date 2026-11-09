import { describe, expect, it } from 'vitest';
import { reminderFrames, startEveningTicker } from '../src/user/social-evenings-live.js';
import type { UserBackend } from '../src/user/repo.js';
import { asyncRepo } from '../src/user/repo.js';
import type { Scheduler } from '../src/platform/types.js';
import { openUserDb } from '../src/platform/node/user-db.js';
import { type EveningView, EveningStore, type SeriesRuleInput } from '../src/user/social-evenings-store.js';
import { SocialV2Store } from '../src/user/social-v2-store.js';

/**
 * Soirées planifiées au niveau du store (LAST-198, lot L1a) : CRUD, droits, ami seulement, blocage, plafonds, détachement,
 * rappels idempotents, récurrence (sortie, arrêt, occurrence modifiée qui survit), purge et cascade de la migration 34.
 */

const NOW = Date.parse('2026-05-01T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ALICE = 'ALICEPID000AAAA';
const TWIN = 'TWINPIDAAAAAAAAA';
const BOB = 'BOBPIDAAAAAAAAAA';
const CAROL = 'CAROLPIDAAAAAAAA';
const DAVE = 'DAVEPIDAAAAAAAAA';
const ERIC = 'ERICPIDAAAAAAAAA';
const FRANK = 'FRANKPIDAAAAAAAA';
const KIDP = 'KIDPIDAAAAAAAAAA';
const GHOST = 'GHOSTPIDAAAAAAAA';
/** Vingt amis supplémentaires, pour tester le plafond d'invités. */
const FRIENDS = Array.from({ length: 20 }, (_, i) => `F${String(i).padStart(3, '0')}PIDAAAAAAAAA`);

/** Mardi 5 mai 2026 à 20:00 à Paris (18:00 UTC) : première occurrence des séries de test. */
const ANCHOR = Date.parse('2026-05-05T18:00:00.000Z');
const PARIS_TUESDAY: SeriesRuleInput = { tz: 'Europe/Paris', weekday: 2, localTime: '20:00', interval: 1, untilAt: null };

type Db = ReturnType<typeof openUserDb>;

function profile(db: Db, id: string, accountId: string, pid: string | null, name: string, isKid = 0): void {
  db.prepare(
    `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
     VALUES (?, ?, ?, '#00ff00', ?, ?, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
  ).run(id, accountId, name, isKid, isKid === 1 ? 12 : null, pid, name, name.toLowerCase());
}

function account(db: Db, id: string, username: string): void {
  db.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', 0, '2026-01-01')").run(id, username);
}

/** Lien entre deux profils : `accepted` (ami), `pending` (demande en attente). */
function link(db: Db, a: string, b: string, status: 'accepted' | 'pending' = 'accepted'): void {
  const [low, high] = a < b ? [a, b] : [b, a];
  db.prepare('INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, ?, ?)').run(low, high, a, status, NOW);
}

function seeded() {
  const db = openUserDb(':memory:');
  account(db, 'a1', 'alice');
  account(db, 'a2', 'bob');
  account(db, 'a3', 'carol');
  account(db, 'a4', 'dave');
  account(db, 'a5', 'eric');
  account(db, 'a6', 'frank');
  account(db, 'a7', 'kid');
  profile(db, 'p-alice', 'a1', ALICE, 'Alice');
  profile(db, 'p-twin', 'a1', TWIN, 'Twin');
  profile(db, 'p-bob', 'a2', BOB, 'Bob');
  profile(db, 'p-carol', 'a3', CAROL, 'Carol');
  profile(db, 'p-dave', 'a4', DAVE, 'Dave');
  profile(db, 'p-eric', 'a5', ERIC, 'Eric');
  profile(db, 'p-frank', 'a6', FRANK, 'Frank');
  profile(db, 'p-kid', 'a7', KIDP, 'Petit', 1);
  FRIENDS.forEach((pid, i) => {
    account(db, `af${i}`, `friend${i}`);
    profile(db, `pf${i}`, `af${i}`, pid, `Amie${i}`);
    link(db, ALICE, pid);
  });
  link(db, ALICE, BOB);
  link(db, ALICE, CAROL);
  link(db, ALICE, FRANK);
  link(db, ALICE, ERIC);
  link(db, ALICE, KIDP);
  link(db, ALICE, DAVE, 'pending');
  // Eric est bloqué par Alice (le lien d'amitié existe encore : seul le blocage compte).
  db.prepare('INSERT INTO blocks (blocker_pid, blocked_pid, created_at) VALUES (?, ?, ?)').run(ALICE, ERIC, NOW);
  return { db, store: new EveningStore(db), social: new SocialV2Store(db) };
}

/** Soirée attendue : échoue si le résultat n'est pas `ok`. */
function evOf(outcome: { result: string; evening?: EveningView | null }): EveningView {
  expect(outcome.result).toBe('ok');
  if (!outcome.evening) throw new Error('soirée absente du résultat');
  return outcome.evening;
}

const guestPids = (evening: EveningView): string[] => evening.guests.map((guest) => guest.pid);
const responseOf = (evening: EveningView, pid: string): string | undefined => evening.guests.find((guest) => guest.pid === pid)?.response;

describe('soirées : création et lecture', () => {
  it('soirée ponctuelle : l hôte figure parmi les invités (oui), les invités sont en attente, le titre est épuré', () => {
    const { store } = seeded();
    const evening = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: '  Film du soir  ', startsAt: NOW + 2 * HOUR, guests: [BOB, CAROL] }, NOW));
    expect(evening).toMatchObject({ title: 'Film du soir', role: 'host', myResponse: 'yes', status: 'scheduled', overridden: false, series: null });
    expect(guestPids(evening)).toEqual([ALICE, BOB, CAROL].sort());
    expect(responseOf(evening, ALICE)).toBe('yes');
    expect(responseOf(evening, BOB)).toBe('pending');

    const seen = store.get(BOB, evening.id);
    expect(seen).toMatchObject({ result: 'ok', evening: { role: 'guest', myResponse: 'pending' } });
  });

  it('bornes du titre (1 à 80 caractères) et du début (entre une minute et 90 jours)', () => {
    const { store } = seeded();
    const base = { startsAt: NOW + 2 * HOUR, guests: [] as string[] };
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: '   ' }, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: 'x'.repeat(81) }, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: 'x'.repeat(80) }, NOW).result).toBe('ok');
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: 'ok', startsAt: NOW + 30_000 }, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: 'ok', startsAt: NOW + MIN }, NOW).result).toBe('ok');
    expect(store.create(ALICE, { tz: 'Europe/Paris', ...base, title: 'ok', startsAt: NOW + 91 * DAY }, NOW)).toEqual({ result: 'invalid_body' });
  });

  it('fuseau : persisté sur la soirée ponctuelle, copié sur chaque occurrence ; une série dont le fuseau diffère du corps est refusée', () => {
    const { store } = seeded();
    const oneOff = evOf(store.create(ALICE, { tz: 'Asia/Tokyo', title: 'Tokyo', startsAt: NOW + 2 * HOUR, guests: [] }, NOW));
    expect(oneOff.tz).toBe('Asia/Tokyo');
    expect(store.get(ALICE, oneOff.id)).toMatchObject({ result: 'ok', evening: { tz: 'Asia/Tokyo' } });

    evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    const listed = store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW);
    expect(listed.result === 'ok' && listed.items.length).toBe(4);
    expect(listed.result === 'ok' && listed.items.every((item) => item.tz === 'Europe/Paris')).toBe(true);

    expect(store.create(ALICE, { tz: 'UTC', title: 'Mardi', startsAt: ANCHOR, guests: [], series: PARIS_TUESDAY }, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.create(ALICE, { tz: 'Mars/Olympus', title: 'x', startsAt: NOW + 2 * HOUR, guests: [] }, NOW)).toEqual({ result: 'invalid_body' });
  });

  it('liste : à venir par date, curseur keyset, invitations sans réponse, passées en ordre inverse', () => {
    const { store } = seeded();
    const ids = [1, 2, 3].map((h) => evOf(store.create(ALICE, { tz: 'Europe/Paris', title: `S${h}`, startsAt: NOW + h * HOUR, guests: [BOB] }, NOW)).id);

    const first = store.list(BOB, { scope: 'upcoming', limit: 2 }, NOW);
    expect(first.result).toBe('ok');
    if (first.result !== 'ok') return;
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = store.list(BOB, { scope: 'upcoming', limit: 2, cursor: first.nextCursor ?? undefined }, NOW);
    expect(second).toEqual({ result: 'ok', items: [expect.objectContaining({ id: ids[2] })], nextCursor: null });

    expect(store.list(BOB, { scope: 'invites', limit: 50 }, NOW)).toMatchObject({ result: 'ok', items: expect.any(Array) });
    expect(store.list(ALICE, { scope: 'invites', limit: 50 }, NOW)).toEqual({ result: 'ok', items: [], nextCursor: null });

    store.respond(BOB, ids[0] ?? '', 'yes', NOW);
    const invites = store.list(BOB, { scope: 'invites', limit: 50 }, NOW);
    expect(invites.result === 'ok' && invites.items.map((item) => item.id)).toEqual(ids.slice(1));

    const past = store.list(BOB, { scope: 'past', limit: 50 }, NOW + 4 * HOUR);
    expect(past.result === 'ok' && past.items.map((item) => item.id)).toEqual([...ids].reverse());
    expect(store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW + 4 * HOUR)).toEqual({ result: 'ok', items: [], nextCursor: null });

    expect(store.list(BOB, { scope: 'upcoming', limit: 51 }, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.list(BOB, { scope: 'upcoming', limit: 5, cursor: 'n-importe-quoi' }, NOW)).toEqual({ result: 'invalid_body' });
  });

  it('visibilité : un profil étranger ne voit ni la soirée ni la liste', () => {
    const { store } = seeded();
    const evening = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Privé', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.get(CAROL, evening.id)).toEqual({ result: 'evening_not_found' });
    expect(store.list(CAROL, { scope: 'upcoming', limit: 50 }, NOW)).toEqual({ result: 'ok', items: [], nextCursor: null });
  });
});

describe('soirées : droits', () => {
  it('un invité ne modifie, n annule, n invite, ne retire pas ; l hôte ne répond ni ne quitte', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB, CAROL] }, NOW));
    expect(store.update(BOB, id, { scope: 'occurrence', title: 'Autre' }, NOW)).toEqual({ result: 'not_host' });
    expect(store.cancel(BOB, id, 'occurrence', NOW)).toEqual({ result: 'not_host' });
    expect(store.addGuests(BOB, id, [FRIENDS[0] ?? ''], NOW)).toEqual({ result: 'not_host' });
    expect(store.removeGuest(BOB, id, CAROL, NOW)).toEqual({ result: 'not_host' });
    expect(store.respond(ALICE, id, 'yes', NOW)).toEqual({ result: 'not_host' });
    expect(store.leave(ALICE, id, 'occurrence', NOW)).toEqual({ result: 'not_host' });
  });

  it('un profil non participant obtient evening_not_found pour toute action', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.get(CAROL, id)).toEqual({ result: 'evening_not_found' });
    expect(store.update(CAROL, id, { scope: 'occurrence', title: 'x' }, NOW)).toEqual({ result: 'evening_not_found' });
    expect(store.respond(CAROL, id, 'yes', NOW)).toEqual({ result: 'evening_not_found' });
    expect(store.cancel(CAROL, id, 'occurrence', NOW)).toEqual({ result: 'evening_not_found' });
    expect(store.leave(CAROL, id, 'occurrence', NOW)).toEqual({ result: 'evening_not_found' });
  });

  it('réponse : oui, peut-être, non ; une valeur hors liste est refusée ; une soirée commencée est close', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.respond(BOB, id, 'maybe', NOW)).toEqual({ result: 'ok' });
    expect(store.get(BOB, id)).toMatchObject({ evening: { myResponse: 'maybe' } });
    expect(store.respond(BOB, id, 'pending' as never, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.respond(BOB, id, 'yes', NOW + 2 * HOUR)).toEqual({ result: 'evening_closed' });
  });

  it('quitter une soirée passe la réponse à non, la soirée reste visible', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.leave(BOB, id, 'occurrence', NOW)).toEqual({ result: 'ok' });
    expect(store.get(BOB, id)).toMatchObject({ evening: { myResponse: 'no' } });
  });

  it('modifier une soirée close (annulée) répond evening_closed', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [] }, NOW));
    expect(store.cancel(ALICE, id, 'occurrence', NOW)).toEqual({ result: 'ok' });
    expect(store.update(ALICE, id, { scope: 'occurrence', title: 'Repris' }, NOW)).toEqual({ result: 'evening_closed' });
    expect(store.cancel(ALICE, id, 'occurrence', NOW)).toEqual({ result: 'evening_closed' });
  });
});

describe('soirées : amis et foyer seulement', () => {
  it('invités : amis acceptés et foyer ; même réponse pour tout autre profil (en attente, bloqué, enfant, inconnu)', () => {
    const { store, db } = seeded();
    const others = [DAVE, ERIC, KIDP, GHOST];
    const outcomes = others.map((pid) => store.create(ALICE, { tz: 'Europe/Paris', title: 'x', startsAt: NOW + 2 * HOUR, guests: [pid] }, NOW));
    for (const outcome of outcomes) expect(outcome).toEqual({ result: 'not_friend' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM evening_guests WHERE pid IN (?, ?, ?, ?)').get(...others) as { n: number }).n).toBe(0);
  });

  it('foyer : un autre profil adulte du même compte (non ami) s invite à la création et par addGuests ; un profil enfant du foyer reste refusé', () => {
    const { store, db } = seeded();
    profile(db, 'p-alice-kid', 'a1', 'ALKIDPIDAAAAAAAA', 'Mini', 1);
    const evening = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'En famille', startsAt: NOW + 2 * HOUR, guests: [TWIN, BOB] }, NOW));
    expect(guestPids(evening)).toEqual([ALICE, BOB, TWIN].sort());
    expect(store.get(TWIN, evening.id)).toMatchObject({ result: 'ok', evening: { role: 'guest', myResponse: 'pending' } });
    const other = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Autre', startsAt: NOW + 3 * HOUR, guests: [] }, NOW));
    expect(store.addGuests(ALICE, other.id, [TWIN], NOW)).toEqual({ result: 'ok' });
    expect(store.addGuests(ALICE, other.id, ['ALKIDPIDAAAAAAAA'], NOW)).toEqual({ result: 'not_friend' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'x', startsAt: NOW + 2 * HOUR, guests: ['ALKIDPIDAAAAAAAA'] }, NOW)).toEqual({ result: 'not_friend' });
  });

  it('addGuests applique la même règle : un seul profil non ami fait échouer l ajout', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.addGuests(ALICE, id, [CAROL, DAVE], NOW)).toEqual({ result: 'not_friend' });
    expect(guestPids(evOf(store.get(ALICE, id)))).not.toContain(CAROL);
  });

  it('pid mal formé ou vide : traité comme un pid inconnu, not_friend à la création et à l ajout ; retirer un pid non invité est sans effet', () => {
    const { store } = seeded();
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'x', startsAt: NOW + 2 * HOUR, guests: ['pas un pid', ''] }, NOW)).toEqual({ result: 'not_friend' });
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.addGuests(ALICE, id, ['pas un pid'], NOW)).toEqual({ result: 'not_friend' });
    expect(store.removeGuest(ALICE, id, 'pas un pid', NOW)).toEqual({ result: 'ok' });
  });

  it('blocage après amitié : le blocage (par le profil bloqué) retire l accès ; detach retire l invité des soirées futures', () => {
    const { store, social } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [FRANK] }, NOW));
    expect(social.blockProfile(FRANK, ALICE, NOW)).toMatchObject({ result: 'ok' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Nouveau', startsAt: NOW + 3 * HOUR, guests: [FRANK] }, NOW)).toEqual({ result: 'not_friend' });
    store.detach(ALICE, FRANK, NOW);
    expect(store.get(FRANK, id)).toEqual({ result: 'evening_not_found' });
    expect(store.get(ALICE, id)).toMatchObject({ result: 'ok' });
  });
});

describe('soirées : plafonds', () => {
  it('invités : 19 au plus, hôte compris 20 ; un ajout qui dépasse est refusé', () => {
    const { store } = seeded();
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Trop', startsAt: NOW + 2 * HOUR, guests: FRIENDS.slice(0, 20) }, NOW)).toEqual({ result: 'invalid_body' });
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Plein', startsAt: NOW + 2 * HOUR, guests: FRIENDS.slice(0, 19) }, NOW));
    expect(store.get(ALICE, id)).toMatchObject({ evening: { guests: expect.any(Array) } });
    expect(store.addGuests(ALICE, id, [FRIENDS[19] ?? ''], NOW)).toEqual({ result: 'invalid_body' });
  });

  it('soirées ponctuelles : 10 à venir au plus ; une annulée libère sa place', () => {
    const { store } = seeded();
    const made = Array.from({ length: 10 }, (_, i) => store.create(ALICE, { tz: 'Europe/Paris', title: `S${i}`, startsAt: NOW + (i + 1) * HOUR, guests: [] }, NOW));
    for (const outcome of made) expect(outcome.result).toBe('ok');
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Onzième', startsAt: NOW + 20 * HOUR, guests: [] }, NOW)).toEqual({ result: 'too_many_evenings' });
    const first = made[0];
    if (first?.result !== 'ok') throw new Error('première soirée absente');
    expect(store.cancel(ALICE, first.evening.id, 'occurrence', NOW)).toEqual({ result: 'ok' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Onzième', startsAt: NOW + 20 * HOUR, guests: [] }, NOW).result).toBe('ok');
  });

  it('séries : 5 actives au plus, les occurrences ne comptent pas parmi les soirées ponctuelles', () => {
    const { store } = seeded();
    const monday: SeriesRuleInput = { tz: 'UTC', weekday: 1, localTime: '09:00', interval: 1, untilAt: null };
    const startsAt = Date.parse('2026-05-04T09:00:00.000Z');
    for (let i = 0; i < 5; i++) expect(store.create(ALICE, { tz: 'UTC', title: `Série ${i}`, startsAt, guests: [], series: monday }, NOW).result).toBe('ok');
    expect(store.create(ALICE, { tz: 'UTC', title: 'Sixième', startsAt, guests: [], series: monday }, NOW)).toEqual({ result: 'too_many_evenings' });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Ponctuelle', startsAt: NOW + 2 * HOUR, guests: [] }, NOW).result).toBe('ok');
  });

  it('série : fin au plus un an ; début sur la règle ; fuseau, heure et cadence valides', () => {
    const { store } = seeded();
    const startsAt = ANCHOR;
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Loin', startsAt, guests: [], series: { ...PARIS_TUESDAY, untilAt: NOW + 366 * DAY } }, NOW)).toEqual({
      result: 'invalid_body',
    });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Proche', startsAt, guests: [], series: { ...PARIS_TUESDAY, untilAt: NOW + 300 * DAY } }, NOW).result).toBe('ok');
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mercredi', startsAt, guests: [], series: { ...PARIS_TUESDAY, weekday: 3 } }, NOW)).toEqual({
      result: 'invalid_body',
    });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Fuseau', startsAt, guests: [], series: { ...PARIS_TUESDAY, tz: 'Mars/Olympus' } }, NOW)).toEqual({
      result: 'invalid_body',
    });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Heure', startsAt, guests: [], series: { ...PARIS_TUESDAY, localTime: '24:00' } }, NOW)).toEqual({
      result: 'invalid_body',
    });
    expect(store.create(ALICE, { tz: 'Europe/Paris', title: 'Cadence', startsAt, guests: [], series: { ...PARIS_TUESDAY, interval: 3 as never } }, NOW)).toEqual({
      result: 'invalid_body',
    });
  });
});

describe('soirées : modification et récurrence', () => {
  it('occurrence dont le début change : réponses remises en attente, sauf celle de l hôte ; titre seul : réponses gardées', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB, CAROL] }, NOW));
    store.respond(BOB, id, 'yes', NOW);
    const renamed = evOf(store.update(ALICE, id, { scope: 'occurrence', title: 'Dîner chez Bob' }, NOW));
    expect(renamed).toMatchObject({ title: 'Dîner chez Bob', overridden: false });
    expect(responseOf(renamed, BOB)).toBe('yes');

    const moved = evOf(store.update(ALICE, id, { scope: 'occurrence', startsAt: NOW + 5 * HOUR }, NOW));
    expect(moved.startsAt).toBe(NOW + 5 * HOUR);
    expect(responseOf(moved, BOB)).toBe('pending');
    expect(responseOf(moved, CAROL)).toBe('pending');
    expect(responseOf(moved, ALICE)).toBe('yes');
  });

  it('série : création de la fenêtre de quatre occurrences, invités copiés sur chacune', () => {
    const { store } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    expect(first.series).toMatchObject({ status: 'active', tz: 'Europe/Paris', weekday: 2, localTime: '20:00', interval: 1, untilAt: null });
    const listed = store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW);
    expect(listed.result === 'ok' && listed.items.map((item) => item.startsAt)).toEqual([0, 1, 2, 3].map((k) => ANCHOR + k * 7 * DAY));
    expect(listed.result === 'ok' && listed.items.every((item) => item.myResponse === 'pending')).toBe(true);
  });

  it('série : changer le fuseau de la série change celui des occurrences futures non modifiées', () => {
    const { store } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    expect(store.update(ALICE, first.id, { scope: 'series', tz: 'UTC' }, NOW)).toMatchObject({ result: 'ok' });
    const listed = store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW);
    expect(listed.result === 'ok' && listed.items.length).toBe(4);
    expect(listed.result === 'ok' && listed.items.every((item) => item.tz === 'UTC')).toBe(true);
  });

  it('série : une occurrence modifiée à la main (overridden) survit à une modification de la série', () => {
    const { store } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    const second = (store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW) as { items: EveningView[] }).items[1];
    if (second === undefined) throw new Error('deuxième occurrence absente');
    const moved = evOf(store.update(ALICE, second.id, { scope: 'occurrence', title: 'Spécial' }, NOW));
    expect(moved).toMatchObject({ title: 'Spécial', overridden: true });

    const updated = store.update(ALICE, first.id, { scope: 'series', title: 'Mardi soir', localTime: '21:00' }, NOW);
    expect(updated.result).toBe('ok');
    const listed = store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW);
    if (listed.result !== 'ok') throw new Error('liste refusée');
    const special = listed.items.find((item) => item.id === second.id);
    expect(special).toMatchObject({ title: 'Spécial', startsAt: ANCHOR + 7 * DAY, overridden: true });
    // Les occurrences non modifiées suivent la nouvelle heure (21:00 à Paris, 19:00 UTC) et le nouveau titre.
    const regenerated = listed.items.filter((item) => !item.overridden).map((item) => item.startsAt);
    expect(regenerated).toEqual([0, 1, 2, 3].map((k) => ANCHOR + 60 * MIN + k * 7 * DAY));
    expect(listed.items.filter((item) => !item.overridden).every((item) => item.title === 'Mardi soir')).toBe(true);
  });

  it('série : un invité qui quitte la série ne reçoit plus les occurrences générées ensuite', () => {
    const { store, db } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB, CAROL], series: PARIS_TUESDAY }, NOW));
    expect(store.leave(BOB, first.id, 'series', NOW)).toEqual({ result: 'ok' });
    expect(store.list(BOB, { scope: 'upcoming', limit: 50 }, NOW)).toEqual({ result: 'ok', items: [], nextCursor: null });
    const carol = store.list(CAROL, { scope: 'upcoming', limit: 50 }, NOW);
    expect(carol.result === 'ok' ? carol.items.length : -1).toBe(4);

    // Huit jours plus tard, la fenêtre se régénère : Bob n'y figure pas, Carol y reste.
    store.tick(NOW + 8 * DAY);
    const later = store.list(ALICE, { scope: 'upcoming', limit: 50 }, NOW + 8 * DAY);
    if (later.result !== 'ok') throw new Error('liste refusée');
    expect(later.items.length).toBeGreaterThan(0);
    for (const item of later.items) {
      expect(guestPids(item)).not.toContain(BOB);
      expect(guestPids(item)).toContain(CAROL);
    }
    expect((db.prepare('SELECT left_at FROM evening_series_guests WHERE pid = ?').get(BOB) as { left_at: number }).left_at).toBe(NOW);
  });

  it('série arrêtée : occurrences futures annulées, aucune nouvelle génération, arrêter deux fois est close', () => {
    const { store } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    expect(store.stop(ALICE, first.id, NOW)).toEqual({ result: 'ok' });
    const listed = store.list(ALICE, { scope: 'upcoming', limit: 50 }, NOW);
    if (listed.result !== 'ok') throw new Error('liste refusée');
    expect(listed.items.length).toBe(4);
    expect(listed.items.every((item) => item.status === 'cancelled' && item.series?.status === 'stopped')).toBe(true);
    store.tick(NOW + 10 * DAY);
    const after = store.list(ALICE, { scope: 'upcoming', limit: 50 }, NOW + 10 * DAY);
    if (after.result !== 'ok') throw new Error('liste refusée');
    expect(after.items.map((item) => item.startsAt)).toEqual([ANCHOR + 7 * DAY, ANCHOR + 14 * DAY, ANCHOR + 21 * DAY]);
    expect(after.items.every((item) => item.status === 'cancelled')).toBe(true);
    expect(store.cancel(ALICE, first.id, 'series', NOW)).toEqual({ result: 'evening_closed' });
  });

  it('série : une occurrence annulée n est pas régénérée ; occurrence et série sur une soirée ponctuelle', () => {
    const { store, db } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    expect(store.cancel(ALICE, first.id, 'occurrence', NOW)).toEqual({ result: 'ok' });
    store.tick(NOW + 1 * DAY);
    expect((db.prepare('SELECT COUNT(*) AS n FROM evenings WHERE series_id IS NOT NULL AND starts_at = ?').get(ANCHOR) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT status FROM evenings WHERE id = ?").get(first.id) as { status: string }).status).toBe('cancelled');

    const oneOff = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Seule', startsAt: NOW + 2 * HOUR, guests: [] }, NOW));
    expect(store.stop(ALICE, oneOff.id, NOW)).toEqual({ result: 'invalid_body' });
    expect(store.update(ALICE, oneOff.id, { scope: 'series', title: 'x' }, NOW)).toEqual({ result: 'invalid_body' });
  });

  it('une occurrence déplacée sur une autre occurrence de la série est refusée', () => {
    const { store } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [], series: PARIS_TUESDAY }, NOW));
    const second = (store.list(ALICE, { scope: 'upcoming', limit: 50 }, NOW) as { items: EveningView[] }).items[1];
    if (second === undefined) throw new Error('deuxième occurrence absente');
    expect(store.update(ALICE, first.id, { scope: 'occurrence', startsAt: second.startsAt }, NOW)).toEqual({ result: 'invalid_body' });
  });
});

describe('soirées : rappels (tick)', () => {
  it('rappel à T-15 min : une seule fois, aux invités qui n ont pas dit non ; une annulée n en a pas', () => {
    const { store } = seeded();
    const kept = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Rappel', startsAt: NOW + 20 * MIN, guests: [BOB, CAROL] }, NOW));
    store.respond(CAROL, kept.id, 'no', NOW);
    const cancelled = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Annulée', startsAt: NOW + 20 * MIN, guests: [BOB] }, NOW));
    store.cancel(ALICE, cancelled.id, 'occurrence', NOW);

    const first = store.tick(NOW + 6 * MIN);
    expect(first.effects).toEqual([
      {
        pids: [ALICE, BOB].sort(),
        event: { type: 'reminder', eveningId: kept.id, title: 'Rappel', startsAt: NOW + 20 * MIN, tz: 'Europe/Paris', hostPid: ALICE },
      },
    ]);
    expect(first.nextWake).toBe(NOW + 20 * MIN);

    expect(store.tick(NOW + 6 * MIN).effects).toEqual([]);
    expect(store.tick(NOW + 7 * MIN).effects).toEqual([]);
  });

  it('pas de rappel avant T-15 min, ni une fois la soirée commencée', () => {
    const { store } = seeded();
    evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Plus tard', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    expect(store.tick(NOW).effects).toEqual([]);
    expect(store.tick(NOW + 2 * HOUR + MIN).effects).toEqual([]);
  });
});

describe('soirées : détachement, purge et cascade', () => {
  it('détachement : chacun est retiré des soirées de l autre, séries comprises, futures comme passées non purgées', () => {
    const { store } = seeded();
    const aliceEvening = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Chez Alice', startsAt: NOW + 2 * HOUR, guests: [BOB] }, NOW));
    const bobEvening = evOf(store.create(BOB, { tz: 'Europe/Paris', title: 'Chez Bob', startsAt: NOW + 3 * HOUR, guests: [ALICE] }, NOW));
    const bobSeries = evOf(store.create(BOB, { tz: 'Europe/Paris', title: 'Série Bob', startsAt: ANCHOR, guests: [ALICE], series: PARIS_TUESDAY }, NOW));
    const earlier = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Hier', startsAt: NOW + HOUR, guests: [BOB] }, NOW));

    // Détachement à 1 h 30 : la soirée de 1 h est commencée, celles de 2 h et 3 h sont à venir.
    const removed = store.detach(ALICE, BOB, NOW + 90 * MIN);
    expect(removed.map((gone) => gone.eveningId)).toContain(earlier.id);

    expect(store.get(BOB, aliceEvening.id)).toEqual({ result: 'evening_not_found' });
    expect(store.get(ALICE, bobEvening.id)).toEqual({ result: 'evening_not_found' });
    expect(store.get(ALICE, bobSeries.id)).toEqual({ result: 'evening_not_found' });
    // Une soirée déjà commencée n'est plus un accès toléré : le bloqué ne la voit plus non plus.
    expect(store.get(BOB, earlier.id)).toEqual({ result: 'evening_not_found' });
    expect(store.get(ALICE, earlier.id)).toMatchObject({ result: 'ok' });
  });

  it('purgeProfile : supprime les soirées et séries hébergées, retire le profil des autres soirées', () => {
    const { store } = seeded();
    const hosted = evOf(store.create(BOB, { tz: 'Europe/Paris', title: 'Bob hôte', startsAt: NOW + 2 * HOUR, guests: [ALICE] }, NOW));
    const invited = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Alice hôte', startsAt: NOW + 3 * HOUR, guests: [BOB, CAROL] }, NOW));
    evOf(store.create(BOB, { tz: 'Europe/Paris', title: 'Série Bob', startsAt: ANCHOR, guests: [ALICE], series: PARIS_TUESDAY }, NOW));

    store.purgeProfile(BOB);

    expect(store.get(ALICE, hosted.id)).toEqual({ result: 'evening_not_found' });
    // La soirée d'Alice reste, sans Bob : Carol y est toujours invitée.
    expect(guestPids(evOf(store.get(ALICE, invited.id)))).toEqual([ALICE, CAROL].sort());
    const remaining = store.list(ALICE, { scope: 'upcoming', limit: 50 }, NOW);
    expect(remaining.result === 'ok' ? remaining.items.map((item) => item.id) : []).toEqual([invited.id]);
    const carol = store.list(CAROL, { scope: 'upcoming', limit: 50 }, NOW);
    expect(carol.result === 'ok' ? carol.items.map((item) => item.id) : []).toEqual([invited.id]);
  });

  it('migration 34 : tables créées ; suppression d un profil efface ses invitations et ses soirées', () => {
    const { store, db } = seeded();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['evening_series', 'evening_series_guests', 'evenings', 'evening_guests']));
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(35);

    const evening = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [BOB, CAROL] }, NOW));
    db.prepare('DELETE FROM profiles WHERE pid = ?').run(CAROL);
    expect(store.get(ALICE, evening.id)).toMatchObject({ result: 'ok', evening: { guests: expect.any(Array) } });
    expect(guestPids(evOf(store.get(ALICE, evening.id)))).not.toContain(CAROL);
  });

  it('attachParty : le premier salon rattaché gagne ; une soirée inconnue renvoie undefined', () => {
    const { store } = seeded();
    const { id } = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Dîner', startsAt: NOW + 2 * HOUR, guests: [] }, NOW));
    expect(store.attachParty(id, 'PARTY-A')).toBe('PARTY-A');
    expect(store.attachParty(id, 'PARTY-B')).toBe('PARTY-A');
    expect(store.attachParty('inconnue', 'PARTY-C')).toBeUndefined();
  });
});

describe('soirées : trames de rappel et minuterie Node', () => {
  /** Planificateur manuel : `every` garde la tâche, le test la déclenche. */
  function manualScheduler(): { scheduler: Scheduler; run: () => Promise<void>; stopped: () => boolean } {
    let task: (() => void | Promise<void>) | undefined;
    let stopped = false;
    const scheduler: Scheduler = {
      after: () => () => undefined,
      every: (_ms, work) => {
        task = work;
        return () => {
          stopped = true;
        };
      },
      background: () => undefined,
    };
    return { scheduler, run: async () => void (await task?.()), stopped: () => stopped };
  }

  it('reminderFrames : une trame evening_reminder par soirée, vers les participants qui n ont pas dit non', () => {
    const { store } = seeded();
    const kept = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Rappel', startsAt: NOW + 20 * MIN, guests: [BOB, CAROL] }, NOW));
    store.respond(CAROL, kept.id, 'no', NOW);
    const frames = reminderFrames(store.tick(NOW + 6 * MIN));
    expect(frames).toEqual([
      { pids: [ALICE, BOB].sort(), event: { t: 'evening', event: { type: 'evening_reminder', eveningId: kept.id, title: 'Rappel', startsAt: NOW + 20 * MIN, tz: 'Europe/Paris' } } },
    ]);
    expect(frames[0]?.pids).not.toContain(CAROL);
    // Idempotence : un second tick au même instant n'en renvoie aucune.
    expect(reminderFrames(store.tick(NOW + 6 * MIN))).toEqual([]);
  });

  it('startEveningTicker : émet le rappel une seule fois, ignore un tick déjà en cours et une base absente', async () => {
    const { store } = seeded();
    const created = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Minuterie', startsAt: Date.now() + 10 * MIN, guests: [BOB] }, Date.now()));
    const repo = asyncRepo(store);
    const emitted: { pids: readonly string[]; type: string }[] = [];
    const deps = { socialEvents: (pids: readonly string[], event: { t: string; event?: { type: string } }) => void emitted.push({ pids, type: event.event?.type ?? event.t }) };
    const manual = manualScheduler();
    const stop = startEveningTicker(deps as never, { hasData: () => true, socialEvenings: () => repo } as unknown as UserBackend, manual.scheduler);

    await Promise.all([manual.run(), manual.run()]);
    await manual.run();
    expect(emitted).toEqual([{ pids: [ALICE, BOB].sort(), type: 'evening_reminder' }]);
    expect(store.get(ALICE, created.id)).toMatchObject({ result: 'ok' });
    stop();
    expect(manual.stopped()).toBe(true);

    // Base jamais créée (Node) : le tick ne l'ouvre pas.
    let opened = false;
    const idle = manualScheduler();
    startEveningTicker(deps as never, { hasData: () => false, socialEvenings: () => ((opened = true), repo) } as unknown as UserBackend, idle.scheduler);
    await idle.run();
    expect(opened).toBe(false);
  });
});

describe('soirées : corrections de review (LAST-198)', () => {
  const upcoming = (store: EveningStore, who: string, now: number): EveningView[] => {
    const listed = store.list(who, { scope: 'upcoming', limit: 50 }, now);
    if (listed.result !== 'ok') throw new Error('liste refusée');
    return listed.items;
  };
  const rowsAt = (db: Db, startsAt: number): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM evenings WHERE series_id IS NOT NULL AND starts_at = ?').get(startsAt) as { n: number }).n;

  it('occurrence déplacée : son créneau d origine n est pas recréé au tick, un seul rappel, pas d invitation en double', () => {
    const { store, db } = seeded();
    evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    const second = upcoming(store, ALICE, NOW)[1];
    if (second === undefined) throw new Error('deuxième occurrence absente');
    const origin = second.startsAt;
    const movedAt = origin + HOUR;
    evOf(store.update(ALICE, second.id, { scope: 'occurrence', startsAt: movedAt }, NOW));

    store.tick(NOW + 1000);
    store.tick(NOW + 2000);

    // Une seule soirée par créneau : rien à l'heure d'origine, la déplacée à sa nouvelle heure, trois autres inchangées.
    expect(rowsAt(db, origin)).toBe(0);
    expect(rowsAt(db, movedAt)).toBe(1);
    expect(upcoming(store, BOB, NOW + 2000).map((item) => item.startsAt)).toEqual([ANCHOR, movedAt, ANCHOR + 14 * DAY, ANCHOR + 21 * DAY]);
    expect(upcoming(store, BOB, NOW + 2000).filter((item) => item.id === second.id)).toHaveLength(1);

    // Un seul rappel pour le créneau : aucun à l'heure d'origine, un seul à la nouvelle, jamais un second.
    expect(store.tick(origin - 10 * MIN).effects.map((effect) => effect.event.startsAt)).toEqual([]);
    const reminders = store.tick(movedAt - 10 * MIN).effects;
    expect(reminders.map((effect) => effect.event.eveningId)).toEqual([second.id]);
    expect(store.tick(movedAt - 9 * MIN).effects).toEqual([]);
    // Le créneau d'origine reste réservé même une fois la soirée passée.
    expect(rowsAt(db, origin)).toBe(0);
  });

  it('occurrence déplacée sur l heure d un créneau pas encore généré : pas de doublon à la même heure', () => {
    const { store, db } = seeded();
    evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [], series: PARIS_TUESDAY }, NOW));
    const first = upcoming(store, ALICE, NOW)[0];
    if (first === undefined) throw new Error('première occurrence absente');
    const fifth = ANCHOR + 4 * 7 * DAY;
    evOf(store.update(ALICE, first.id, { scope: 'occurrence', startsAt: fifth }, NOW));
    store.tick(ANCHOR - DAY);
    store.tick(ANCHOR + 7 * DAY + HOUR);
    expect(rowsAt(db, fifth)).toBe(1);
  });

  it('nextWake : une série active dont toutes les occurrences sont annulées réveille encore la génération', () => {
    const { store } = seeded();
    evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [], series: PARIS_TUESDAY }, NOW));
    for (const item of upcoming(store, ALICE, NOW)) expect(store.cancel(ALICE, item.id, 'occurrence', NOW)).toEqual({ result: 'ok' });
    // Toutes annulées : plus de rappel, mais la fenêtre doit se refaire quand la première passera.
    expect(store.tick(NOW + 1000).nextWake).toBe(ANCHOR);
    expect(store.wakeAt(NOW + 1000)).toBe(ANCHOR);
    // Témoin : une série arrêtée n'attend plus rien.
    const { store: other } = seeded();
    const created = evOf(other.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [], series: PARIS_TUESDAY }, NOW));
    expect(other.stop(ALICE, created.id, NOW)).toEqual({ result: 'ok' });
    expect(other.tick(NOW + 1000).nextWake).toBeNull();
  });

  it('changement de règle : une occurrence dont le salon est ouvert n est pas supprimée ; les autres hors règle partent', () => {
    const { store, db } = seeded();
    const first = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Mardi', startsAt: ANCHOR, guests: [BOB], series: PARIS_TUESDAY }, NOW));
    const items = upcoming(store, ALICE, NOW);
    const opened = items[1];
    const plain = items[2];
    if (opened === undefined || plain === undefined) throw new Error('occurrences absentes');
    expect(store.attachParty(opened.id, 'PARTY-OPEN')).toBe('PARTY-OPEN');

    const updated = store.update(ALICE, first.id, { scope: 'series', localTime: '21:00' }, NOW);
    expect(updated).toMatchObject({ result: 'ok' });

    const ids = (db.prepare('SELECT id FROM evenings WHERE series_id IS NOT NULL').all() as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(opened.id);
    expect(ids).not.toContain(plain.id);
    expect(ids).not.toContain(first.id);
    // Les occurrences retirées sont signalées pour prévenir leurs invités (l'hôte et Bob, pas l'occurrence au salon ouvert).
    const removed = updated.result === 'ok' ? (updated.removed ?? []) : [];
    expect(removed.map((gone) => gone.eveningId).sort()).toEqual([first.id, plain.id, items[3]?.id ?? ''].sort());
    expect(removed[0]?.pids.sort()).toEqual([ALICE, BOB].sort());
  });

  it('blocage : un invité bloqué ne garde ni soirée en cours ni soirée passée, ni liste ; l autre invité les garde', () => {
    const { store, social } = seeded();
    const live = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'En cours', startsAt: NOW + 2 * HOUR, guests: [FRANK, BOB] }, NOW));
    const past = evOf(store.create(ALICE, { tz: 'Europe/Paris', title: 'Passée', startsAt: NOW + HOUR, guests: [FRANK, BOB] }, NOW));
    expect(store.attachParty(live.id, 'PARTY-LIVE')).toBe('PARTY-LIVE');
    expect(social.blockProfile(ALICE, FRANK, NOW + 3 * HOUR)).toMatchObject({ result: 'ok' });

    // Défense en profondeur : même avant tout detach, le bloqué ne lit plus la soirée de l'hôte ni ne la liste.
    const now = NOW + 3 * HOUR;
    expect(store.get(FRANK, live.id)).toEqual({ result: 'evening_not_found' });
    expect(store.list(FRANK, { scope: 'past', limit: 50 }, now)).toMatchObject({ result: 'ok', items: [] });
    expect(store.get(BOB, live.id)).toMatchObject({ result: 'ok', evening: { partyId: 'PARTY-LIVE' } });

    const removed = store.detach(ALICE, FRANK, now);
    // La soirée commencée depuis moins de 2 h est signalée ; la passée de 2 h (hors fenêtre) est retirée sans trame.
    expect(removed.map((gone) => gone.eveningId)).toEqual([live.id]);
    expect(store.get(FRANK, live.id)).toEqual({ result: 'evening_not_found' });
    expect(store.get(FRANK, past.id)).toEqual({ result: 'evening_not_found' });
    expect(guestPids(evOf(store.get(ALICE, live.id)))).not.toContain(FRANK);
    expect(guestPids(evOf(store.get(ALICE, past.id)))).not.toContain(FRANK);
    // Témoin : Bob garde les deux soirées, salon compris.
    expect(store.get(BOB, past.id)).toMatchObject({ result: 'ok' });
    expect(store.list(BOB, { scope: 'past', limit: 50 }, now)).toMatchObject({ result: 'ok', items: expect.arrayContaining([expect.objectContaining({ id: past.id })]) });
  });
});
