// Partage de lecture : session hôte (invités, débit montant) et session invité (salon -> hôte -> plages -> lecteur), avec un salon
// simulé (WebSocket factices reliés en mémoire, signalisation `rtc` relayée) et des connexions WebRTC factices.
import { describe, expect, it } from 'vitest';
import { PartyClient, type SocketLike } from '../party/client';
import { endText, leftText, refusedText } from '../party/join';
import { PIECE_SHIFT } from './mesh/pieces';
import type { RangeSource } from './host';
import { memoryChannelPair, type MemoryChannel } from './memory';
import type { PeerOptions } from './peer';
import { capsMask, encodeMesh, type DecodeCap } from './protocol';
import type { PlaybackPlan, PlayerCallbacks, PlayerStats, RoomState } from './player/types';
import { GuestRelaySession, HOLD_PROBE_MS, HostRelaySession, partySignal, type GuestPlayerLike, type GuestRelayDeps } from './session';

/** Salon simulé : chaque WebSocket connaît son pair ; un `rtc` envoyé est livré au destinataire avec `from`. */
class FakeSocket implements SocketLike {
  /** 1 = OUVERT : le client de salon se considère connecté dès la liaison. */
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  constructor(readonly peer: string, private readonly room: Room) {}

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg.type !== 'rtc') return;
    const target = this.room.get(String(msg.to));
    const from = this.peer;
    const payload = msg.data;
    if (target) setTimeout(() => target.recv({ type: 'rtc', from, data: payload }), 0);
  }

  /** Fermeture demandée par l'invité (« Quitter ») : observable par le test. */
  closed = false;

  close(): void {
    this.closed = true;
  }

  recv(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

class Room {
  private readonly sockets = new Map<string, FakeSocket>();

  socket(peer: string): FakeSocket {
    const s = new FakeSocket(peer, this);
    this.sockets.set(peer, s);
    return s;
  }

  get(peer: string): FakeSocket | undefined {
    return this.sockets.get(peer);
  }
}

/** Frame `welcome` du salon : l'hôte est `h1`, l'invité `p1` (participant `guest:true`). */
function welcome(me: string, host: boolean, participants: unknown[] = DEFAULT_PARTICIPANTS): Record<string, unknown> {
  return {
    t: 'welcome',
    you: { username: me, host, muted: false },
    room: {
      id: 'R1', visibility: 'private', title: 'Test', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 1 },
      fingerprint: null, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01T00:00:00Z',
    },
    state: { playing: false, pos: 0, at: 0, rev: 1 },
    serverTime: 0,
    participants,
    chat: [],
  };
}

const DEFAULT_PARTICIPANTS = [
  { username: 'alice', host: true, peerId: 'h1' },
  { username: 'bob', guest: true, peerId: 'p1' },
];

/** Connexions WebRTC factices : la piste de données est une paire de canaux en mémoire, sans réseau ni ICE. */
class FakePc {
  connectionState: RTCPeerConnectionState = 'new';
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  onicecandidate: ((ev: { candidate: { toJSON(): object } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(private readonly role: 'host' | 'guest', private readonly wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } }) {}

  createDataChannel(): unknown {
    const [host, guest] = memoryChannelPair(0);
    this.wire.ch = { host, guest };
    return host;
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: 'OFFER' };
  }

  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: 'ANSWER' };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(desc: { type: string }): Promise<void> {
    if (this.role === 'guest' && desc.type === 'offer' && this.wire.ch) this.ondatachannel?.({ channel: this.wire.ch.guest });
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.connectionState = 'closed';
  }
}

function pcFactory(role: 'host' | 'guest', wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } }): NonNullable<PeerOptions['createPc']> {
  return () => new FakePc(role, wire) as unknown as RTCPeerConnection;
}

/** Lecteur factice : enregistre les appels, lit tout le fichier au chargement (comme un décodeur), applique les états du salon. */
function fakePlayer(cb: PlayerCallbacks, plan: PlaybackPlan) {
  const log = { got: null as Uint8Array | null, applied: [] as RoomState[], plays: 0, destroyed: 0 };
  const player: GuestPlayerLike = {
    async load(reader) {
      if (plan.kind === 'native') {
        const n = await reader.size();
        log.got = await reader.read(0, n);
      }
      return plan;
    },
    play() {
      log.plays += 1;
      cb.onUserPlay?.(12.5);
    },
    pause() {
      cb.onUserPause?.(13);
    },
    seek(t: number) {
      cb.onUserSeek?.(t);
    },
    applyRoomState(room: RoomState) {
      log.applied.push(room);
    },
    getState() {
      return { playing: false, position: 0, duration: 0 };
    },
    getStats() {
      return { decodedFrames: 7, audioChunks: 5 } as unknown as PlayerStats;
    },
    destroy() {
      log.destroyed += 1;
    },
  };
  return { player, log };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const bytesOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >>> 8)) & 0xff);

