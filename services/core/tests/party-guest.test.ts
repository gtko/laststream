import { describe, expect, it } from 'vitest';
import { cleanGuestName, GUEST_COLOR, GUEST_KEY_PREFIX, guestIdentity, signGuestToken, verifyGuestToken } from '../src/party/guest.js';
import {
  CLOSE,
  GUEST_NAME_MAX,
  GUEST_SESSION_MS,
  HOST_GRACE_MS,
  MAX_FRAME_BYTES,
  MAX_GUESTS,
  parseClientMessage,
  type RoomData,
  RTC_MAX_DATA_BYTES,
  RTC_MAX_FRAME_CHARS,
  type ServerMessage,
} from '../src/party/protocol.js';
import { type Effect, type Member, RoomCore, guestRefusal } from '../src/party/room-core.js';
import { signTicket, verifyTicket } from '../src/party/ticket.js';

const SECRET = 'guest-test-secret-with-more-than-32-chars';
const OTHER_SECRET = 'autre-secret-de-test-avec-plus-de-32-car';
const ROOM = 'room-0123456789abcdef';
const T0 = 1_800_000_000_000;

const decodePart = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
const encodePart = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('jeton invité : signature, expiration, salon', () => {
  it('valable pour son salon pendant la séance (12 h), avec un identifiant d’invité aléatoire propre à chaque jeton', async () => {
    const a = await signGuestToken(ROOM, T0, SECRET);
    const b = await signGuestToken(ROOM, T0, SECRET);
    expect(a.expiresAt).toBe(new Date(T0 + GUEST_SESSION_MS).toISOString());
    const first = await verifyGuestToken(a.token, ROOM, T0 + 1000, SECRET);
    const second = await verifyGuestToken(b.token, ROOM, T0 + 1000, SECRET);
    expect(first?.guestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(second?.guestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(first?.guestId).not.toBe(second?.guestId);
    // Le jeton ne porte que salon, identifiant et échéance : aucun nom, aucun compte.
    expect(Object.keys(decodePart(a.token.split('.')[0] ?? ''))).toEqual(['purpose', 'roomId', 'gid', 'exp']);
  });

  it('expire exactement à la fin de la séance', async () => {
    const { token } = await signGuestToken(ROOM, T0, SECRET);
    expect(await verifyGuestToken(token, ROOM, T0 + GUEST_SESSION_MS - 1, SECRET)).toBeDefined();
    expect(await verifyGuestToken(token, ROOM, T0 + GUEST_SESSION_MS, SECRET)).toBeUndefined();
  });

  it('refusé pour un autre salon ou un autre secret', async () => {
    const { token } = await signGuestToken(ROOM, T0, SECRET);
    expect(await verifyGuestToken(token, 'autre-salon-0123456789', T0, SECRET)).toBeUndefined();
    expect(await verifyGuestToken(token, ROOM, T0, OTHER_SECRET)).toBeUndefined();
    const forged = await signGuestToken(ROOM, T0, OTHER_SECRET);
    expect(await verifyGuestToken(forged.token, ROOM, T0, SECRET)).toBeUndefined();
  });

  it('falsifié : payload modifié (salon, échéance, propriété ajoutée) avec la signature d’origine refusé', async () => {
    const { token } = await signGuestToken(ROOM, T0, SECRET);
    const [body, signature] = token.split('.') as [string, string];
    const payload = decodePart(body);
    const longer = encodePart({ ...payload, exp: (payload.exp as number) + 9e9 });
    expect(await verifyGuestToken(`${longer}.${signature}`, ROOM, T0, SECRET)).toBeUndefined();
    const otherRoom = encodePart({ ...payload, roomId: 'autre-salon-0123456789' });
    expect(await verifyGuestToken(`${otherRoom}.${signature}`, 'autre-salon-0123456789', T0, SECRET)).toBeUndefined();
    const admin = encodePart({ ...payload, admin: true });
    expect(await verifyGuestToken(`${admin}.${signature}`, ROOM, T0, SECRET)).toBeUndefined();
    // Signature altérée d'un octet.
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(await verifyGuestToken(`${body}.${flipped}`, ROOM, T0, SECRET)).toBeUndefined();
  });

  it('forme invalide refusée sans exception', async () => {
    const { token } = await signGuestToken(ROOM, T0, SECRET);
    const body = token.split('.')[0] ?? '';
    for (const bad of ['', 'abc', 'a.b.c', '.signature', 'corps.', `${body}.`, `${body}.!!!`, `${body}.${'A'.repeat(2000)}`, `${'x'.repeat(2000)}.y`, `${encodePart('pas du json')}.AAAA`]) {
      expect(await verifyGuestToken(bad, ROOM, T0, SECRET)).toBeUndefined();
    }
  });

  it('domaines séparés : un ticket de compte n’est pas un jeton invité, et réciproquement', async () => {
    const identity = { accountId: 'a-1', username: 'bob', avatarColor: '#112233' };
    const { ticket } = signTicket(ROOM, identity, T0, SECRET);
    expect(await verifyGuestToken(ticket, ROOM, T0, SECRET)).toBeUndefined();
    const { token } = await signGuestToken(ROOM, T0, SECRET);
    expect(verifyTicket(token, ROOM, T0, SECRET)).toBeUndefined();
  });
});

describe('pseudo d’invité nettoyé', () => {
  it('espaces réduits, caractères invisibles retirés, 24 caractères au plus', () => {
    expect(cleanGuestName('  Léa   Dupont  ')).toBe('Léa Dupont');
    expect(cleanGuestName('​Al\u0007ice‮')).toBe('Alice');
    expect(cleanGuestName('x'.repeat(40))).toBe('x'.repeat(GUEST_NAME_MAX));
    // Un caractère composé (emoji) n'est jamais coupé en deux.
    expect(cleanGuestName('😀'.repeat(30))).toBe('😀'.repeat(GUEST_NAME_MAX));
    expect(cleanGuestName('y'.repeat(5000))).toHaveLength(GUEST_NAME_MAX);
  });

  it('vide ou absent : refusé', () => {
    expect(cleanGuestName(null)).toBeUndefined();
    expect(cleanGuestName('   ')).toBeUndefined();
    expect(cleanGuestName('​​')).toBeUndefined();
  });

  it('identité d’invité : clé préfixée, couleur fixe, drapeau guest', () => {
    expect(guestIdentity('abcdefghijklmnop', 'Léa')).toEqual({ accountId: `${GUEST_KEY_PREFIX}abcdefghijklmnop`, username: 'Léa', avatarColor: GUEST_COLOR, guest: true });
  });
});

const movie = { type: 'movie' as const, tmdbId: 603, imdbId: null, season: null, episode: null };

function makeRoom(options: { max?: number } = {}) {
  const clock = { now: T0 };
  const data: RoomData = {
    meta: {
      id: 'room-0123456789abcdef',
      visibility: 'private',
      hostId: 'a-host',
      hostName: 'host',
      title: 'Matrix',
      poster: 'https://image.example/affiche.jpg',
      language: 'fr',
      media: movie,
      fingerprint: null,
      maxParticipants: options.max ?? 20,
      createdAt: T0,
    },
    state: { playing: false, pos: 0, at: T0, rev: 0 },
    muted: [],
    banned: [],
    hostAbsentSince: null,
    emptySince: null,
  };
  const core = new RoomCore(data, [], [], () => clock.now);
  let n = 0;
  const account = (id: string): Member => ({ accountId: id, username: id.replace(/^a-/, ''), avatarColor: '#3b82f6', connId: `c${n++}`, joinedAt: clock.now });
  const guest = (gid: string, name: string): Member => ({ ...guestIdentity(gid, name), connId: `c${n++}`, joinedAt: clock.now });
  return { core, clock, data, account, guest };
}

type Fixture = ReturnType<typeof makeRoom>;

const msg = (value: unknown) => {
  const parsed = parseClientMessage(JSON.stringify(value));
  if (parsed === undefined) throw new Error('message invalide');
  return parsed;
};
const sent = (effects: Effect[], to: string): ServerMessage[] => effects.flatMap((e) => (e.kind === 'send' && e.to === to ? [e.msg] : []));
const broadcasts = (effects: Effect[]): ServerMessage[] => effects.flatMap((e) => (e.kind === 'broadcast' ? [e.msg] : []));
const errors = (effects: Effect[]): string[] => effects.flatMap((e) => (e.kind === 'send' && e.msg.t === 'error' ? [e.msg.code] : []));

/** Un hôte (compte) et des membres joints. */
function withHost(fx: Fixture) {
  const host = fx.account('a-host');
  fx.core.join(host);
  return host;
}

describe('invités dans le salon', () => {
  it('au plus 4 invités connectés : le 5e est refusé, un invité déjà connecté se reconnecte, un départ libère une place', () => {
    const fx = makeRoom();
    withHost(fx);
    const guests = ['g1', 'g2', 'g3', 'g4'].map((id, i) => fx.guest(id.padEnd(16, 'x'), `Invité${i + 1}`));
    for (const g of guests) {
      expect(fx.core.canJoinGuest(g)).toBe('ok');
      fx.core.join(g);
    }
    expect(MAX_GUESTS).toBe(4);
    expect(fx.core.guestCount()).toBe(4);
    const fifth = guestIdentity('g5xxxxxxxxxxxxxxx', 'Cinq');
    expect(fx.core.canJoinGuest(fifth)).toBe('guest_limit');
    // Un compte n'est pas concerné par la limite d'invités.
    expect(fx.core.canJoin('a-bob')).toBe('ok');
    // Un invité déjà connecté (même jeton) se reconnecte sans compter comme nouvel invité.
    expect(fx.core.canJoinGuest(guests[0] as Member)).toBe('ok');
    // Un départ libère une place.
    fx.core.leave(guests[0]?.accountId ?? '', guests[0]?.connId ?? '');
    expect(fx.core.canJoinGuest(fifth)).toBe('ok');
  });

  it('la limite de participants vaut aussi pour un invité ; un salon plein refuse l’invité nouveau', () => {
    const fx = makeRoom({ max: 2 });
    withHost(fx);
    fx.core.join(fx.account('a-bob'));
    expect(fx.core.canJoinGuest(guestIdentity('gxxxxxxxxxxxxxxxxx', 'Léa'))).toBe('room_full');
  });

  it('pseudo déjà pris (casse ignorée) refusé ; le même invité peut garder son pseudo', () => {
    const fx = makeRoom();
    withHost(fx);
    expect(fx.core.canJoinGuest(guestIdentity('gxxxxxxxxxxxxxxxxx', 'HOST'))).toBe('name_taken');
    const léa = fx.guest('lxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(léa);
    expect(fx.core.canJoinGuest(guestIdentity('zxxxxxxxxxxxxxxxxx', 'léa'))).toBe('name_taken');
    expect(fx.core.canJoinGuest(guestIdentity('lxxxxxxxxxxxxxxxxx', 'Léa'))).toBe('ok');
  });

  it('invité exclu : refusé à la reconnexion', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    expect(broadcasts(fx.core.handle(host.accountId, msg({ t: 'kick', user: 'Léa' })))).toContainEqual({ t: 'leave', user: 'Léa' });
    expect(fx.core.canJoinGuest(guestIdentity('gxxxxxxxxxxxxxxxxx', 'Léa'))).toBe('banned');
  });

  it('bienvenue et participants : peerId partout, drapeau guest seulement pour les invités, aucun identifiant de compte', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa');
    const effects = fx.core.join(guest);
    const welcome = sent(effects, guest.accountId)[0];
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.you).toEqual({ username: 'Léa', host: false, muted: false, peerId: guest.connId });
    const byName = Object.fromEntries(welcome.participants.map((p) => [p.username, p]));
    expect(byName.host).toMatchObject({ host: true, peerId: host.connId });
    expect(byName.host).not.toHaveProperty('guest');
    expect(byName.Léa).toMatchObject({ guest: true, peerId: guest.connId, avatarColor: GUEST_COLOR });
    const serialized = JSON.stringify([welcome, broadcasts(effects)]);
    expect(serialized).not.toContain(GUEST_KEY_PREFIX);
    expect(serialized).not.toContain('a-host');
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(broadcasts(effects)).toEqual([{ t: 'join', participant: expect.objectContaining({ username: 'Léa', guest: true, peerId: guest.connId }) }]);
    // L'affiche (URL) n'est pas envoyée à l'invité, mais reste visible pour un compte.
    expect(welcome.room.poster).toBeNull();
    const bob = fx.account('a-bob');
    const bobWelcome = sent(fx.core.join(bob), bob.accountId)[0];
    if (bobWelcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(bobWelcome.room.poster).toBe('https://image.example/affiche.jpg');
  });

  it('lecture partagée : play, pause et seek d’un invité diffusés comme ceux des autres ; rapport de position réservé à l’hôte', () => {
    const fx = makeRoom();
    withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    expect(broadcasts(fx.core.handle(guest.accountId, msg({ t: 'ctl', action: 'play', pos: 5 })))).toEqual([
      { t: 'state', state: { playing: true, pos: 5, at: T0, rev: 1 }, serverTime: T0, by: 'Léa' },
    ]);
    expect(broadcasts(fx.core.handle(guest.accountId, msg({ t: 'ctl', action: 'seek', pos: 90 }))).length).toBe(1);
    expect(broadcasts(fx.core.handle(guest.accountId, msg({ t: 'ctl', action: 'pause', pos: 91 }))).length).toBe(1);
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'ctl', action: 'sync', pos: 1 })))).toEqual(['not_host']);
  });

  it('un invité ne modère pas, ne termine pas et ne devient jamais hôte', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    fx.core.join(fx.account('a-bob'));
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'kick', user: 'bob' })))).toEqual(['not_host']);
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'mute', user: 'bob', muted: true })))).toEqual(['not_host']);
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'transfer', user: 'bob' })))).toEqual(['not_host']);
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'end' })))).toEqual(['not_host']);
    // L'hôte ne peut pas non plus céder la place à un invité.
    expect(errors(fx.core.handle(host.accountId, msg({ t: 'transfer', user: 'Léa' })))).toEqual(['guest_cannot_host']);
    expect(fx.core.hostId).toBe('a-host');
  });

  it('hôte absent : la promotion choisit un compte, jamais un invité, même arrivé plus tôt', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    fx.clock.now += 1000;
    fx.core.join(fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa'));
    fx.clock.now += 1000;
    fx.core.join(fx.account('a-bob'));
    fx.core.leave(host.accountId, host.connId);
    fx.clock.now += HOST_GRACE_MS;
    expect(broadcasts(fx.core.tick().effects)).toEqual([{ t: 'host', user: 'bob' }]);
    expect(fx.core.hostId).toBe('a-bob');
  });

  it('hôte absent et seuls des invités présents : pas de promotion', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    fx.core.join(fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa'));
    fx.core.leave(host.accountId, host.connId);
    fx.clock.now += HOST_GRACE_MS;
    expect(fx.core.tick().effects).toEqual([]);
    expect(fx.core.hostId).toBe('a-host');
  });

  it('pseudo identique à celui d’un compte : la désignation par pseudo vise le compte', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    // L'invité entre avant le compte « bob » (aucun conflit pour un compte) ; la modération par pseudo vise le compte.
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'bob');
    fx.core.join(guest);
    fx.core.join(fx.account('a-bob'));
    const effects = fx.core.handle(host.accountId, msg({ t: 'kick', user: 'bob' }));
    expect(effects).toContainEqual({ kind: 'close', to: 'a-bob', code: CLOSE.kicked, reason: 'kicked' });
    expect(effects.some((e) => e.kind === 'close' && e.to === guest.accountId)).toBe(false);
  });
});

