/* eslint-disable @typescript-eslint/no-explicit-any -- messages JSON dynamiques du flux social */
import { exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signTicket } from '../src/party/ticket.js';
import { SECRET } from '../tests/harness-core.js';

/**
 * Flux temps réel social contre le vrai Worker (src/worker.ts) : ticket POST /user/social/live-ticket, mise à niveau
 * GET /user/social/live (vérifiée par le Worker, acceptée par le Durable Object UserStoreDO avec l'API d'hibernation),
 * diffusion des écritures sociales (demande, amitié, message, lecture, présence, invisible) et règles de connexion.
 */

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const ADMIN = 'admin-test-secret-with-more-than-32-chars';
const PASSWORD = 'mot-de-passe-test-1';

let counter = 0;
const nextIp = (): string => `10.${Math.floor(counter / 65_000) % 250}.${Math.floor(counter / 250) % 250}.${(counter += 1) % 250}`;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function api<T = Record<string, any>>(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { 'cf-connecting-ip': nextIp(), ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

let accountSeq = 0;
/** Compte neuf (invitation système) et son profil adulte, avec son pid et son handle (GET /user/social/me). */
async function persona(prefix: string) {
  const name = `${prefix}${++accountSeq}x${Math.floor(Math.random() * 1e6)}`.toLowerCase().slice(0, 30);
  const invite = await api<{ code: string }>('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  expect(invite.status).toBe(200);
  const reg = await api('POST', '/user/register', { body: { username: name, password: PASSWORD, invite: invite.body.code } });
  expect(reg.status).toBe(201);
  const login = await api<{ token: string }>('POST', '/user/login', { body: { username: name, password: PASSWORD } });
  const token = login.body.token;
  const profile = await api<{ id: string }>('POST', '/user/profiles', { token, body: { name, avatarColor: '#aa5500' } });
  const me = await api<{ pid: string; handle: { name: string; tag: string; full: string } }>('GET', '/user/social/me', {
    token,
    headers: { 'x-profile-id': profile.body.id },
  });
  expect(me.status).toBe(200);
  await api('DELETE', `/__admin/invite/${invite.body.code}`, { headers: { 'x-admin-secret': ADMIN } });
  return { token, profile: profile.body.id, pid: me.body.pid, full: me.body.handle.full };
}
type Persona = Awaited<ReturnType<typeof persona>>;

/** Acteur : en-tête de profil et jeton, pour les routes v2. */
const acting = (who: Persona) => ({ token: who.token, headers: { 'x-profile-id': who.profile } });

/** Ticket de flux temps réel du profil agissant, puis mise à niveau WebSocket. */
async function liveSocket(who: Persona): Promise<{ peer: Peer; status: number }> {
  const ticket = await api<{ wsPath: string }>('POST', '/user/social/live-ticket', acting(who));
  expect(ticket.status).toBe(200);
  const res = await upgrade(ticket.body.wsPath);
  if (res.status !== 101) return { peer: undefined as unknown as Peer, status: res.status };
  return { peer: new Peer(res.webSocket as any), status: 101 };
}

/** Socket de test : file des messages reçus et attente d'un message précis. */
class Peer {
  readonly messages: any[] = [];
  closed: { code: number; reason: string } | undefined;
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  private closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];

  constructor(readonly ws: any) {
    ws.accept();
    ws.addEventListener('message', (event: { data: string }) => {
      const message = JSON.parse(event.data);
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
    ws.addEventListener('close', (event: { code: number; reason: string }) => {
      this.closed = { code: event.code, reason: event.reason };
      for (const resolve of this.closeWaiters) resolve(this.closed);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Premier message (déjà reçu non consommé ou futur) vérifiant `match`. */
  next(match: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`message attendu non reçu (reçus : ${JSON.stringify(this.messages)})`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          const at = this.messages.indexOf(m);
          if (at >= 0) this.messages.splice(at, 1);
          resolve(m);
        },
      });
    });
  }

  type(t: string): Promise<any> {
    return this.next((m) => m.t === t);
  }

  whenClosed(timeoutMs = 4000): Promise<{ code: number; reason: string }> {
    if (this.closed !== undefined) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fermeture attendue')), timeoutMs);
      this.closeWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }

  close(): void {
    try {
      this.ws.close(1000, 'test');
    } catch {
      // déjà fermée
    }
  }
}

async function upgrade(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await worker.fetch(`https://worker.test${path}`, { headers: { upgrade: 'websocket', 'cf-connecting-ip': nextIp(), ...headers } });
}

/** Chaque test crée plusieurs comptes (hachage scrypt à l'inscription) : délai élargi. */
const TEST_TIMEOUT_MS = 30_000;

const WATCHING = { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 120, paused: false, at: Date.now() };

describe('flux temps réel social (WebSocket)', () => {
  it('ping / pong, puis diffusion des écritures sociales à leurs destinataires', async () => {
    const alice = await persona('alice');
    const bob = await persona('bob');
    const aliceLive = await liveSocket(alice);
    const bobLive = await liveSocket(bob);
    expect(aliceLive.status).toBe(101);
    expect(bobLive.status).toBe(101);
    const aliceSocket = aliceLive.peer;
    const bobSocket = bobLive.peer;

    aliceSocket.send({ t: 'ping' });
    expect(await aliceSocket.type('pong')).toEqual({ t: 'pong' });

    // Demande : bob la reçoit, sans identifiant interne.
    const sent = await api('POST', '/user/social/requests', { ...acting(alice), body: { handle: bob.full } });
    expect(sent.status).toBe(201);
    const request = await bobSocket.type('request');
    expect(request.request.pid).toBe(alice.pid);
    expect(Object.keys(request.request).sort()).toEqual(['avatarColor', 'createdAt', 'handle', 'pid']);

    // Acceptation : alice reçoit l'amitié, vue de bob.
    const accepted = await api('POST', `/user/social/requests/${alice.pid}/accept`, acting(bob));
    expect(accepted.status).toBe(200);
    const friend = await aliceSocket.type('friend');
    expect(friend.friend.pid).toBe(bob.pid);
    expect(friend.friend.household).toBe(false);

    // Message : bob le reçoit ; lecture : alice reçoit l'accusé.
    const message = await api('POST', `/user/social/messages/${bob.pid}`, { ...acting(alice), body: { body: 'Salut' } });
    expect(message.status).toBe(201);
    const received = await bobSocket.type('message');
    expect(received.message).toMatchObject({ from: alice.pid, to: bob.pid, body: 'Salut' });
    const read = await api('PUT', `/user/social/messages/${alice.pid}/read`, acting(bob));
    expect(read.status).toBe(204);
    const receipt = await aliceSocket.type('read');
    expect(receipt.pid).toBe(bob.pid);
    expect(typeof receipt.at).toBe('number');

    // Présence : bob en ligne avec son titre, puis invisible : alice ne voit plus ni statut ni titre.
    expect((await api('PUT', '/user/social/presence', { ...acting(bob), body: { watching: WATCHING } })).status).toBe(204);
    const online = await aliceSocket.next((m) => m.t === 'presence' && m.friend.pid === bob.pid && m.friend.status === 'online');
    expect(online.friend.watching.title).toBe('Matrix');
    expect((await api('PUT', '/user/social/status', { ...acting(bob), body: { status: 'invisible' } })).status).toBe(200);
    const hidden = await aliceSocket.next((m) => m.t === 'presence' && m.friend.pid === bob.pid && m.friend.status === 'offline');
    expect(hidden.friend).not.toHaveProperty('watching');

    // Amitié retirée : alice reçoit le retrait.
    expect((await api('DELETE', `/user/social/friends/${bob.pid}`, acting(alice))).status).toBe(204);
    expect(await bobSocket.type('unfriend')).toEqual({ t: 'unfriend', pid: alice.pid });

    aliceSocket.close();
    bobSocket.close();
  }, TEST_TIMEOUT_MS);

  it('une seule connexion par profil : la plus ancienne se ferme (4000), la nouvelle reçoit', async () => {
    const alice = await persona('alice');
    const bob = await persona('bob');
    const first = (await liveSocket(bob)).peer;
    const aliceSocket = (await liveSocket(alice)).peer;
    const second = (await liveSocket(bob)).peer;
    expect(await first.whenClosed()).toMatchObject({ code: 4000 });

    expect((await api('POST', '/user/social/requests', { ...acting(alice), body: { handle: bob.full } })).status).toBe(201);
    expect((await second.type('request')).request.pid).toBe(alice.pid);
    aliceSocket.close();
    second.close();
  }, TEST_TIMEOUT_MS);

  it('trames invalides ignorées, trame trop grosse fermée (4013), débit dépassé fermé (4008)', async () => {
    const alice = await persona('alice');
    const socket = (await liveSocket(alice)).peer;
    socket.send('pas du json');
    socket.send({ t: 'ping', extra: true });
    socket.send({ t: 'ping' });
    expect(await socket.type('pong')).toEqual({ t: 'pong' });

    const other = await persona('carol');
    const flood = (await liveSocket(other)).peer;
    // Trente trames acceptées par minute : la trente et unième ferme la connexion.
    for (let i = 0; i < 31; i += 1) flood.send({ t: 'ping' });
    expect(await flood.whenClosed()).toMatchObject({ code: 4008 });

    socket.send({ t: 'ping', padding: 'x'.repeat(2000) });
    expect(await socket.whenClosed()).toMatchObject({ code: 4013 });
  }, TEST_TIMEOUT_MS);

  it('ticket absent, altéré, ou ticket de salon : refusé avant la mise à niveau (401)', async () => {
    const alice = await persona('alice');
    expect((await upgrade('/user/social/live?ticket=n.importe.quoi')).status).toBe(401);
    expect((await upgrade('/user/social/live')).status).toBe(401);
    const room = signTicket('room-0123456789abcdef', { accountId: 'x', username: 'x', avatarColor: '#aa5500' }, Date.now(), SECRET).ticket;
    expect((await upgrade(`/user/social/live?ticket=${room}`)).status).toBe(401);
    const ticket = await api<{ wsPath: string }>('POST', '/user/social/live-ticket', acting(alice));
    expect((await upgrade(`${ticket.body.wsPath}x`)).status).toBe(401);
  }, TEST_TIMEOUT_MS);

  it('profil enfant : aucun ticket (403 kid_profile)', async () => {
    const parent = await persona('parent');
    const kid = await api<{ id: string }>('POST', '/user/profiles', { token: parent.token, headers: { 'x-profile-id': parent.profile }, body: { name: 'petit', isKid: true } });
    const res = await api<{ error: string }>('POST', '/user/social/live-ticket', { token: parent.token, headers: { 'x-profile-id': kid.body.id } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('kid_profile');
  }, TEST_TIMEOUT_MS);
});
