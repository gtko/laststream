import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapSqlite } from '../src/platform/node/user-db.js';
import { MIGRATIONS, migrate } from '../src/user/migrations.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, inviteAndRegister, type Member } from './social-harness.js';
import { type AccountBody, type ErrorBody, createProfileVia, loginAs, PASSWORD, request } from './user-harness.js';

/** Billets de parrainage (contrat invitations v3, partie B) : migration v28, message et coups de cœur, échéance, numéro, vérification, amitié automatique. */

interface Pick {
  id: string;
  type: string;
  name: string;
  poster: string;
  background: string;
}

interface Ticket {
  id: string;
  code: string;
  state: 'free' | 'sent' | 'used' | 'revoked';
  createdAt: string;
  sentAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  message: string | null;
  picks: Pick[];
  expiresAt: string | null;
  number: number;
  invitee: string | null;
}

interface TicketList {
  quota: number;
  invites: Ticket[];
}

interface TicketReply {
  invite: Ticket;
}

type CheckBody =
  | {
      valid: true;
      inviter: { name: string; handle: string | null; avatar: string | null } | null;
      message: string | null;
      picks: Pick[];
      expiresAt: string | null;
      number: number;
    }
  | { valid: false; reason: 'expired' | 'used' | 'revoked' | 'unknown' };

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const PICK: Pick = { id: 'tt0111161', type: 'movie', name: 'Les Évadés', poster: 'https://image.tmdb.org/t/p/w500/evades.jpg', background: '' };
const PICK_2: Pick = { id: '278', type: 'movie', name: 'Shawshank', poster: '', background: 'https://assets.fanart.tv/fond.jpg' };
const HANDLE_TAG = /^alice#[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

let app: RunningApp;
let alice: Member;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = await startApp({});
  alice = await bootstrapOwner(app);
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Avance l'horloge (Date seule est simulée). */
const travel = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms);
};

const list = (member: Member = alice) => request<TicketList>(app, 'GET', '/user/invites', { token: member.token });
const firstFree = async (): Promise<Ticket> => {
  const found = (await list()).body.invites.find((invite) => invite.state === 'free');
  if (found === undefined) throw new Error('aucun billet libre');
  return found;
};
const ticketOf = async (id: string): Promise<Ticket | undefined> => (await list()).body.invites.find((invite) => invite.id === id);
const putTicket = (id: string, body: Record<string, unknown>, member: Member = alice) =>
  request<TicketReply | ErrorBody>(app, 'PUT', `/user/invites/${id}`, { token: member.token, body });
const sendTicket = (id: string, sent: boolean) => request(app, 'PUT', `/user/invites/${id}/sent`, { token: alice.token, body: { sent } });
const checkCode = (code: string) => request<CheckBody>(app, 'GET', `/user/invites/check?code=${code}`);
const registerWith = (username: string, invite: string, extra: Record<string, unknown> = {}) =>
  request<AccountBody | ErrorBody>(app, 'POST', '/user/register', { body: { username, password: PASSWORD, invite, ...extra } });

describe('migration v28 : colonnes des billets, base existante préservée', () => {
  it('une base v27 reçoit message, picks, expires_at et auto_friend ; un lien existant garde l’amitié automatique', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db, MIGRATIONS.slice(0, 27));
    db.exec("INSERT INTO invites (id, code, inviter_id, created_at) VALUES ('i1', 'code-existant-0001', NULL, '2026-01-01T00:00:00.000Z')");

    migrate(db);

    const columns = (db.prepare('PRAGMA table_info(invites)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['message', 'picks', 'expires_at', 'auto_friend']));
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v).toBe(30);
    expect(db.prepare("SELECT message, picks, expires_at, auto_friend FROM invites WHERE id = 'i1'").get()).toEqual({
      message: null,
      picks: null,
      expires_at: null,
      auto_friend: 1,
    });
  });

  it('auto_friend ne accepte que 0 ou 1', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    migrate(db);
    expect(() =>
      db.exec("INSERT INTO invites (id, code, inviter_id, created_at, auto_friend) VALUES ('i2', 'code-invalide-0002', NULL, '2026-01-01', 2)"),
    ).toThrow();
  });
});