describe('signalisation WebRTC : relais ciblé', () => {
  it('relayé au seul pair visé, avec l’identifiant de l’émetteur ; jamais diffusé', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxxx', 'Léa');
    const bob = fx.account('a-bob');
    fx.core.join(guest);
    fx.core.join(bob);
    const offer = { sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1', kind: 'offer' };
    const effects = fx.core.handle(guest.accountId, msg({ type: 'rtc', to: host.connId, data: offer }));
    expect(effects).toEqual([{ kind: 'peer', peerId: host.connId, msg: { type: 'rtc', from: guest.connId, data: offer } }]);
    // Le message relayé, une fois sérialisé, a exactement la forme attendue par le client.
    const relayed = effects[0];
    if (relayed?.kind !== 'peer') throw new Error('relais attendu');
    expect(JSON.parse(JSON.stringify(relayed.msg))).toEqual({ type: 'rtc', from: guest.connId, data: offer });
    // Compte vers invité, dans l'autre sens.
    expect(fx.core.handle(bob.accountId, msg({ type: 'rtc', to: guest.connId, data: { candidate: 'c' } }))).toEqual([
      { kind: 'peer', peerId: guest.connId, msg: { type: 'rtc', from: bob.connId, data: { candidate: 'c' } } },
    ]);
  });

  it('refus : pair inconnu, soi-même, donnée trop grosse ; expéditeur hors salon ignoré', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    expect(errors(fx.core.handle(guest.accountId, msg({ type: 'rtc', to: 'inconnu-0123456789', data: {} })))).toEqual(['peer_not_found']);
    expect(errors(fx.core.handle(guest.accountId, msg({ type: 'rtc', to: guest.connId, data: {} })))).toEqual(['cannot_target_self']);
    const big = { blob: 'x'.repeat(RTC_MAX_DATA_BYTES) };
    const huge = fx.core.handle(guest.accountId, msg({ type: 'rtc', to: host.connId, data: big }));
    expect(errors(huge)).toEqual(['rtc_too_large']);
    expect(huge.some((e) => e.kind === 'peer')).toBe(false);
    expect(fx.core.handle('a-fantome', msg({ type: 'rtc', to: host.connId, data: {} }))).toEqual([]);
  });

  it('débit : 60 messages par 10 s par participant, puis refus', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    const frame = msg({ type: 'rtc', to: host.connId, data: { n: 1 } });
    for (let i = 0; i < 60; i += 1) expect(fx.core.handle(guest.accountId, frame).some((e) => e.kind === 'peer')).toBe(true);
    expect(errors(fx.core.handle(guest.accountId, frame))).toEqual(['rate_limited']);
  });

  it('analyse : forme filaire stricte, données objet ≤ 16 Ko mesurées en octets, trame ≤ 64 Kio', () => {
    expect(parseClientMessage('{"type":"rtc","to":"c1","data":{"sdp":"x"}}')).toEqual({ t: 'rtc', to: 'c1', data: { sdp: 'x' }, bytes: 11 });
    const bad = [
      '{"type":"rtc","to":"","data":{}}',
      '{"type":"rtc","to":"avec espace","data":{}}',
      `{"type":"rtc","to":"${'c'.repeat(65)}","data":{}}`,
      '{"type":"rtc","to":42,"data":{}}',
      '{"type":"rtc","to":"c1"}',
      '{"type":"rtc","to":"c1","data":"chaîne"}',
      '{"type":"rtc","to":"c1","data":[1,2]}',
      '{"type":"rtc","to":"c1","data":null}',
      `{"type":"rtc","to":"c1","data":{"blob":"${'x'.repeat(RTC_MAX_FRAME_CHARS)}"}}`,
    ];
    for (const text of bad) expect(parseClientMessage(text), text.slice(0, 60)).toBeUndefined();
    // Une donnée de 5 Ko (au-delà de la limite hors signalisation) passe l'analyse ; la limite de 16 Ko est appliquée par le salon.
    const medium = parseClientMessage(JSON.stringify({ type: 'rtc', to: 'c1', data: { blob: 'x'.repeat(5000) } }));
    expect(medium?.t === 'rtc' && medium.bytes > MAX_FRAME_BYTES).toBe(true);
    // Hors signalisation, la limite de 4 Ko reste.
    expect(parseClientMessage(JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_FRAME_BYTES) }))).toBeUndefined();
  });
});

