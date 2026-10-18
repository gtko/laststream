/* eslint-disable @typescript-eslint/no-explicit-any -- messages JSON dynamiques du protocole des salons */
import { exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** Signalement d'un message dans un salon réel (WebSocket) : il alimente la file d'administration, qui le traite. */

const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const PASSWORD = 'mot-de-passe-test-1';
let ipCounter = 0;

async function api<T = any>(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'cf-connecting-ip': `192.0.2.${(ipCounter += 1) % 250}`, ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(`https://worker.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

class Peer {
  readonly messages: any[] = [];
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
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
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  next(match: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`message attendu non reçu (${JSON.stringify(this.messages)})`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

async function register(username: string, invite?: string): Promise<{ token: string; profile: string }> {
  expect((await api('POST', '/user/register', { body: invite === undefined ? { username, password: PASSWORD } : { username, password: PASSWORD, invite } })).status).toBe(201);
  const token = (await api<{ token: string }>('POST', '/user/login', { body: { username, password: PASSWORD } })).body.token;
  const profile = (await api<{ id: string }>('POST', '/user/profiles', { token, body: { name: username } })).body.id;
  return { token, profile };
}

async function join(member: { token: string; profile: string }, roomId: string): Promise<Peer> {
  const ticket = await api<{ wsPath: string }>('POST', `/party/${roomId}/join`, { token: member.token, body: { profileId: member.profile } });
  expect(ticket.status).toBe(200);
  const res = await worker.fetch(`https://worker.test${ticket.body.wsPath}`, { headers: { upgrade: 'websocket', 'cf-connecting-ip': '192.0.2.250' } });
  expect(res.status).toBe(101);
  const peer = new Peer((res as unknown as { webSocket: unknown }).webSocket);
  await peer.next((m) => m.t === 'welcome');
  return peer;
}

describe('signalements de salon -> administration', () => {
  it('le signalement arrive dans la file ; supprimer le message le retire du salon ; suspendre l\'auteur', async () => {
    const owner = await register('proprio');
    const invites = (await api<{ invites: { code: string }[] }>('GET', '/user/invites', { token: owner.token })).body.invites;
    const bob = await register('bob', invites[0]?.code);
    const carol = await register('carol', invites[1]?.code);

    const created = await api<{ room: { id: string } }>('POST', '/party', {
      token: bob.token,
      body: { profileId: bob.profile, visibility: 'private', title: 'Matrix', media: { type: 'movie', tmdbId: 603 } },
    });
    expect(created.status).toBe(201);
    const roomId = created.body.room.id;
    const host = await join(bob, roomId);
    const guest = await join(carol, roomId);

    // Annuaire d'administration : le salon actif (privé compris) est listé.
    const rooms = await api<{ rooms: any[] }>('GET', '/admin/party/rooms', { token: owner.token });
    expect(rooms.body.rooms).toEqual([expect.objectContaining({ id: roomId, host: 'bob', visibility: 'private' })]);

    host.send({ t: 'chat', text: 'message à signaler' });
    const line = await guest.next((m) => m.t === 'chat');
    guest.send({ t: 'report', messageId: line.line.id, reason: 'spam' });
    await guest.next((m) => m.t === 'reported');

    // File d'administration alimentée au moment du signalement.
    let reports: any[] = [];
    for (let attempt = 0; attempt < 20 && reports.length === 0; attempt += 1) {
      reports = (await api<{ reports: any[] }>('GET', '/admin/party/reports', { token: owner.token })).body.reports;
      if (reports.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reports).toEqual([expect.objectContaining({ roomId, by: 'carol', against: 'bob', reason: 'spam', status: 'open', text: 'message à signaler' })]);
    expect(reports[0].againstId).toEqual(expect.any(String));

    // Suppression du message : le salon prévient ses participants et l'historique le perd.
    const deleted = await api('POST', `/admin/party/reports/${reports[0].id}/action`, { token: owner.token, body: { action: 'delete' } });
    expect(deleted.status).toBe(200);
    expect((await guest.next((m) => m.t === 'removed')).messageId).toBe(line.line.id);
    const reportsInRoom = await api<{ reports: any[] }>('GET', `/party/${roomId}/reports`, { token: owner.token });
    expect(reportsInRoom.body.reports).toEqual([]);

    // Fermeture forcée : élévation exigée.
    expect((await api('DELETE', `/admin/party/rooms/${roomId}`, { token: owner.token })).status).toBe(403);
    const elevation = (await api<{ token: string }>('POST', '/admin/elevate', { token: owner.token, body: { password: PASSWORD } })).body.token;
    expect((await api('DELETE', `/admin/party/rooms/${roomId}`, { token: owner.token, headers: { 'x-admin-elevation': elevation } })).status).toBe(204);
    expect((await api('GET', `/party/${roomId}`, { token: bob.token })).status).toBe(404);
    expect((await api<{ rooms: any[] }>('GET', '/admin/party/rooms', { token: owner.token })).body.rooms).toEqual([]);
  });
});