function sourceOf(bytes: Uint8Array): RangeSource {
  return { size: async () => bytes.byteLength, read: async (s, e) => bytes.slice(s, e) };
}

/** Salon complet : hôte (h1) avec sa session de partage, invité (p1) avec sa session, lecteur factice. */
async function chain(plan: PlaybackPlan | PlaybackPlan[] = { kind: 'native' }, size = 300_000, probe?: () => Promise<DecodeCap[]>, extra: Partial<GuestRelayDeps> = {}) {
  // Une liste : un plan par ouverture du lecteur (le dernier sert ensuite).
  const plans = Array.isArray(plan) ? plan : [plan];
  const room = new Room();
  const wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } } = {};
  const bytes = bytesOf(size);
  const hostClient = new PartyClient({ connect: async () => room.socket('h1') });
  hostClient.start();
  await flush();
  room.get('h1')?.recv(welcome('alice', true));
  const hostRelay = new HostRelaySession({ client: hostClient, source: sourceOf(bytes), createPc: pcFactory('host', wire) });

  const players: Array<ReturnType<typeof fakePlayer>> = [];
  const guest = new GuestRelaySession({
    connect: async () => room.socket('p1'),
    createPlayer: (cb) => {
      const f = fakePlayer(cb, plans[Math.min(players.length, plans.length - 1)]);
      players.push(f);
      return f.player;
    },
    canvas: {} as unknown as HTMLCanvasElement,
    peer: { createPc: pcFactory('guest', wire) },
    connectTimeoutMs: 3000,
    decodeCaps: probe,
    ...extra,
  });
  guest.start();
  await flush();
  room.get('p1')?.recv(welcome('bob', false));
  return { room, hostClient, hostRelay, guest, players, bytes, wire };
}

describe('session hôte', () => {
  it('compte les invités du salon, ouvre une liaison au premier bonjour et la ferme au départ de l’invité', async () => {
    const room = new Room();
    const wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } } = {};
    const client = new PartyClient({ connect: async () => room.socket('h1') });
    client.start();
    await flush();
    const hostSock = room.get('h1')!;
    hostSock.recv(welcome('alice', true));
    const relay = new HostRelaySession({ client, source: sourceOf(bytesOf(1000)), createPc: pcFactory('host', wire) });
    expect(relay.stats()).toMatchObject({ guests: 1, links: 0, bytesSent: 0 });

    hostSock.recv({ type: 'rtc', from: 'p1', data: { t: 'hello' } });
    await flush();
    expect(hostSock.sent).toContainEqual({ type: 'rtc', to: 'p1', data: { t: 'offer', sdp: 'OFFER' } });
    expect(relay.stats().links).toBe(1);

    hostSock.recv({ t: 'leave', user: 'bob' });
    expect(relay.stats()).toMatchObject({ guests: 0, links: 0 });
    relay.close();
    client.close();
  });

  it('signalisation : le client de salon relaie les messages rtc vers le pair indiqué', async () => {
    const room = new Room();
    const client = new PartyClient({ connect: async () => room.socket('h1') });
    client.start();
    await flush();
    const sock = room.get('h1')!;
    sock.recv(welcome('alice', true));
    const seen: unknown[] = [];
    const signal = partySignal(client);
    signal.onMessage((from, data) => seen.push({ from, data }));
    sock.recv({ type: 'rtc', from: 'p1', data: { t: 'ice', candidate: null } });
    signal.send('p1', { t: 'hello' });
    expect(seen).toEqual([{ from: 'p1', data: { t: 'ice', candidate: null } }]);
    expect(sock.sent).toContainEqual({ type: 'rtc', to: 'p1', data: { t: 'hello' } });
    client.close();
  });
});

