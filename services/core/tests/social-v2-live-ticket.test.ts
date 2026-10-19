import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signLiveTicket, signTicket, verifyLiveTicket, verifyTicket } from '../src/party/ticket.js';
import { TICKET_TTL_MS } from '../src/party/protocol.js';
import { type RunningApp, SECRET, startApp } from './lt-harness.js';
import { as, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';

/** Ticket du flux temps réel social : 60 s, lié au profil, finalité distincte des salons ; route POST /user/social/live-ticket. */

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const PID = 'ABCDEFGHIJKLMNOP';
const OTHER_PID = 'QRSTUVWXYZ234567';
const ROOM = 'room-0123456789abcdef';
const identity = { accountId: 'compte-1', username: 'alice', avatarColor: '#aa5500' };

/** Corps (charge utile) d'un ticket : premier segment avant le point. */
const bodyOf = (ticket: string): string => ticket.slice(0, ticket.indexOf('.'));

describe('ticket du flux social (verifyLiveTicket)', () => {
  it('valable 60 s, lié au profil et au compte', () => {
    const { ticket } = signLiveTicket(PID, 'compte-1', T0, SECRET);
    expect(verifyLiveTicket(ticket, T0 + TICKET_TTL_MS - 1, SECRET)).toEqual({ pid: PID, accountId: 'compte-1' });
    expect(verifyLiveTicket(ticket, T0 + TICKET_TTL_MS, SECRET)).toBeUndefined();
  });

  it('secret différent, ticket modifié ou mal formé : refusé', () => {
    const { ticket } = signLiveTicket(PID, 'compte-1', T0, SECRET);
    expect(verifyLiveTicket(ticket, T0, 'autre-secret-with-more-than-32-chars!!')).toBeUndefined();
    expect(verifyLiveTicket(`${ticket}x`, T0, SECRET)).toBeUndefined();
    expect(verifyLiveTicket('n.importe.quoi', T0, SECRET)).toBeUndefined();
    expect(verifyLiveTicket('', T0, SECRET)).toBeUndefined();
    const forged = Buffer.from(JSON.stringify({ purpose: 'lastaddon-social-live-ticket-v1', scope: `social-live:${OTHER_PID}`, pid: OTHER_PID, accountId: 'x', exp: T0 + 9e9 })).toString('base64url');
    expect(verifyLiveTicket(`${forged}.${ticket.slice(ticket.indexOf('.') + 1)}`, T0, SECRET)).toBeUndefined();
  });

  it('charge utile réécrite vers un autre profil : signature refusée', () => {
    const { ticket } = signLiveTicket(PID, 'compte-1', T0, SECRET);
    const tampered = `${Buffer.from(JSON.stringify({ purpose: 'lastaddon-social-live-ticket-v1', scope: `social-live:${OTHER_PID}`, pid: OTHER_PID, accountId: 'compte-1', exp: T0 + 9e4 })).toString('base64url')}.${ticket.slice(ticket.indexOf('.') + 1)}`;
    expect(bodyOf(tampered)).not.toBe(bodyOf(ticket));
    expect(verifyLiveTicket(tampered, T0, SECRET)).toBeUndefined();
  });

  it('un ticket de salon n\'ouvre pas le flux social', () => {
    const room = signTicket(ROOM, identity, T0, SECRET).ticket;
    expect(verifyLiveTicket(room, T0, SECRET)).toBeUndefined();
  });

  it('un ticket du flux social n\'est jamais accepté comme ticket de salon', () => {
    const live = signLiveTicket(PID, 'compte-1', T0, SECRET).ticket;
    expect(verifyTicket(live, ROOM, T0, SECRET)).toBeUndefined();
    expect(verifyTicket(live, `social-live:${PID}`, T0, SECRET)).toBeUndefined();
  });

  it('les tickets de salon restent valables pour leur salon', () => {
    const room = signTicket(ROOM, identity, T0, SECRET).ticket;
    expect(verifyTicket(room, ROOM, T0 + 59_000, SECRET)).toEqual(identity);
  });
});

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  app = await startApp({});
  cast = await castOf(app);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

describe('POST /user/social/live-ticket', () => {
  it('délivre un wsPath dont le ticket est lié au profil agissant', async () => {
    const res = await as<{ wsPath: string }>(app, cast.alice, 'POST', '/user/social/live-ticket');
    expect(res.status).toBe(200);
    expect(res.body.wsPath.startsWith('/user/social/live?ticket=')).toBe(true);
    const ticket = new URL(res.body.wsPath, 'https://worker.test').searchParams.get('ticket') ?? '';
    expect(verifyLiveTicket(ticket, Date.now(), SECRET)?.pid).toBe(cast.alice.pid);
  });

  it('profil enfant : refusé (403 kid_profile)', async () => {
    const res = await as<ErrorBodyV2>(app, cast.kid, 'POST', '/user/social/live-ticket');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
  });

  it('sans en-tête de profil : 400 profile_required', async () => {
    const res = await as<ErrorBodyV2>(app, { token: cast.alice.token, profile: '' }, 'POST', '/user/social/live-ticket');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('profile_required');
  });

  it('vingt tickets par minute et par profil, puis 429', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await as(app, cast.bob, 'POST', '/user/social/live-ticket')).status).toBe(200);
    }
    const res = await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/live-ticket');
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });
});
