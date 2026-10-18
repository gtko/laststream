/* eslint-disable @typescript-eslint/no-explicit-any -- messages JSON dynamiques du protocole des salons */
import { exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { driftAction, estimateOffset, expectedPosition } from '../src/party/sync.js';

/**
 * Salons de visionnage contre le vrai Worker (src/worker.ts) : REST, tickets, WebSocket avec l'API d'hibernation,
 * Durable Objects PartyRoom et UserStoreDO de Miniflare. Les comptes sont créés avec des invitations « système »
 * (route /__admin/invite), donc sans dépendre de l'état de la base.
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

interface Account {
  name: string;
  token: string;
  profile: string;
}

let accountSeq = 0;
/** Compte neuf (invitation système), avec un profil adulte ; `kid` ajoute un profil enfant. */
async function account(prefix: string, options: { kid?: boolean } = {}): Promise<Account & { kidProfile?: string }> {
  const name = `${prefix}${++accountSeq}x${Math.floor(Math.random() * 1e6)}`.toLowerCase().slice(0, 30);
  const invite = await api<{ code: string }>('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  expect(invite.status).toBe(200);
  const reg = await api('POST', '/user/register', { body: { username: name, password: PASSWORD, invite: invite.body.code } });
  // Le tout premier compte du Durable Object s'inscrit sans lien (invitation alors inutilisée).
  expect(reg.status).toBe(201);
  const login = await api<{ token: string }>('POST', '/user/login', { body: { username: name, password: PASSWORD } });
  const token = login.body.token;
  const profile = await api<{ id: string }>('POST', '/user/profiles', { token, body: { name, avatarColor: '#aa5500' } });
  const result: Account & { kidProfile?: string } = { name, token, profile: profile.body.id };
  if (options.kid === true) {
    const kid = await api<{ id: string }>('POST', '/user/profiles', { token, headers: { 'x-profile-id': profile.body.id }, body: { name: 'petit', isKid: true } });
    result.kidProfile = kid.body.id;
  }
  await api('DELETE', `/__admin/invite/${invite.body.code}`, { headers: { 'x-admin-secret': ADMIN } });
  return result;
}

const movie = { type: 'movie', tmdbId: 603 };
const fingerprint = { fileName: 'The.Matrix.1999.1080p.mkv', size: 8_000_000_000, hash: 'abcdef0123456789abcdef' };

async function createRoom(host: Account, extra: Record<string, unknown> = {}) {
  return await api<{ room: { id: string; [k: string]: any } } & Record<string, any>>('POST', '/party', {
    token: host.token,
    body: { profileId: host.profile, visibility: 'private', title: 'Matrix', poster: '/matrix.jpg', language: 'fr', media: movie, fingerprint, ...extra },
  });
}

async function ticketFor(member: Account, roomId: string, profileId = member.profile) {
  return await api<{ ticket: string; wsPath: string; room: any } & Record<string, any>>('POST', `/party/${roomId}/join`, { token: member.token, body: { profileId } });
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
    this.ws.send(JSON.stringify(message));
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

/** Rejoint un salon : ticket REST puis WebSocket ; renvoie le pair et son message d'accueil. */
async function join(member: Account, roomId: string, profileId = member.profile): Promise<{ peer: Peer; welcome: any }> {
  const ticket = await ticketFor(member, roomId, profileId);
  expect(ticket.status).toBe(200);
  const res = await upgrade(ticket.body.wsPath);
  expect(res.status).toBe(101);
  const peer = new Peer((res as unknown as { webSocket: unknown }).webSocket);
  return { peer, welcome: await peer.type('welcome') };
}

describe('watch party sur Workers', () => {
  it('création, détail et liste : salon public listé (titre, affiche, nombre, langue), salon privé jamais listé', async () => {
    const host = await account('host');
    const viewer = await account('viewer');
    const pub = await createRoom(host, { visibility: 'public', title: 'Salon public Matrix' });
    expect(pub.status).toBe(201);
    expect(pub.body.room).toMatchObject({ visibility: 'public', title: 'Salon public Matrix', host: host.name, participants: 0, maxParticipants: 20, language: 'fr', media: { type: 'movie', tmdbId: 603 }, fingerprint });
    const priv = await createRoom(host, { visibility: 'private', title: 'Salon privé secret' });
    expect(priv.status).toBe(201);

    const list = await api<{ rooms: any[]; nextCursor: string | null }>('GET', `/party?profileId=${viewer.profile}`, { token: viewer.token });
    expect(list.status).toBe(200);
    const row = list.body.rooms.find((r) => r.id === pub.body.room.id);
    expect(row).toEqual({
      id: pub.body.room.id,
      title: 'Salon public Matrix',
      poster: '/matrix.jpg',
      language: 'fr',
      mediaType: 'movie',
      host: host.name,
      participants: 0,
      maxParticipants: 20,
      createdAt: expect.any(String),
    });
    expect(list.body.rooms.some((r) => r.id === priv.body.room.id)).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain(host.token);

    // Un salon privé se retrouve par son identifiant (le lien).
    const detail = await api<{ room: any }>('GET', `/party/${priv.body.room.id}`, { token: viewer.token });
    expect(detail.status).toBe(200);
    expect(detail.body.room.title).toBe('Salon privé secret');
    expect((await api('GET', '/party/inexistant0123456789', { token: viewer.token })).status).toBe(404);
    // Filtre de langue.
    const en = await api<{ rooms: any[] }>('GET', '/party?language=en', { token: viewer.token });
    expect(en.body.rooms.some((r) => r.id === pub.body.room.id)).toBe(false);
  });

  it('comptes Laststream seulement : aucune route sans session', async () => {
    expect((await api('GET', '/party')).status).toBe(401);
    expect((await api('POST', '/party', { body: {} })).status).toBe(401);
    const host = await account('host');
    const room = await createRoom(host);
    expect((await api('POST', `/party/${room.body.room.id}/join`, { body: { profileId: 'x' } })).status).toBe(401);
    expect((await upgrade(`/party/${room.body.room.id}/ws`)).status).toBe(401);
  });

  it('profils enfants : refusés pour créer ou lister ou rejoindre un salon public, admis en privé', async () => {
    const parent = await account('parent', { kid: true });
    const host = await account('host');
    const kid = parent.kidProfile ?? '';
    const refused = await createRoom({ ...parent, profile: kid }, { visibility: 'public' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('kid_profile');
    const list = await api('GET', `/party?profileId=${kid}`, { token: parent.token });
    expect(list.status).toBe(403);

    const pub = await createRoom(host, { visibility: 'public' });
    const join403 = await ticketFor(parent, pub.body.room.id, kid);
    expect(join403.status).toBe(403);
    expect(join403.body.error).toBe('kid_profile');
    expect((await api('GET', `/party/${pub.body.room.id}?profileId=${kid}`, { token: parent.token })).status).toBe(403);

    // Salon privé : le profil enfant peut le créer et le rejoindre par lien.
    const own = await createRoom({ ...parent, profile: kid }, { visibility: 'private' });
    expect(own.status).toBe(201);
    const priv = await createRoom(host, { visibility: 'private' });
    expect((await ticketFor(parent, priv.body.room.id, kid)).status).toBe(200);
  });

  it('rejoindre : accueil avec l’identité du titre et l’empreinte, aucun lien de lecture ni identifiant de compte', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    expect(h.welcome.you).toEqual({ username: host.name, host: true, muted: false, peerId: expect.any(String) });
    expect(h.welcome.room).toMatchObject({ id: room.id, title: 'Matrix', host: host.name, media: { type: 'movie', tmdbId: 603 }, fingerprint, maxParticipants: 20 });
    expect(h.welcome.state).toMatchObject({ playing: false, pos: 0 });
    const g = await join(guest, room.id);
    expect(g.welcome.you).toEqual({ username: guest.name, host: false, muted: false, peerId: expect.any(String) });
    expect(g.welcome.participants.map((p: any) => p.username).sort()).toEqual([guest.name, host.name].sort());
    expect(g.welcome.participants.find((p: any) => p.username === host.name)).toMatchObject({ host: true, avatarColor: '#aa5500' });
    const hostSees = await h.peer.type('join');
    expect(hostSees.participant.username).toBe(guest.name);
    const serialized = JSON.stringify([g.welcome, hostSees]);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toContain(guest.token);
    h.peer.close();
    g.peer.close();
  });

  it('lecture partagée : play, pause et seek de tout participant diffusés à tous ; rapport de position réservé à l’hôte', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const g = await join(guest, room.id);

    // L'invité met la lecture en marche : l'hôte et l'invité reçoivent le même état, daté par l'invité.
    g.peer.send({ t: 'ctl', action: 'play', pos: 10 });
    const onHost = await h.peer.type('state');
    const onGuest = await g.peer.type('state');
    expect(onGuest).toMatchObject({ state: { playing: true, pos: 10, rev: 1 }, by: guest.name });
    expect(onHost.state).toEqual(onGuest.state);

    // Le rapport de position périodique reste réservé à l'hôte.
    g.peer.send({ t: 'ctl', action: 'sync', pos: 11 });
    expect((await g.peer.type('error')).code).toBe('not_host');

    // Horloge : ping / pong, décalage estimé, position attendue après un délai.
    const t0 = Date.now();
    g.peer.send({ t: 'ping', c: t0 });
    const pong = await g.peer.type('pong');
    const t1 = Date.now();
    expect(pong.c).toBe(t0);
    const offset = estimateOffset(t0, t1, pong.s);
    expect(Math.abs(offset)).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 400));
    g.peer.send({ t: 'sync' });
    const resync = await g.peer.type('state');
    const expected = expectedPosition(resync.state, Date.now() + offset);
    expect(expected).toBeGreaterThan(10.3);
    expect(expected).toBeLessThan(12.5);
    // Un lecteur qui aurait 3 s d'avance saute ; 1 s de retard accélère légèrement ; 0,1 s d'écart est ignoré.
    expect(driftAction(expected + 3, expected, true).kind).toBe('seek');
    expect(driftAction(expected - 1, expected, true)).toEqual({ kind: 'rate', rate: 1.05 });
    expect(driftAction(expected + 0.1, expected, true).kind).toBe('none');

    h.peer.send({ t: 'ctl', action: 'seek', pos: 300 });
    expect((await g.peer.type('state')).state).toMatchObject({ pos: 300, playing: true, rev: 2 });
    h.peer.send({ t: 'ctl', action: 'pause', pos: 305 });
    expect((await g.peer.type('state')).state).toMatchObject({ pos: 305, playing: false, rev: 3 });

    // Une reprise par l'invité arrive à l'hôte (l'autre sens).
    g.peer.send({ t: 'ctl', action: 'play', pos: 305 });
    expect(await h.peer.next((m) => m.t === 'state' && m.state.rev === 4)).toMatchObject({ state: { playing: true, pos: 305, rev: 4 }, by: guest.name });

    // Un arrivant tardif récupère l'état courant.
    const late = await account('late');
    const l = await join(late, room.id);
    expect(l.welcome.state).toMatchObject({ pos: 305, playing: true, rev: 4 });
    for (const p of [h.peer, g.peer, l.peer]) p.close();
  });

  it('changement d’épisode par l’hôte : média, empreinte et position remise à zéro pour tous', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const created = await createRoom(host, { media: { type: 'series', tmdbId: 95396, season: 1, episode: 1 } });
    const room = created.body.room;
    expect(room.media).toMatchObject({ type: 'series', season: 1, episode: 1 });
    const h = await join(host, room.id);
    const g = await join(guest, room.id);
    h.peer.send({ t: 'ctl', action: 'play', pos: 700 });
    await g.peer.type('state');
    g.peer.send({ t: 'episode', season: 1, episode: 2 });
    expect((await g.peer.type('error')).code).toBe('not_host');
    h.peer.send({ t: 'episode', season: 1, episode: 2, fingerprint: { fileName: 'S01E02.mkv', size: 1_500_000_000 } });
    const media = await g.peer.type('media');
    expect(media).toMatchObject({ media: { season: 1, episode: 2 }, fingerprint: { fileName: 'S01E02.mkv', size: 1_500_000_000, hash: null }, state: { playing: false, pos: 0 } });
    const info = await api<{ room: any }>('GET', `/party/${room.id}`, { token: guest.token });
    expect(info.body.room.media).toMatchObject({ season: 1, episode: 2 });
    h.peer.close();
    g.peer.close();
  });

  it('chat et réactions diffusés à tous ; message filtré ; débit limité par participant', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const g = await join(guest, room.id);
    g.peer.send({ t: 'chat', text: 'salut tout le monde, voir https://spam.example/x' });
    const line = (await h.peer.type('chat')).line;
    expect(line).toMatchObject({ from: guest.name, text: 'salut tout le monde, voir [lien]' });
    expect(JSON.stringify(line)).not.toMatch(/fromId/);
    h.peer.send({ t: 'react', emoji: '🔥' });
    expect(await g.peer.type('react')).toMatchObject({ user: host.name, emoji: '🔥' });
    g.peer.send({ t: 'react', emoji: 'pas-un-emoji' });
    expect((await g.peer.type('error')).code).toBe('invalid_reaction');

    for (let i = 0; i < 8; i += 1) g.peer.send({ t: 'chat', text: `spam ${i}` });
    expect((await g.peer.next((m) => m.t === 'error' && m.code === 'rate_limited')).code).toBe('rate_limited');
    // L'hôte, lui, écrit toujours.
    h.peer.send({ t: 'chat', text: 'moi je peux' });
    expect((await g.peer.next((m) => m.t === 'chat' && m.line.text === 'moi je peux')).line.from).toBe(host.name);
    h.peer.close();
    g.peer.close();
  });

  it('modération : muet, signalement, exclusion définitive', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const other = await account('other');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const g = await join(guest, room.id);
    const o = await join(other, room.id);

    // Seul l'hôte modère.
    g.peer.send({ t: 'kick', user: other.name });
    expect((await g.peer.type('error')).code).toBe('not_host');

    // Rendre muet.
    h.peer.send({ t: 'mute', user: guest.name, muted: true });
    expect(await g.peer.type('muted')).toEqual({ t: 'muted', user: guest.name, muted: true });
    g.peer.send({ t: 'chat', text: 'bonjour ?' });
    expect((await g.peer.type('error')).code).toBe('muted');

    // Signalement : le message d'un autre est retrouvé par son identifiant, l'hôte est prévenu et la liste est lisible par lui.
    o.peer.send({ t: 'chat', text: 'un message à signaler' });
    const said = (await g.peer.next((m) => m.t === 'chat')).line;
    g.peer.send({ t: 'report', messageId: said.id, reason: 'spam' });
    expect((await g.peer.type('reported')).messageId).toBe(said.id);
    const hostNotice = await h.peer.next((m) => m.t === 'reported');
    expect(hostNotice).toMatchObject({ by: guest.name, against: other.name, text: 'un message à signaler' });
    const reports = await api<{ reports: any[] }>('GET', `/party/${room.id}/reports`, { token: host.token });
    expect(reports.body.reports).toEqual([expect.objectContaining({ by: guest.name, against: other.name, reason: 'spam' })]);
    expect((await api('GET', `/party/${room.id}/reports`, { token: guest.token })).status).toBe(403);

    // Exclusion : fermeture 4003, impossible de revenir (REST et WebSocket).
    const staleTicket = await ticketFor(other, room.id);
    h.peer.send({ t: 'kick', user: other.name });
    expect(await o.peer.whenClosed()).toMatchObject({ code: 4003 });
    expect((await h.peer.next((m) => m.t === 'leave' && m.user === other.name)).user).toBe(other.name);
    const again = await ticketFor(other, room.id);
    expect(again.status).toBe(403);
    expect(again.body.error).toBe('banned');
    expect((await upgrade(staleTicket.body.wsPath)).status).toBe(403);
    h.peer.close();
    g.peer.close();
  });

  it('limite de participants : salon plein refusé à la porte, reconnexion du même compte acceptée', async () => {
    const host = await account('host');
    const a = await account('a');
    const b = await account('b');
    const room = (await createRoom(host, { maxParticipants: 2 })).body.room;
    expect(room.maxParticipants).toBe(2);
    const h = await join(host, room.id);
    const first = await join(a, room.id);
    // b obtient son ticket avant que le salon soit plein pour tester aussi le refus côté socket.
    const early = await ticketFor(b, room.id);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('room_full');

    // Reconnexion de a : l'ancienne connexion est remplacée (4009), le salon reste à 2.
    const second = await join(a, room.id);
    expect(await first.peer.whenClosed()).toMatchObject({ code: 4009 });
    const info = await api<{ room: any }>('GET', `/party/${room.id}`, { token: a.token });
    expect(info.body.room.participants).toBe(2);
    second.peer.close();
    h.peer.close();
    expect((await api('POST', '/party', { token: host.token, body: { profileId: host.profile, title: 'x', media: movie, maxParticipants: 21 } })).status).toBe(400);
    expect((await api('POST', '/party', { token: host.token, body: { profileId: host.profile, title: 'x', media: movie, maxParticipants: 1 } })).status).toBe(400);
  });

  it('tickets : invalide, d’un autre salon, sans mise à niveau ou depuis une origine inconnue refusés', async () => {
    const host = await account('host');
    const room = (await createRoom(host)).body.room;
    const other = (await createRoom(host)).body.room;
    const t = await ticketFor(host, room.id);
    expect((await upgrade(`/party/${room.id}/ws?ticket=bidon`)).status).toBe(401);
    expect((await upgrade(`/party/${other.id}/ws?ticket=${t.body.ticket}`)).status).toBe(401);
    expect((await worker.fetch(`https://worker.test/party/${room.id}/ws?ticket=${t.body.ticket}`, { headers: { 'cf-connecting-ip': nextIp() } })).status).toBe(426);
    expect((await upgrade(`/party/${room.id}/ws?ticket=${t.body.ticket}`, { origin: 'https://evil.example' })).status).toBe(403);
    // Le ticket bon est toujours utilisable (jusqu'à expiration).
    const ok = await upgrade(`/party/${room.id}/ws?ticket=${t.body.ticket}`);
    expect(ok.status).toBe(101);
    new Peer((ok as unknown as { webSocket: any }).webSocket).close();
  });

  it('fin du salon : fermeture (4000) de tous, retiré de l’annuaire ; seul l’hôte la demande', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const room = (await createRoom(host, { visibility: 'public', title: 'Salon éphémère' })).body.room;
    const g = await join(guest, room.id);
    expect((await api('DELETE', `/party/${room.id}`, { token: guest.token })).status).toBe(403);
    expect((await api('DELETE', `/party/${room.id}`, { token: host.token })).status).toBe(204);
    expect(await g.peer.whenClosed()).toMatchObject({ code: 4000 });
    expect((await api('GET', `/party/${room.id}`, { token: guest.token })).status).toBe(404);
    const list = await api<{ rooms: any[] }>('GET', '/party', { token: guest.token });
    expect(list.body.rooms.some((r) => r.id === room.id)).toBe(false);
    expect((await ticketFor(guest, room.id)).status).toBe(404);
  });

  it('transfert d’hôte et fin par l’hôte via le socket', async () => {
    const host = await account('host');
    const guest = await account('guest');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const g = await join(guest, room.id);
    h.peer.send({ t: 'transfer', user: guest.name });
    expect(await g.peer.type('host')).toEqual({ t: 'host', user: guest.name });
    // L'ancien hôte garde la lecture partagée (pause), mais plus le rapport de position.
    h.peer.send({ t: 'ctl', action: 'pause', pos: 1 });
    expect((await g.peer.type('state')).by).toBe(host.name);
    expect((await h.peer.type('state')).by).toBe(host.name);
    h.peer.send({ t: 'ctl', action: 'sync', pos: 1 });
    expect((await h.peer.type('error')).code).toBe('not_host');
    // Le nouvel hôte reprend la lecture : l'ancien hôte la reçoit.
    g.peer.send({ t: 'ctl', action: 'play', pos: 1 });
    expect((await h.peer.type('state')).by).toBe(guest.name);
    g.peer.send({ t: 'end' });
    expect(await h.peer.whenClosed()).toMatchObject({ code: 4000 });
  });

  it('plafond de salons ouverts par hôte, entrées invalides refusées', async () => {
    const host = await account('host');
    for (let i = 0; i < 3; i += 1) expect((await createRoom(host)).status).toBe(201);
    const fourth = await createRoom(host);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('too_many_rooms');
    const other = await account('host');
    expect((await api('POST', '/party', { token: other.token, body: { profileId: other.profile, title: '', media: movie } })).status).toBe(400);
    expect((await api('POST', '/party', { token: other.token, body: { profileId: other.profile, title: 'x', media: { type: 'movie' } } })).status).toBe(400);
    expect((await api('POST', '/party', { token: other.token, body: { profileId: other.profile, title: 'x', media: movie, poster: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await api('POST', '/party', { token: other.token, body: { profileId: host.profile, title: 'x', media: movie } })).status).toBe(404);
  });

  it('liste publique paginée par curseur', async () => {
    const host = await account('pager');
    const viewer = await account('viewer');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const author = i === 0 ? host : await account('pager');
      ids.push((await createRoom(author, { visibility: 'public', title: `Page ${i}` })).body.room.id);
    }
    const seen: string[] = [];
    let cursor = '';
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await api<{ rooms: any[]; nextCursor: string | null }>('GET', `/party?limit=2${cursor}`, { token: viewer.token });
      expect(page.status).toBe(200);
      expect(page.body.rooms.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.rooms.map((r) => r.id));
      if (page.body.nextCursor === null) break;
      cursor = `&cursor=${encodeURIComponent(page.body.nextCursor)}`;
    }
    for (const id of ids) expect(seen).toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

/** Connexion WebSocket d'un invité sans compte : jeton de POST /party/:id/invite et pseudo. */
async function guestSocket(roomId: string, token: string, name: string): Promise<{ res: Response; peer?: Peer; welcome?: any }> {
  const res = await upgrade(`/party/${roomId}/ws?t=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`);
  if (res.status !== 101) return { res };
  const peer = new Peer((res as unknown as { webSocket: unknown }).webSocket);
  return { res, peer, welcome: await peer.type('welcome') };
}

async function inviteFrom(member: Account, roomId: string) {
  return await api<{ token: string; expiresAt: string }>('POST', `/party/${roomId}/invite`, { token: member.token, body: { profileId: member.profile } });
}

/** Attend que le nombre de participants du salon atteigne `expected` (fermetures de sockets traitées par le Durable Object). */
async function waitForParticipants(roomId: string, token: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const info = await api<{ room: { participants: number } }>('GET', `/party/${roomId}`, { token });
    if (info.body.room?.participants === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`participants attendus : ${expected}`);
}

describe('invités sans compte sur Workers', () => {
  it('invitation réservée aux membres connectés (401 sans session, 403 hors salon, 404 salon inconnu) ; jeton signé avec échéance', async () => {
    const host = await account('host');
    const outsider = await account('outsider');
    const room = (await createRoom(host)).body.room;
    expect((await api('POST', `/party/${room.id}/invite`, { body: { profileId: host.profile } })).status).toBe(401);
    expect((await inviteFrom(host, room.id)).status).toBe(403);
    const h = await join(host, room.id);
    const invite = await inviteFrom(host, room.id);
    expect(invite.status).toBe(201);
    expect(invite.body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Date.parse(invite.body.expiresAt) - Date.now()).toBeGreaterThan(11 * 3600_000);
    const notMember = await api('POST', `/party/${room.id}/invite`, { token: outsider.token, body: { profileId: outsider.profile } });
    expect(notMember.status).toBe(403);
    expect(notMember.body.error).toBe('not_member');
    expect((await api('POST', '/party/inexistant0123456789/invite', { token: host.token, body: { profileId: host.profile } })).status).toBe(404);
    h.peer.close();
  });

  it('connexion invitée : pseudo nettoyé, drapeau guest dans la liste, pas de compte ni de jeton dans les messages', async () => {
    const host = await account('host');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const { token } = (await inviteFrom(host, room.id)).body;
    const g = await guestSocket(room.id, token, '  Léa​   Dupont-Martin-de-la-Rochefoucauld  ');
    expect(g.res.status).toBe(101);
    // 24 caractères au plus : « Léa Dupont-Martin-de-la- ». L'affiche du salon n'est pas envoyée à l'invité.
    const shown = 'Léa Dupont-Martin-de-la-';
    expect(g.welcome.room.poster).toBeNull();
    expect(h.welcome.room.poster).toBe('/matrix.jpg');
    expect(g.welcome.you).toEqual({ username: shown, host: false, muted: false, peerId: expect.any(String) });
    expect(g.welcome.participants.find((p: any) => p.username === host.name)).not.toHaveProperty('guest');
    expect(g.welcome.participants.find((p: any) => p.username === shown)).toMatchObject({ guest: true });
    const joined = await h.peer.next((m) => m.t === 'join' && m.participant.guest === true);
    expect(joined.participant).toMatchObject({ username: shown, guest: true, peerId: expect.any(String) });
    const serialized = JSON.stringify([g.welcome, joined]);
    expect(serialized).not.toContain(host.token);
    expect(serialized).not.toContain(host.profile);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/https?:\/\//);
    g.peer?.close();
    h.peer.close();
  });

  it('invité : lecture partagée comme les autres ; ne modère pas, ne termine pas ; signalisation ciblée', async () => {
    const host = await account('host');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const { token } = (await inviteFrom(host, room.id)).body;
    const g = await guestSocket(room.id, token, 'Léa');
    const guestPeer = g.peer as Peer;
    const hostPeerId: string = h.welcome.you.peerId;
    const guestPeerId: string = g.welcome.you.peerId;

    guestPeer.send({ t: 'ctl', action: 'play', pos: 12 });
    expect(await h.peer.next((m) => m.t === 'state' && m.state.playing === true)).toMatchObject({ state: { pos: 12 }, by: 'Léa' });

    guestPeer.send({ t: 'kick', user: host.name });
    expect((await guestPeer.type('error')).code).toBe('not_host');
    guestPeer.send({ t: 'end' });
    expect((await guestPeer.type('error')).code).toBe('not_host');

    // Signalisation : l'invité envoie une offre à l'hôte, l'hôte reçoit exactement le relais, sans diffusion.
    const offer = { sdp: 'v=0 o=- 1 2 IN IP4 127.0.0.1', type: 'offer' };
    guestPeer.send({ type: 'rtc', to: hostPeerId, data: offer });
    expect(await h.peer.next((m) => m.type === 'rtc')).toEqual({ type: 'rtc', from: guestPeerId, data: offer });

    // Réponse de l'hôte vers l'invité.
    h.peer.send({ type: 'rtc', to: guestPeerId, data: { type: 'answer', sdp: 'v=0' } });
    expect(await guestPeer.next((m) => m.type === 'rtc')).toEqual({ type: 'rtc', from: hostPeerId, data: { type: 'answer', sdp: 'v=0' } });

    // Refus : pair inconnu, soi-même, donnée au-delà de 16 Ko.
    guestPeer.send({ type: 'rtc', to: 'inconnu-0123456789', data: {} });
    expect((await guestPeer.type('error')).code).toBe('peer_not_found');
    guestPeer.send({ type: 'rtc', to: guestPeerId, data: {} });
    expect((await guestPeer.type('error')).code).toBe('cannot_target_self');
    guestPeer.send({ type: 'rtc', to: hostPeerId, data: { blob: 'x'.repeat(16 * 1024) } });
    expect((await guestPeer.type('error')).code).toBe('rtc_too_large');
    expect(h.peer.messages.some((m) => m.type === 'rtc' && m.from === guestPeerId && m.data.blob !== undefined)).toBe(false);
    guestPeer.close();
    h.peer.close();
  });

  it('au plus 4 invités connectés : le 5e est refusé (409 guest_limit) ; pseudo d’un membre refusé (409 name_taken)', async () => {
    const host = await account('host');
    const room = (await createRoom(host)).body.room;
    const h = await join(host, room.id);
    const peers: Peer[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const { token } = (await inviteFrom(host, room.id)).body;
      const g = await guestSocket(room.id, token, `Invité ${i}`);
      expect(g.res.status).toBe(101);
      peers.push(g.peer as Peer);
    }
    const fifth = (await inviteFrom(host, room.id)).body.token;
    const refused = await guestSocket(room.id, fifth, 'Invité 5');
    expect(refused.res.status).toBe(409);
    expect(await refused.res.json()).toEqual({ error: 'guest_limit' });

    // Une place libérée est reprise.
    peers[0]?.close();
    await h.peer.next((m) => m.t === 'leave' && m.user === 'Invité 1');
    const retry = await guestSocket(room.id, fifth, 'Invité 5');
    expect(retry.res.status).toBe(101);
    retry.peer?.close();

    // Pseudo d'un membre (casse ignorée) : refusé.
    const { token } = (await inviteFrom(host, room.id)).body;
    const clash = await guestSocket(room.id, token, host.name.toUpperCase());
    expect(clash.res.status).toBe(409);
    expect(await clash.res.json()).toEqual({ error: 'name_taken' });
    for (const p of peers) p.close();
    h.peer.close();
  });

  it('jeton invité refusé : falsifié, d’un autre salon, pseudo vide ; sans jeton, le ticket de compte reste requis', async () => {
    const host = await account('host');
    const room = (await createRoom(host)).body.room;
    const other = (await createRoom(host)).body.room;
    // L'invitation exige un membre connecté : l'hôte rejoint chaque salon avant d'inviter.
    const h = await join(host, room.id);
    const otherHost = await join(host, other.id);
    const { token } = (await inviteFrom(host, room.id)).body;
    const otherToken = (await inviteFrom(host, other.id)).body.token;
    const [body, signature] = token.split('.') as [string, string];
    const forged = `${body}.${signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`}`;
    expect((await upgrade(`/party/${room.id}/ws?t=${forged}&name=Léa`)).status).toBe(401);
    expect((await upgrade(`/party/${room.id}/ws?t=${otherToken}&name=Léa`)).status).toBe(401);
    expect((await upgrade(`/party/${room.id}/ws?t=${token}&name=%20%20`)).status).toBe(400);
    expect((await upgrade(`/party/${room.id}/ws?t=${token}`)).status).toBe(400);
    expect((await upgrade(`/party/${room.id}/ws?t=bidon&name=Léa`)).status).toBe(401);
    expect((await upgrade(`/party/${room.id}/ws?name=Léa`)).status).toBe(401);
    // Le jeton valide, lui, ouvre la connexion.
    const ok = await guestSocket(room.id, token, 'Léa');
    expect(ok.res.status).toBe(101);
    ok.peer?.close();
    h.peer.close();
    otherHost.peer.close();
    // Attendre que le Durable Object ait traité les fermetures (sinon le test se termine avant).
    await waitForParticipants(room.id, host.token, 0);
    await waitForParticipants(other.id, host.token, 0);
  });
});