describe('session invité', () => {
  it('capacités de décodage : annoncées à l’hôte sur le canal, gardées tant que l’invité est présent, oubliées à son départ', async () => {
    const { room, hostRelay, guest } = await chain({ kind: 'native' }, 300_000, async () => ['h264', 'aac']);
    await waitFor(() => guest.tick().phase === 'ready');
    expect(hostRelay.guestCaps().get('p1')).toBe(capsMask(['h264', 'aac']));

    room.get('h1')!.recv({ t: 'leave', user: 'bob' });
    expect(hostRelay.guestCaps().size).toBe(0);

    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('sonde de capacités en échec : rien n’est annoncé (inconnu), l’hôte ne suppose aucune capacité', async () => {
    const { hostRelay, guest } = await chain({ kind: 'native' }, 300_000, async () => {
      throw new Error('sonde indisponible');
    });
    await waitFor(() => guest.tick().phase === 'ready');
    expect(hostRelay.guestCaps().has('p1')).toBe(false);

    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('après une bascule (liaison fermée côté hôte), l’invité se reconnecte seul et réannonce ses capacités', async () => {
    const probe = async (): Promise<DecodeCap[]> => ['h264', 'aac'];
    const { hostClient, hostRelay, guest, wire, bytes } = await chain({ kind: 'native' }, 300_000, probe);
    await waitFor(() => guest.tick().phase === 'ready');
    expect(hostRelay.guestCaps().get('p1')).toBe(capsMask(['h264', 'aac']));

    // Bascule de source : l'hôte ferme sa liaison ; le canal de l'invité se ferme avec elle.
    hostRelay.close();
    wire.ch!.guest.close();
    await waitFor(() => guest.tick().phase === 'host-lost', 4000);

    // La nouvelle liaison de l'hôte (nouvelle source) existe : l'invité la rejoint sans action, après un court délai.
    const hostRelay2 = new HostRelaySession({ client: hostClient, source: sourceOf(bytes), createPc: pcFactory('host', wire) });
    await waitFor(() => guest.tick().phase === 'ready', 8000);
    await waitFor(() => hostRelay2.guestCaps().get('p1') === capsMask(['h264', 'aac']), 4000);

    guest.destroy();
    hostRelay2.close();
  }, 20000);

  it('salon -> hôte (WebRTC) -> plages -> lecteur, puis play/pause/seek relayés au salon et état du salon appliqué sans écho', async () => {
    const { room, hostRelay, guest, players, bytes } = await chain();
    await waitFor(() => guest.tick().phase === 'ready');

    const player = players[0];
    expect(player.log.got).not.toBeNull();
    let mismatches = 0;
    for (let i = 0; i < bytes.byteLength; i += 1) if (player.log.got![i] !== bytes[i]) mismatches += 1;
    expect(mismatches).toBe(0);
    expect(hostRelay.stats().guests).toBe(1);
    expect(hostRelay.stats().bytesSent).toBeGreaterThanOrEqual(bytes.byteLength);

    guest.play();
    expect(room.get('p1')!.sent).toContainEqual({ t: 'ctl', action: 'play', pos: 12.5 });
    guest.pause();
    expect(room.get('p1')!.sent).toContainEqual({ t: 'ctl', action: 'pause', pos: 13 });
    guest.seekBy(10);
    expect(room.get('p1')!.sent).toContainEqual({ t: 'ctl', action: 'seek', pos: 10 });

    const ctlCount = (): number => room.get('p1')!.sent.filter((m) => m.t === 'ctl').length;
    const before = ctlCount();
    room.get('p1')!.recv({ t: 'state', state: { playing: true, pos: 20, at: 1000, rev: 3 }, serverTime: 1000 });
    const last = player.log.applied[player.log.applied.length - 1];
    expect(last).toMatchObject({ playing: true, position: 20 });
    // Appliquer un état du salon ne renvoie aucune commande au salon (pas d'écho).
    expect(ctlCount()).toBe(before);

    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('invité arrivé avant la lecture de l’hôte : attente, puis liaison automatique dès que l’hôte lit', async () => {
    const room = new Room();
    const wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } } = {};
    const hostClient = new PartyClient({ connect: async () => room.socket('h1') });
    hostClient.start();
    await flush();
    room.get('h1')!.recv(welcome('alice', true));
    const bytes = bytesOf(50_000);
    const players: Array<ReturnType<typeof fakePlayer>> = [];
    const fastTimer = (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 10));
    const guest = new GuestRelaySession({
      connect: async () => room.socket('p1'),
      createPlayer: (cb) => {
        const f = fakePlayer(cb, { kind: 'native' });
        players.push(f);
        return f.player;
      },
      canvas: {} as unknown as HTMLCanvasElement,
      peer: { createPc: pcFactory('guest', wire) },
      connectTimeoutMs: 40,
      setTimer: fastTimer,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    guest.start();
    await flush();
    room.get('p1')!.recv(welcome('bob', false));
    await waitFor(() => guest.tick().phase === 'waiting-host');
    expect(guest.tick().message).not.toBe('');

    // L'hôte lance sa lecture : la session de partage démarre ; la prochaine tentative de l'invité aboutit.
    const hostRelay = new HostRelaySession({ client: hostClient, source: sourceOf(bytes), createPc: pcFactory('host', wire) });
    await waitFor(() => guest.tick().phase === 'ready', 6000);
    expect(Array.from(players[0].log.got ?? [])).toEqual(Array.from(bytes));
    guest.destroy();
    hostRelay.close();
    hostClient.close();
  }, 15000);

  it('son non pris en charge : lecture prête avec la note du lecteur (vidéo seule)', async () => {
    const plan: PlaybackPlan = { kind: 'native', withoutAudio: true, note: 'Son non pris en charge par ce navigateur' };
    const { guest, hostRelay } = await chain(plan);
    await waitFor(() => guest.tick().phase === 'ready');
    expect(guest.tick().note).toBe(plan.note);
    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('format non pris en charge : phase unsupported avec le message du lecteur', async () => {
    const plan: PlaybackPlan = { kind: 'unsupported', message: 'Format non pris en charge dans ce navigateur (codec hevc).' };
    const { guest, hostRelay } = await chain(plan);
    await waitFor(() => guest.tick().phase === 'unsupported');
    expect(guest.tick().message).toBe(plan.message);
    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('format non pris en charge : non terminal ; la fermeture de la liaison (bascule de l’hôte) relance l’ouverture et le décodage', async () => {
    const unsupported: PlaybackPlan = { kind: 'unsupported', message: 'Format non pris en charge dans ce navigateur (codec hevc).' };
    const { hostClient, hostRelay, guest, wire, bytes, players } = await chain([unsupported, { kind: 'native' }]);
    await waitFor(() => guest.tick().phase === 'unsupported');
    expect(players[0].log.destroyed).toBe(1);

    // L'hôte bascule sur une source compatible : sa liaison se ferme (le canal de l'invité aussi), puis sa nouvelle session existe.
    hostRelay.close();
    wire.ch!.guest.close();
    await waitFor(() => guest.tick().phase === 'host-lost', 4000);
    const hostRelay2 = new HostRelaySession({ client: hostClient, source: sourceOf(bytes), createPc: pcFactory('host', wire) });
    await waitFor(() => guest.tick().phase === 'ready', 8000);
    expect(players).toHaveLength(2);

    guest.destroy();
    hostRelay2.close();
  }, 20000);

  it('format non pris en charge : un nouvel identifiant de fichier annoncé sur la liaison relance le décodage', async () => {
    const unsupported: PlaybackPlan = { kind: 'unsupported', message: 'Format non pris en charge dans ce navigateur (codec hevc).' };
    const { wire, guest, players, hostRelay } = await chain([unsupported, { kind: 'native' }]);
    await waitFor(() => guest.tick().phase === 'unsupported');

    // Sans maillage négocié, la première annonce sert de référence : même fichier, rien ne se passe.
    wire.ch!.host.send(encodeMesh(1, PIECE_SHIFT, 'meme-fichier'));
    await new Promise((r) => setTimeout(r, 50));
    expect(guest.tick().phase).toBe('unsupported');
    expect(players).toHaveLength(1);

    // L'hôte annonce un autre fichier (réponse MESH? avec un nouvel identifiant) : l'invité rouvre la lecture et réessaie.
    wire.ch!.host.send(encodeMesh(2, PIECE_SHIFT, 'autre-fichier'));
    await waitFor(() => guest.tick().phase === 'ready', 8000);
    expect(players).toHaveLength(2);

    guest.destroy();
    hostRelay.close();
  }, 20000);

  it('format non pris en charge : la vérification périodique de l’identifiant (MESH?) part sur la liaison, sans relance si le fichier est le même', async () => {
    const unsupported: PlaybackPlan = { kind: 'unsupported', message: 'Format non pris en charge dans ce navigateur (codec hevc).' };
    // Seule la vérification périodique est accélérée ; les autres délais restent réels.
    const fastProbe = (fn: () => void, ms: number) => setTimeout(fn, ms === HOLD_PROBE_MS ? 20 : ms);
    const { wire, guest, players, hostRelay } = await chain([unsupported, { kind: 'native' }], 300_000, undefined, {
      setTimer: fastProbe,
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    await waitFor(() => guest.tick().phase === 'unsupported');
    const sentBefore = wire.ch!.guest.sent;
    await waitFor(() => wire.ch!.guest.sent > sentBefore, 2000);
    await new Promise((r) => setTimeout(r, 60));
    expect(guest.tick().phase).toBe('unsupported');
    expect(players).toHaveLength(1);

    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('quitter : WebSocket du salon, relais, maillage et lecteur fermés ; état « left » ; aucune reconnexion ensuite', async () => {
    const { room, hostRelay, guest, players } = await chain();
    await waitFor(() => guest.tick().phase === 'ready');

    guest.leave();
    expect(guest.tick()).toMatchObject({ phase: 'left', message: leftText(), meshPeers: 0, playing: false });
    expect(players[0].log.destroyed).toBe(1);
    expect(room.get('p1')!.closed).toBe(true);

    guest.start();
    await flush();
    expect(guest.tick().phase).toBe('left');
    expect(room.get('p1')!.closed).toBe(true);
    hostRelay.close();
  }, 15000);

  it('diagnostic : compteurs numériques (images, sons, octets de l’hôte et des pairs), sans URL', async () => {
    const { guest, hostRelay } = await chain();
    await waitFor(() => guest.tick().phase === 'ready');
    guest.tick();
    const c = guest.debugCounts();
    expect(c).toEqual({ videoFrames: 7, audioData: 5, bytesFromHost: expect.any(Number), bytesFromPeers: 0 });
    expect(c.bytesFromHost).toBeGreaterThan(0);
    expect(JSON.stringify(c)).not.toMatch(/https?:|\//);
    guest.destroy();
    hostRelay.close();
  }, 15000);

  it('salon inaccessible (lien expiré, salon complet, pseudo pris) : refus après des échecs répétés, sans URL', async () => {
    const guest = new GuestRelaySession({
      connect: async () => {
        throw new Error('401');
      },
      createPlayer: (cb) => fakePlayer(cb, { kind: 'native' }).player,
      canvas: {} as unknown as HTMLCanvasElement,
      maxRefusals: 2,
      setTimer: (fn) => setTimeout(fn, 0),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    guest.start();
    await waitFor(() => guest.tick().phase === 'refused');
    expect(guest.tick().message).toBe(refusedText());
    expect(guest.tick().message).not.toMatch(/https?:/);
  });

  it('exclusion par l’hôte : fin de session avec le motif, sans reconnexion', async () => {
    const room = new Room();
    const wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } } = {};
    const hostClient = new PartyClient({ connect: async () => room.socket('h1') });
    hostClient.start();
    await flush();
    room.get('h1')!.recv(welcome('alice', true));
    const hostRelay = new HostRelaySession({ client: hostClient, source: sourceOf(bytesOf(10)), createPc: pcFactory('host', wire) });
    const guest = new GuestRelaySession({
      connect: async () => room.socket('p1'),
      createPlayer: (cb) => fakePlayer(cb, { kind: 'native' }).player,
      canvas: {} as unknown as HTMLCanvasElement,
    });
    guest.start();
    await flush();
    room.get('p1')!.recv(welcome('bob', false));
    room.get('p1')!.drop(4003);
    expect(guest.tick()).toMatchObject({ phase: 'ended', message: endText('kicked') });
    hostRelay.close();
    hostClient.close();
  });
});

describe('session hôte : admission', () => {
  it('hello d’un membre non invité : aucune offre ; fin du salon : liaisons fermées sans attendre', async () => {
    const room = new Room();
    const wire: { ch?: { host: MemoryChannel; guest: MemoryChannel } } = {};
    const client = new PartyClient({ connect: async () => room.socket('h1') });
    client.start();
    await flush();
    const hostSock = room.get('h1')!;
    hostSock.recv(welcome('alice', true, [...DEFAULT_PARTICIPANTS, { username: 'carol', peerId: 'p2' }]));
    const relay = new HostRelaySession({ client, source: sourceOf(bytesOf(1000)), createPc: pcFactory('host', wire) });

    hostSock.recv({ type: 'rtc', from: 'p2', data: { t: 'hello' } });
    await flush();
    expect(hostSock.sent.filter((m) => m.type === 'rtc' && m.to === 'p2')).toEqual([]);
    expect(relay.stats().links).toBe(0);

    hostSock.recv({ type: 'rtc', from: 'p1', data: { t: 'hello' } });
    await flush();
    expect(hostSock.sent).toContainEqual({ type: 'rtc', to: 'p1', data: { t: 'offer', sdp: 'OFFER' } });
    expect(relay.stats().links).toBe(1);

    hostSock.recv({ t: 'ended', reason: 'host_ended' });
    expect(relay.stats().links).toBe(0);
    relay.close();
    client.close();
  });
});