describe('PUT /user/invites/:id : message et coups de cœur', () => {
  it('enregistre le message et les coups de cœur, relus par GET /user/invites ; vides = effacés', async () => {
    const ticket = await firstFree();
    const put = await putTicket(ticket.id, { message: 'Viens voir ça avec moi', picks: [PICK, PICK_2] });
    expect(put.status).toBe(200);
    expect((put.body as TicketReply).invite).toMatchObject({ id: ticket.id, message: 'Viens voir ça avec moi', picks: [PICK, PICK_2] });
    expect(await ticketOf(ticket.id)).toMatchObject({ message: 'Viens voir ça avec moi', picks: [PICK, PICK_2], number: ticket.number });

    const cleared = await putTicket(ticket.id, { message: '', picks: [] });
    expect((cleared.body as TicketReply).invite).toMatchObject({ message: null, picks: [] });
  });

  it('un coup de cœur sans affiche ni fond (chaînes vides) est accepté ; un champ absent reste inchangé', async () => {
    const ticket = await firstFree();
    expect((await putTicket(ticket.id, { message: 'un', picks: [{ ...PICK, poster: '', background: '' }] })).status).toBe(200);
    expect((await putTicket(ticket.id, { picks: [PICK] })).status).toBe(200);
    expect(await ticketOf(ticket.id)).toMatchObject({ message: 'un', picks: [PICK] });
  });

  it('message de 280 caractères accepté (compté en caractères), 281 refusé', async () => {
    const ticket = await firstFree();
    expect((await putTicket(ticket.id, { message: '😀'.repeat(280) })).status).toBe(200);
    expect((await putTicket(ticket.id, { message: '😀'.repeat(281) })).status).toBe(400);
    expect((await putTicket(ticket.id, { message: 'a'.repeat(281) })).status).toBe(400);
  });

  it('plus de 3 coups de cœur, champs invalides et adresses non https : 400, rien n’est écrit', async () => {
    const ticket = await firstFree();
    const four = [PICK, PICK_2, { ...PICK, id: '3' }, { ...PICK, id: '4' }];
    expect((await putTicket(ticket.id, { picks: four })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, poster: 'http://image.tmdb.org/t/p/w500/a.jpg' }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, background: 'javascript:alert(1)' }] })).status).toBe(400);
    // Hôte d'image non autorisé et chemin relatif : refusés (l'app n'a pas de proxy d'images).
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, poster: 'https://img.example.com/a.jpg' }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, background: '/t/p/w500/a.jpg' }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, name: '   ' }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ ...PICK, id: 'x'.repeat(65) }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { picks: [{ type: 'movie', name: 'Sans id', poster: '', background: '' }] })).status).toBe(400);
    expect((await putTicket(ticket.id, { message: 42 })).status).toBe(400);
    expect(await ticketOf(ticket.id)).toMatchObject({ message: null, picks: [] });
  });

  it('seul le propriétaire modifie son billet (404 pour un autre compte) ; un billet utilisé refuse (409)', async () => {
    const bob = await inviteAndRegister(app, alice, 'bob');
    const ticket = await firstFree();
    const foreign = await putTicket(ticket.id, { message: 'pirate' }, bob);
    expect(foreign.status).toBe(404);
    expect((foreign.body as ErrorBody).error).toBe('invite_not_found');

    const used = (await list()).body.invites.find((invite) => invite.state === 'used') as Ticket;
    expect(used.invitee).toBe('bob');
    const denied = await putTicket(used.id, { message: 'trop tard' });
    expect(denied.status).toBe(409);
    expect((denied.body as ErrorBody).error).toBe('invite_used');
  });

  it('session verrouillée sur un profil du foyer : 403 profile_locked, sur PUT comme sur GET', async () => {
    const marie = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Marie' })).body.id;
    const link = await request<{ token: string }>(app, 'POST', `/user/profiles/${marie}/household-invite`, {
      token: alice.token,
      headers: { 'x-profile-id': alice.profile },
      body: {},
    });
    expect(link.status).toBe(201);
    const locked = await request<{ token: string }>(app, 'POST', '/user/household-invites/redeem', {
      body: { token: link.body.token, login: 'marie.hub', password: PASSWORD },
    });
    expect(locked.status).toBe(201);

    const ticket = await firstFree();
    const denied = await putTicket(ticket.id, { message: 'x' }, { username: 'marie.hub', token: locked.body.token, profile: marie });
    expect(denied.status).toBe(403);
    expect((denied.body as ErrorBody).error).toBe('profile_locked');
    expect((await request(app, 'GET', '/user/invites', { token: locked.body.token })).status).toBe(403);
  });
});