describe('connexion d’invité : rejoindre et réponses', () => {
  it('un invité qui envoie un message d’hôte reçoit not_host ; un message de signalisation vers un compte fonctionne', () => {
    const fx = makeRoom();
    withHost(fx);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    expect(errors(fx.core.handle(guest.accountId, msg({ t: 'episode', season: 1, episode: 2, fingerprint: null })))).toEqual(['not_host']);
    expect(sent(fx.core.handle(guest.accountId, msg({ t: 'ping', c: 9 })), guest.accountId)).toEqual([{ t: 'pong', c: 9, s: T0 }]);
  });
});

const version = { fileName: 'Matrix.2026.mkv', size: 4_200_000_000, hash: 'abc123def456' };
const roomOf = (msg: ServerMessage | undefined): { fingerprint?: unknown } | undefined => (msg?.t === 'welcome' ? msg.room : undefined);

describe('invité : empreinte de version expurgée', () => {
  it('welcome : l’hôte reçoit l’empreinte, l’invité jamais (ni nom de fichier, taille ni hash)', () => {
    const fx = makeRoom();
    fx.data.meta.fingerprint = version;
    const host = fx.account('a-host');
    const hostWelcome = sent(fx.core.join(host), host.accountId).find((m) => m.t === 'welcome');
    expect(roomOf(hostWelcome)?.fingerprint).toEqual(version);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa');
    const guestWelcome = sent(fx.core.join(guest), guest.accountId).find((m) => m.t === 'welcome');
    expect(roomOf(guestWelcome)?.fingerprint).toBeNull();
    expect(JSON.stringify(guestWelcome)).not.toContain('Matrix.2026');
  });

  it('media (épisode) : chaque participant reçoit sa version du message ; l’invité n’a pas l’empreinte', () => {
    const fx = makeRoom();
    fx.data.meta.media = { type: 'series', tmdbId: 1399, imdbId: null, season: 1, episode: 1 };
    const host = fx.account('a-host');
    fx.core.join(host);
    const guest = fx.guest('gxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(guest);
    const effects = fx.core.handle(host.accountId, msg({ t: 'episode', season: 1, episode: 2, fingerprint: version }));
    const mediaFor = (to: string) => sent(effects, to).filter((m) => m.t === 'media');
    expect(mediaFor(host.accountId)).toHaveLength(1);
    expect(JSON.stringify(mediaFor(host.accountId))).toContain('Matrix.2026');
    expect(mediaFor(guest.accountId)).toHaveLength(1);
    expect(JSON.stringify(mediaFor(guest.accountId))).not.toContain('Matrix.2026');
    expect(JSON.stringify(mediaFor(guest.accountId))).not.toContain('abc123def456');
    // Aucune diffusion à tous : elle contournerait l'expurgation.
    expect(broadcasts(effects).filter((m) => m.t === 'media')).toEqual([]);
  });
});

describe('invité : reconnexion et motifs de refus', () => {
  it('même jeton : même pseudo seulement, connecté ou après déconnexion', () => {
    const fx = makeRoom();
    withHost(fx);
    const lea = fx.guest('lxxxxxxxxxxxxxxxxx', 'Léa');
    fx.core.join(lea);
    expect(fx.core.canJoinGuest(guestIdentity('lxxxxxxxxxxxxxxxxx', 'Autre'))).toBe('name_changed');
    fx.core.leave(lea.accountId, lea.connId);
    expect(fx.core.canJoinGuest(guestIdentity('lxxxxxxxxxxxxxxxxx', 'Autre'))).toBe('name_changed');
    expect(fx.core.canJoinGuest(guestIdentity('lxxxxxxxxxxxxxxxxx', 'Léa'))).toBe('ok');
  });

  it('chaque motif de refus a son code de fermeture 4xxx ; admis : aucun code', () => {
    expect(CLOSE.expired).toBe(4001);
    expect(CLOSE.banned).toBe(4004);
    expect(CLOSE.nameTaken).toBe(4011);
    expect(CLOSE.nameChanged).toBe(4012);
    expect(guestRefusal('banned')).toEqual({ code: 4004, reason: 'banned' });
    expect(guestRefusal('room_full')).toMatchObject({ code: CLOSE.full });
    expect(guestRefusal('guest_limit')).toMatchObject({ code: CLOSE.full });
    expect(guestRefusal('name_taken')).toEqual({ code: 4011, reason: 'name_taken' });
    expect(guestRefusal('name_changed')).toEqual({ code: 4012, reason: 'name_changed' });
    expect(guestRefusal('ok')).toBeUndefined();
  });
});

describe('invitation : émission réservée à l’hôte, débit et places', () => {
  it('seul l’hôte connecté émet ; un autre membre ou un inconnu reçoit forbidden', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    const bob = fx.account('a-bob');
    fx.core.join(bob);
    expect(fx.core.inviteVerdict(bob.accountId)).toBe('forbidden');
    expect(fx.core.inviteVerdict('a-inconnu')).toBe('forbidden');
    expect(fx.core.inviteVerdict(host.accountId)).toBe('ok');
  });

  it('refusé quand quatre invités sont déjà connectés', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    ['g1', 'g2', 'g3', 'g4'].forEach((id, i) => fx.core.join(fx.guest(id.padEnd(16, 'x'), `Invité${i + 1}`)));
    expect(fx.core.inviteVerdict(host.accountId)).toBe('guests_full');
  });

  it('dix jetons par dix minutes et par salon, puis à nouveau après la fenêtre', () => {
    const fx = makeRoom();
    const host = withHost(fx);
    for (let i = 0; i < 10; i += 1) expect(fx.core.inviteVerdict(host.accountId)).toBe('ok');
    expect(fx.core.inviteVerdict(host.accountId)).toBe('rate_limited');
    fx.clock.now += 10 * 60_000;
    expect(fx.core.inviteVerdict(host.accountId)).toBe('ok');
  });
});
