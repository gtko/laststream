// Client REST des soirées planifiées (LAST-199) : méthode, chemin, requête, corps et en-têtes de chaque route, avec un faux fetch.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { auth } from '../src/data/auth';
import { saveProfileToken, setSession } from '../src/data/session';
import * as v3 from '../src/data/socialV3Api';
import { UserApiError } from '../src/data/userApi';

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Sent { method: string; url: string; headers: Record<string, string>; body: any }
let sent: Sent[] = [];
let reply: (s: Sent) => Response = () => new Response(null, { status: 204 });

beforeAll(() => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
  reloadSettings();
  setSession('sess-token', FUTURE, 'greg');
  saveProfileToken('p1', { token: 'prof-token', expiresAt: FUTURE });
  auth.status = 'ready';
  auth.profile = { id: 'p1', name: 'Greg' } as any;
});

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const s: Sent = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(s);
    return reply(s);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  reply = () => new Response(null, { status: 204 });
});

const last = () => {
  const s = sent[sent.length - 1];
  const u = new URL(s.url);
  return { method: s.method, path: u.pathname + u.search, body: s.body, headers: s.headers };
};

const EVENING = { id: 'ev1', title: 'Dune 2', startsAt: 1, tz: 'Europe/Paris', isHost: false, guests: [], status: 'scheduled', overridden: false };

describe('soirées planifiées — client', () => {
  it('listEvenings : portée, curseur et limite en query ; sans option, la portée seule', async () => {
    reply = () => json({ items: [EVENING], nextCursor: 'c2' });
    await expect(v3.listEvenings('upcoming')).resolves.toEqual({ items: [EVENING], nextCursor: 'c2' });
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/evenings?scope=upcoming' });
    expect(last().headers['x-profile-id']).toBe('p1');
    await v3.listEvenings('past', { cursor: 'a b', limit: 50 });
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/evenings?scope=past&cursor=a+b&limit=50' });
    await v3.listEvenings('invites', { limit: 10 });
    expect(last().path).toBe('/user/social/evenings?scope=invites&limit=10');
  });

  it('getEvening : encode l’identifiant', async () => {
    reply = () => json(EVENING);
    await expect(v3.getEvening('ev/1')).resolves.toMatchObject({ id: 'ev1' });
    expect(last()).toMatchObject({ method: 'GET', path: '/user/social/evenings/ev%2F1' });
  });

  it('createEvening : POST avec le corps tel quel, soirée rendue', async () => {
    reply = () => json(EVENING, 201);
    const body = { title: 'Dune 2', startsAt: 5, tz: 'Europe/Paris', guests: ['p2'], recurrence: { freq: 'weekly' as const, interval: 1 as const } };
    await expect(v3.createEvening(body)).resolves.toMatchObject({ id: 'ev1' });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/evenings', body });
  });

  it('updateEvening : PATCH avec portée ; cancelEvening : DELETE ?scope (occurrence par défaut)', async () => {
    await v3.updateEvening('ev1', { title: 'Autre', scope: 'series' });
    expect(last()).toMatchObject({ method: 'PATCH', path: '/user/social/evenings/ev1', body: { title: 'Autre', scope: 'series' } });
    await v3.cancelEvening('ev1');
    expect(last()).toMatchObject({ method: 'DELETE', path: '/user/social/evenings/ev1?scope=occurrence' });
    await v3.cancelEvening('ev1', 'series');
    expect(last().path).toBe('/user/social/evenings/ev1?scope=series');
  });

  it('invités : POST {pids} et DELETE du pid encodé', async () => {
    await v3.inviteToEvening('ev1', ['p2', 'p3']);
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/evenings/ev1/guests', body: { pids: ['p2', 'p3'] } });
    await v3.removeEveningGuest('ev1', 'p 2');
    expect(last()).toMatchObject({ method: 'DELETE', path: '/user/social/evenings/ev1/guests/p%202' });
  });

  it('respondToEvening : PUT {response} ; leaveEvening : POST {scope} ; stopEveningSeries : POST /stop', async () => {
    await v3.respondToEvening('ev1', 'maybe');
    expect(last()).toMatchObject({ method: 'PUT', path: '/user/social/evenings/ev1/response', body: { response: 'maybe' } });
    await v3.leaveEvening('ev1');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/evenings/ev1/leave', body: { scope: 'occurrence' } });
    await v3.leaveEvening('ev1', 'series');
    expect(last().body).toEqual({ scope: 'series' });
    await v3.stopEveningSeries('ev1');
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/evenings/ev1/stop' });
  });

  it('openEvening : POST /open, soirée rendue avec son salon', async () => {
    reply = () => json({ ...EVENING, party: { partyId: 'pty1', title: 'Dune 2' } });
    await expect(v3.openEvening('ev1')).resolves.toMatchObject({ party: { partyId: 'pty1' } });
    expect(last()).toMatchObject({ method: 'POST', path: '/user/social/evenings/ev1/open' });
  });

  it('erreur serveur : UserApiError avec le code (409 evening_closed)', async () => {
    reply = () => json({ error: 'evening_closed' }, 409);
    await expect(v3.respondToEvening('ev1', 'yes')).rejects.toBeInstanceOf(UserApiError);
    await expect(v3.respondToEvening('ev1', 'yes')).rejects.toMatchObject({ status: 409, code: 'evening_closed' });
  });
});