describe('billet envoyé : échéance de 14 jours et libération', () => {
  it('PUT /sent pose expiresAt = maintenant + 14 jours ; sent:false remet l’échéance à null', async () => {
    const ticket = await firstFree();
    expect((await sendTicket(ticket.id, true)).status).toBe(204);
    expect(await ticketOf(ticket.id)).toMatchObject({
      state: 'sent',
      sentAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 14 * DAY).toISOString(),
    });

    expect((await sendTicket(ticket.id, false)).status).toBe(204);
    expect(await ticketOf(ticket.id)).toMatchObject({ state: 'free', sentAt: null, expiresAt: null });
  });

  it('renvoyer un billet envoyé donne une nouvelle échéance, 14 jours après le nouvel envoi', async () => {
    const ticket = await firstFree();
    await sendTicket(ticket.id, true);
    travel(10 * DAY);
    await sendTicket(ticket.id, true);
    expect(await ticketOf(ticket.id)).toMatchObject({ expiresAt: new Date(NOW + 24 * DAY).toISOString() });
  });

  it('envoyé non utilisé : valide avant l’échéance, refusé (expired) à l’échéance, libéré à la consultation du propriétaire', async () => {
    const ticket = await firstFree();
    await putTicket(ticket.id, { message: 'Viens !', picks: [PICK] });
    await sendTicket(ticket.id, true);
    const oldCode = ticket.code;

    travel(14 * DAY - 1000);
    expect((await checkCode(oldCode)).body).toMatchObject({
      valid: true,
      message: 'Viens !',
      picks: [PICK],
      expiresAt: new Date(NOW + 14 * DAY).toISOString(),
      number: ticket.number,
    });

    travel(1000);
    expect((await checkCode(oldCode)).body).toEqual({ valid: false, reason: 'expired' });
    const refused = await registerWith('bob', oldCode);
    expect(refused.status).toBe(410);
    expect((refused.body as ErrorBody).error).toBe('invite_expired');
    expect((await list()).body.invites.filter((invite) => invite.state === 'used')).toHaveLength(0);

    // La consultation du propriétaire libère le billet : nouveau code, échéance, message et coups de cœur effacés.
    const released = await ticketOf(ticket.id);
    expect(released).toMatchObject({ state: 'free', sentAt: null, expiresAt: null, message: null, picks: [], number: ticket.number });
    expect(released?.code).not.toBe(oldCode);
    expect((await checkCode(oldCode)).body).toEqual({ valid: false, reason: 'unknown' });
    expect((await checkCode(released?.code ?? '')).body).toMatchObject({ valid: true, message: null, expiresAt: null });
  });

  it('un billet non envoyé ne s’expire pas', async () => {
    const ticket = await firstFree();
    travel(30 * DAY);
    expect((await checkCode(ticket.code)).body).toMatchObject({ valid: true, expiresAt: null });
    expect(await ticketOf(ticket.id)).toMatchObject({ state: 'free', code: ticket.code });
  });
});

describe('numéro de billet', () => {
  it('4 chiffres (1000 à 9999), stable entre deux lectures, unique parmi les liens du compte', async () => {
    expect((await request(app, 'PUT', '/user/accounts/alice/invite-quota', { token: alice.token, body: { quota: 40 } })).status).toBe(200);
    const numbers = (await list()).body.invites.map((invite) => invite.number);
    expect(numbers).toHaveLength(40);
    for (const number of numbers) expect(Number.isInteger(number) && number >= 1000 && number <= 9999).toBe(true);
    expect(new Set(numbers).size).toBe(40);
    expect((await list()).body.invites.map((invite) => invite.number)).toEqual(numbers);
  });

  it('un lien régénéré (annulé puis libre à nouveau) garde son numéro', async () => {
    const ticket = await firstFree();
    await sendTicket(ticket.id, true);
    const regenerated = await request<TicketReply>(app, 'DELETE', `/user/invites/${ticket.id}`, { token: alice.token });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.invite).toMatchObject({ id: ticket.id, number: ticket.number, state: 'free', sentAt: null, expiresAt: null });
    expect(regenerated.body.invite.code).not.toBe(ticket.code);
  });

  it('GET /user/invites : un billet neuf a message null, picks vides, expiresAt null', async () => {
    const [free] = (await list()).body.invites;
    expect(free).toMatchObject({ message: null, picks: [], expiresAt: null });
    expect(Number.isInteger(free?.number)).toBe(true);
  });
});

describe('GET /user/invites/check : billet public', () => {
  it('valide : inviter {name, handle, avatar} du profil principal, message, picks, expiresAt, number', async () => {
    const ticket = await firstFree();
    await putTicket(ticket.id, { message: 'Ta place est réservée', picks: [PICK] });
    await sendTicket(ticket.id, true);

    const body = (await checkCode(ticket.code)).body as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'inviter', 'message', 'number', 'picks', 'valid']);
    expect(body).toMatchObject({
      valid: true,
      message: 'Ta place est réservée',
      picks: [PICK],
      expiresAt: new Date(NOW + 14 * DAY).toISOString(),
      number: ticket.number,
    });
    const inviter = body.inviter as { name: string; handle: string; avatar: unknown };
    expect(Object.keys(inviter).sort()).toEqual(['avatar', 'handle', 'name']);
    expect(inviter.name).toBe('alice');
    expect(inviter.handle).toMatch(HANDLE_TAG);
  });

  it('invalide : reason used après inscription, unknown pour un code inexistant', async () => {
    const ticket = await firstFree();
    expect((await registerWith('bob', ticket.code)).status).toBe(201);
    expect((await checkCode(ticket.code)).body).toEqual({ valid: false, reason: 'used' });
    expect((await checkCode('inconnu-inconnu')).body).toEqual({ valid: false, reason: 'unknown' });
    expect((await request(app, 'GET', '/user/invites/check')).status).toBe(400);
  });
});

describe('inscription : amitié automatique (autoFriend)', () => {
  it('autoFriend=false : aucune amitié de compte ni de profil ; sans ce paramètre, l’amitié est créée', async () => {
    const [sansAmitie, avecAmitie] = (await list()).body.invites.filter((invite) => invite.state === 'free');
    expect(sansAmitie).toBeDefined();
    expect(avecAmitie).toBeDefined();

    const refused = await registerWith('bob', sansAmitie?.code ?? '', { autoFriend: false });
    expect(refused.status).toBe(201);
    const bobToken = await loginAs(app, 'bob');
    const bobProfile = (await createProfileVia<{ id: string }>(app, bobToken, { name: 'Bob' })).body.id;

    // Amitié de compte (table legacy) : elle n'apparaît côté v2 qu'une fois convertie en amitié de profil, à la création du
    // premier profil adulte. La vue v2 par profil couvre donc les deux niveaux.
    const profileFriends = (token: string, profile: string) =>
      request<{ friends: unknown[] }>(app, 'GET', '/user/social/friends', { token, headers: { 'x-profile-id': profile } });
    expect((await profileFriends(alice.token, alice.profile)).body.friends).toEqual([]);
    expect((await profileFriends(bobToken, bobProfile)).body.friends).toEqual([]);

    // Témoin : avec le comportement par défaut, le filleul devient ami du parrain (profils).
    expect((await registerWith('carol', avecAmitie?.code ?? '')).status).toBe(201);
    const carolToken = await loginAs(app, 'carol');
    await createProfileVia(app, carolToken, { name: 'Carol' });
    expect((await profileFriends(alice.token, alice.profile)).body.friends).toHaveLength(1);
    expect((await profileFriends(bobToken, bobProfile)).body.friends).toEqual([]);
  });
});
