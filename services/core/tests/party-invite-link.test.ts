/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PartyBackend } from '../src/party/backend.js';
import { canonicalName } from '../src/party/names.js';
import { cleanGuestName, guestIdentity, signGuestToken, signRoomInviteToken, verifyGuestToken, verifyRoomInviteToken } from '../src/party/guest.js';
import { RESERVATION_MS, GUEST_NAME_MAX, GUEST_SESSION_MS, MAX_GUESTS, parseClientMessage, ROOM_MAX_AGE_MS, type RoomData } from '../src/party/protocol.js';
import { type Member, RoomCore } from '../src/party/room-core.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, type Member as Account } from './social-harness.js';
import { request } from './user-harness.js';

const SECRET = 'guest-test-secret-with-more-than-32-chars';
const OTHER = 'autre-secret-de-test-avec-plus-de-32-car';
const ROOM = 'room-0123456789abcdef';
const T0 = 1_800_000_000_000;
const EXP = T0 + ROOM_MAX_AGE_MS;

describe('jeton du lien partagé', () => {
  it('multi-usage et déterministe : aucun pseudo, aucun invité, seulement salon, génération et échéance', async () => {
    const a = await signRoomInviteToken(ROOM, 0, EXP, SECRET);
    const b = await signRoomInviteToken(ROOM, 0, EXP, SECRET);
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(Buffer.from(a.split('.')[0] ?? '', 'base64url').toString('utf8')))).toEqual(['purpose', 'roomId', 'epoch', 'exp']);
    expect(await verifyRoomInviteToken(a, ROOM, T0, SECRET)).toEqual({ epoch: 0, exp: EXP });
    expect(await verifyRoomInviteToken(a, ROOM, T0 + 5000, SECRET)).toEqual({ epoch: 0, exp: EXP });
  });

  it('expire, refusé pour un autre salon, un autre secret ou une signature altérée', async () => {
    const token = await signRoomInviteToken(ROOM, 3, EXP, SECRET);
    expect(await verifyRoomInviteToken(token, ROOM, EXP - 1, SECRET)).toBeDefined();
    expect(await verifyRoomInviteToken(token, ROOM, EXP, SECRET)).toBeUndefined();
    expect(await verifyRoomInviteToken(token, 'autre-salon-0123456789', T0, SECRET)).toBeUndefined();
    expect(await verifyRoomInviteToken(token, ROOM, T0, OTHER)).toBeUndefined();
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), epoch: 4 }), 'utf8').toString('base64url');
    expect(await verifyRoomInviteToken(`${forged}.${sig}`, ROOM, T0, SECRET)).toBeUndefined();
    for (const bad of ['', 'a.b.c', '.x', `${body}.`, `${body}.!!`, 'x'.repeat(2000)]) expect(await verifyRoomInviteToken(bad, ROOM, T0, SECRET)).toBeUndefined();
  });

  it('domaines séparés : un jeton de lien n’est pas un jeton d’invité (WebSocket), et réciproquement', async () => {
    const link = await signRoomInviteToken(ROOM, 0, EXP, SECRET);
    expect(await verifyGuestToken(link, ROOM, T0, SECRET)).toBeUndefined();
    const guest = await signGuestToken(ROOM, T0, SECRET);
    expect(await verifyRoomInviteToken(guest.token, ROOM, T0, SECRET)).toBeUndefined();
  });

  it('jeton de séance : identifiant et échéance imposés, vérifié comme un jeton d’invité', async () => {
    const gid = 'abcdefghijklmnopqrst';
    const session = await signGuestToken(ROOM, T0, SECRET, { gid, exp: T0 + 1000 });
    expect(await verifyGuestToken(session.token, ROOM, T0, SECRET)).toEqual({ guestId: gid });
    expect(await verifyGuestToken(session.token, ROOM, T0 + 1000, SECRET)).toBeUndefined();
  });
});

const movie = { type: 'movie' as const, tmdbId: 603, imdbId: null, season: null, episode: null };

function makeRoom(max = 20) {
  const clock = { now: T0 };
  const data: RoomData = {
    meta: { id: ROOM, visibility: 'private', hostId: 'a-host', hostName: 'host', title: 'Matrix', poster: null, language: 'fr', media: movie, fingerprint: null, maxParticipants: max, createdAt: T0 },
    state: { playing: false, pos: 0, at: T0, rev: 0 },
    muted: [],
    banned: [],
    hostAbsentSince: null,
    emptySince: null,
  };
  const core = new RoomCore(data, [], [], () => clock.now);
  let n = 0;
  core.join({ accountId: 'a-host', username: 'host', avatarColor: '#3b82f6', connId: `c${n++}`, joinedAt: T0 });
  /** Entre par le lien partagé ; `connect` se connecte ensuite avec l'identifiant et le pseudo attribués. */
  const enter = (name: string, epoch = 0) => {
    const gid = `gid${n++}`.padEnd(20, 'x');
    const verdict = core.enterGuest(gid, name, epoch);
    const connect = (): Member | undefined => {
      if (!verdict.ok) return undefined;
      const identity = guestIdentity(gid, verdict.name);
      if (core.canJoinGuest(identity) !== 'ok') return undefined;
      const member: Member = { ...identity, connId: `c${n++}`, joinedAt: clock.now };
      core.join(member);
      return member;
    };
    return { gid, verdict, connect };
  };
  return { core, clock, data, enter };
}

describe('pseudos : forme canonique', () => {
  it('casse, diacritiques, pleine chasse et lettres confondables grec/cyrillique se replient sur le latin', () => {
    const same = ['Léa', 'LEA', 'léa', 'Lea', 'Ｌｅａ', 'Léa', 'Lеа'];
    for (const name of same) expect(canonicalName(name)).toBe('lea');
    expect(canonicalName('Hоst')).toBe('host'); // « о » cyrillique
    expect(canonicalName('Straße')).toBe('strasse');
    expect(canonicalName('  A   b ')).toBe('a b');
    expect(canonicalName('Léa')).not.toBe(canonicalName('Léo'));
  });

  it('NFC à l’enregistrement', () => {
    expect(cleanGuestName('Léa')).toBe('Léa');
  });

  it('un sosie de l’hôte ou d’un compte présent est refusé ; face à un invité, suffixe sur la forme canonique', () => {
    const fx = makeRoom();
    for (const wanted of ['host', 'HOST', 'Hоst', 'Ｈost', 'Hóst']) expect(fx.enter(wanted).verdict).toEqual({ ok: false, reason: 'name_taken' });
    fx.core.join({ accountId: 'a-bob', username: 'Bob', avatarColor: '#000000', connId: 'bob', joinedAt: T0 });
    expect(fx.enter('Воb').verdict).toEqual({ ok: false, reason: 'name_taken' }); // cyrillique В, о
    expect(fx.enter('Léa').verdict).toMatchObject({ name: 'Léa' });
    expect(fx.enter('Lеа').verdict).toMatchObject({ name: 'Lеа 2' });
    // WebSocket : un ancien jeton ne passe pas non plus avec un sosie.
    expect(fx.core.canJoinGuest(guestIdentity('legacyidlegacyid0', 'Hоst'))).toBe('name_taken');
    expect(fx.core.canJoinGuest(guestIdentity('legacyidlegacyid1', 'BOB'))).toBe('name_taken');
  });
});

describe('réservations des jetons de séance', () => {
  it('un jeton obtenu mais jamais connecté compte dans le plafond d’invités pendant 2 min, puis libère place et pseudo', () => {
    const fx = makeRoom();
    for (let i = 0; i < MAX_GUESTS; i += 1) expect(fx.enter(`g${i}`).verdict.ok).toBe(true);
    expect(fx.enter('de-trop').verdict).toEqual({ ok: false, reason: 'guest_limit' });
    // Un jeton réservé qui se connecte ne compte qu'une fois.
    const first = fx.core.data.guestNames as Record<string, string>;
    expect(Object.values(first)).toContain('g0');
    fx.clock.now += RESERVATION_MS - 1;
    expect(fx.enter('encore').verdict).toEqual({ ok: false, reason: 'guest_limit' });
    fx.clock.now += 1;
    // Réservations expirées : le pseudo « g0 » est libre à nouveau et la place aussi.
    expect(fx.enter('g0').verdict).toMatchObject({ ok: true, name: 'g0' });
    expect(Object.keys(fx.core.data.guestReserved ?? {})).toHaveLength(1);
  });

  it('salon plein : les réservations comptent dans les participants maximum', () => {
    const fx = makeRoom(3);
    expect(fx.enter('A').verdict.ok).toBe(true);
    expect(fx.enter('B').verdict.ok).toBe(true);
    expect(fx.enter('C').verdict).toEqual({ ok: false, reason: 'room_full' });
  });

  it('un invité réservé se connecte sans être bloqué par sa propre réservation ; la réservation disparaît', () => {
    const fx = makeRoom();
    for (let i = 0; i < MAX_GUESTS - 1; i += 1) fx.enter(`g${i}`);
    const last = fx.enter('dernier');
    expect(last.connect()).toBeDefined();
    expect(fx.core.data.guestReserved?.[`guest:${last.gid}`]).toBeUndefined();
  });

  it('tick libère les réservations expirées ; guestNames n’évince jamais un invité connecté', () => {
    const fx = makeRoom();
    fx.enter('Fantôme');
    fx.clock.now += RESERVATION_MS;
    fx.core.tick();
    expect(Object.values(fx.core.data.guestNames ?? {})).not.toContain('Fantôme');
    // Plus de GUEST_NAMES_MAX pseudos anciens : le plus ancien connecté reste.
    const connected = fx.enter('Premier');
    const premier = connected.connect() as Member;
    const names = { ...(fx.core.data.guestNames ?? {}) };
    for (let i = 0; i < 250; i += 1) names[`guest:old${i}`.padEnd(30, 'x')] = `ancien${i}`;
    fx.core.data.guestNames = names;
    const other = fx.enter('Nouveau');
    expect(other.verdict.ok).toBe(true);
    const kept = fx.core.data.guestNames ?? {};
    expect(Object.keys(kept).length).toBeLessThanOrEqual(200);
    expect(kept[premier.accountId]).toBe('Premier');
  });
});

describe('salon : entrée par le lien partagé', () => {
  it('deux invités avec le même lien : chacun son identifiant et son pseudo', () => {
    const fx = makeRoom();
    const a = fx.enter('Léa');
    const b = fx.enter('Tom');
    expect(a.verdict).toMatchObject({ ok: true, name: 'Léa' });
    expect(b.verdict).toMatchObject({ ok: true, name: 'Tom' });
    expect(a.connect()).toBeDefined();
    expect(b.connect()).toBeDefined();
    expect(fx.core.guestCount()).toBe(2);
    expect(a.gid).not.toBe(b.gid);
  });

  it('pseudo déjà pris (hôte, invité connecté ou seulement entré) : suffixe automatique, 24 caractères au plus', () => {
    const fx = makeRoom();
    const names: string[] = [];
    for (const wanted of ['Léa', 'LÉA', 'léa', 'x'.repeat(GUEST_NAME_MAX)]) {
      const entry = fx.enter(wanted);
      expect(entry.verdict.ok).toBe(true);
      if (entry.verdict.ok) names.push(entry.verdict.name);
    }
    expect(names.slice(0, 3)).toEqual(['Léa', 'LÉA 2', 'léa 3']);
    expect(names[3]).toBe('x'.repeat(GUEST_NAME_MAX));
    expect(makeRoom().enter('x'.repeat(GUEST_NAME_MAX)).verdict).toMatchObject({ name: 'x'.repeat(GUEST_NAME_MAX) });
    const twin = makeRoom();
    twin.enter('x'.repeat(GUEST_NAME_MAX));
    expect(twin.enter('x'.repeat(GUEST_NAME_MAX)).verdict).toMatchObject({ name: `${'x'.repeat(GUEST_NAME_MAX - 2)} 2` });
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    for (const name of names) expect(cleanGuestName(name)).toBe(name);
  });

  it('révocation : « Nouveau lien » invalide l’ancien, le nouveau fonctionne, les invités déjà entrés restent', () => {
    const fx = makeRoom();
    expect(fx.core.inviteLink('a-host', false)).toEqual({ ok: true, epoch: 0, exp: EXP });
    expect(fx.core.inviteLink('a-host', false)).toEqual({ ok: true, epoch: 0, exp: EXP });
    const inside = fx.enter('Léa');
    const member = inside.connect() as Member;
    expect(member).toBeDefined();
    expect(fx.core.inviteLink('a-host', true)).toEqual({ ok: true, epoch: 1, exp: EXP });
    expect(fx.core.dirty.has('room')).toBe(true);
    expect(fx.enter('Tom', 0).verdict).toEqual({ ok: false, reason: 'link_revoked' });
    expect(fx.enter('Tom', 1).verdict).toMatchObject({ ok: true, name: 'Tom' });
    // L'invité déjà entré se reconnecte avec son jeton de séance (même identifiant, même pseudo).
    fx.core.leave(member.accountId, member.connId);
    expect(fx.core.canJoinGuest(guestIdentity(inside.gid, 'Léa'))).toBe('ok');
  });

  it('seul l’hôte connecté obtient ou renouvelle le lien ; rotations limitées', () => {
    const fx = makeRoom();
    const guest = fx.enter('Léa');
    guest.connect();
    expect(fx.core.inviteLink(`guest:${guest.gid}`, false)).toEqual({ ok: false, reason: 'forbidden' });
    expect(fx.core.inviteLink('a-autre', true)).toEqual({ ok: false, reason: 'forbidden' });
    for (let i = 0; i < 10; i += 1) expect(fx.core.inviteLink('a-host', true).ok).toBe(true);
    expect(fx.core.inviteLink('a-host', true)).toEqual({ ok: false, reason: 'rate_limited' });
    expect(fx.core.inviteLink('a-host', false).ok).toBe(true);
  });

  it('expiration : le lien et les jetons de séance expirent au plus tard avec le salon (12 h, jamais plus de 24 h)', () => {
    const fx = makeRoom();
    expect(fx.core.linkExpiry()).toBe(T0 + ROOM_MAX_AGE_MS);
    expect(ROOM_MAX_AGE_MS).toBeLessThanOrEqual(24 * 3600_000);
    expect(GUEST_SESSION_MS).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('plafond : participants maximum du salon, au plus MAX_GUESTS invités, débit des entrées', () => {
    const small = makeRoom(2);
    small.enter('A').connect();
    expect(small.enter('B').verdict).toEqual({ ok: false, reason: 'room_full' });

    const fx = makeRoom();
    for (let i = 0; i < MAX_GUESTS; i += 1) expect(fx.enter(`g${i}`).connect()).toBeDefined();
    expect(fx.enter('de-trop').verdict).toEqual({ ok: false, reason: 'guest_limit' });

    const rate = makeRoom();
    for (let i = 0; i < 30; i += 1) {
      const member = rate.enter(`p${i}`).connect() as Member;
      expect(member).toBeDefined();
      rate.core.leave(member.accountId, member.connId);
    }
    expect(rate.enter('p-30').verdict).toEqual({ ok: false, reason: 'rate_limited' });
    // Le compteur est conservé avec l'état du salon (il survit à l'éviction du Durable Object).
    expect(rate.data.entryHits).toHaveLength(30);
    rate.clock.now += 10 * 60_000;
    expect(rate.enter('p-31').verdict.ok).toBe(true);
  });

  it('kick d’un invité du lien partagé : lien renouvelé, pseudo canonique banni, invités connectés conservés', () => {
    const fx = makeRoom();
    const friend = fx.enter('Léa');
    const friendMember = friend.connect() as Member;
    const bad = fx.enter('Troll');
    bad.connect();
    const effects = fx.core.handle('a-host', parseClientMessage(JSON.stringify({ t: 'kick', user: 'Troll' })) as never);
    expect(effects.some((e) => e.kind === 'close' && e.code === 4003)).toBe(true);
    // L'hôte est prévenu : il doit demander la nouvelle valeur du lien.
    expect(effects).toContainEqual({ kind: 'send', to: 'a-host', msg: { t: 'link_renewed' } });
    // Jeton de séance de l'exclu : refusé ; ancien lien : mort ; nouveau lien : le pseudo (et ses sosies) est banni.
    expect(fx.core.canJoinGuest(guestIdentity(bad.gid, 'Troll'))).toBe('banned');
    expect(fx.enter('Autre', 0).verdict).toEqual({ ok: false, reason: 'link_revoked' });
    const link = fx.core.inviteLink('a-host', false);
    expect(link).toMatchObject({ ok: true, epoch: 1 });
    for (const wanted of ['Troll', 'TROLL', 'Trоll', 'Ｔroll']) expect(fx.enter(wanted, 1).verdict).toEqual({ ok: false, reason: 'name_banned' });
    expect(fx.core.canJoinGuest(guestIdentity('legacyidlegacyid0', 'tróll'))).toBe('banned');
    // Un autre pseudo entre avec le nouveau lien ; l'invité déjà connecté se reconnecte avec son jeton de séance.
    expect(fx.enter('Tom', 1).verdict).toMatchObject({ ok: true, name: 'Tom' });
    fx.core.leave(friendMember.accountId, friendMember.connId);
    expect(fx.core.canJoinGuest(guestIdentity(friend.gid, 'Léa'))).toBe('ok');
  });

  it('kick d’un invité à ancien jeton (hors lien partagé) ou d’un compte : pas de renouvellement du lien', () => {
    const fx = makeRoom();
    const legacy = guestIdentity('legacyidlegacyid0', 'Vieux');
    fx.core.join({ ...legacy, connId: 'legacy', joinedAt: T0 });
    const effects = fx.core.handle('a-host', parseClientMessage(JSON.stringify({ t: 'kick', user: 'Vieux' })) as never);
    expect(effects.some((e) => e.kind === 'send' && e.msg.t === 'link_renewed')).toBe(false);
    expect(fx.core.inviteLink('a-host', false)).toMatchObject({ ok: true, epoch: 0 });
    expect(fx.core.canJoinGuest(guestIdentity('legacyidlegacyid0', 'Vieux'))).toBe('banned');
  });

  it('ancien jeton lié à un pseudo : reste valable à côté du lien partagé, et son pseudo est réservé', () => {
    const fx = makeRoom();
    const legacy = guestIdentity('legacyidlegacyid0', 'Vieux');
    expect(fx.core.canJoinGuest(legacy)).toBe('ok');
    fx.core.join({ ...legacy, connId: 'legacy', joinedAt: T0 });
    expect(fx.core.canJoinGuest(guestIdentity('legacyidlegacyid0', 'Autre'))).toBe('name_changed');
    expect(fx.enter('Vieux').verdict).toMatchObject({ ok: true, name: 'Vieux 2' });
  });

  it('jeton de séance lié au pseudo attribué : un autre pseudo avec le même jeton est refusé', () => {
    const fx = makeRoom();
    const entry = fx.enter('Léa');
    expect(fx.core.canJoinGuest(guestIdentity(entry.gid, 'Autre'))).toBe('name_changed');
    expect(fx.core.canJoinGuest(guestIdentity(entry.gid, 'Léa'))).toBe('ok');
  });
});

/** Salon réel (RoomCore) derrière l'API REST, sans WebSocket. */
function coreParty(cores: Map<string, RoomCore>): PartyBackend {
  return {
    room: (id) => {
      const get = () => cores.get(id);
      return {
        init: (meta) => {
          const data: RoomData = { meta, state: { playing: false, pos: 0, at: Date.now(), rev: 0 }, muted: [], banned: [], hostAbsentSince: null, emptySince: null };
          const core = new RoomCore(data, [], [], () => Date.now());
          core.join({ accountId: meta.hostId, username: meta.hostName, avatarColor: '#3b82f6', connId: 'host', joinedAt: Date.now() });
          cores.set(id, core);
          return Promise.resolve('ok');
        },
        info: () => Promise.resolve(get()?.info() ?? null),
        check: () => Promise.resolve('ok'),
        invite: (requester) => Promise.resolve(get()?.inviteVerdict(requester) ?? 'not_found'),
        inviteLink: (requester, rotate) => Promise.resolve(get()?.inviteLink(requester, rotate) ?? ({ ok: false, reason: 'not_found' } as const)),
        enterGuest: (gid, name, epoch) => Promise.resolve(get()?.enterGuest(gid, name, epoch) ?? ({ ok: false, reason: 'not_found' } as const)),
        close: () => Promise.resolve('ok'),
        reports: () => Promise.resolve('not_found'),
        deleteMessage: () => Promise.resolve('not_found'),
        fetch: () => Promise.resolve(new Response(null, { status: 426 })),
      };
    },
  };
}

describe('API REST : lien partagé et entrée des invités', () => {
  let app: RunningApp;
  let host: Account;
  const cores = new Map<string, RoomCore>();

  beforeEach(async () => {
    cores.clear();
    app = await startApp({ extra: { party: coreParty(cores) } });
    host = await bootstrapOwner(app);
  });
  afterEach(async () => {
    await app.close();
  });

  async function createRoom(): Promise<string> {
    const res = await request<{ room: { id: string } }>(app, 'POST', '/party', {
      token: host.token,
      body: { profileId: host.profile, title: 'Matrix', media: { type: 'movie', tmdbId: 603 } },
    });
    expect(res.status).toBe(201);
    return res.body.room.id;
  }
  const link = (id: string, rotate = false) => request<any>(app, 'POST', `/party/${id}/invite-link`, { token: host.token, body: { profileId: host.profile, rotate } });
  const enter = (id: string, token: string, name: string) => request<any>(app, 'POST', `/party/${id}/guest`, { body: { token, name } });

  it('lien stable, entrée sans compte de plusieurs invités, pseudos uniques, jetons de séance distincts', async () => {
    const id = await createRoom();
    const first = await link(id);
    expect(first.status).toBe(201);
    expect(Date.parse(first.body.expiresAt) - Date.now()).toBeGreaterThan(11 * 3600_000);
    expect((await link(id)).body.token).toBe(first.body.token);
    const a = await enter(id, first.body.token, 'Léa');
    const b = await enter(id, first.body.token, 'Léa');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect([a.body.name, b.body.name]).toEqual(['Léa', 'Léa 2']);
    expect(a.body.sessionToken).not.toBe(b.body.sessionToken);
    expect(a.body.sessionToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Date.parse(a.body.expiresAt)).toBeLessThanOrEqual(Date.now() + GUEST_SESSION_MS);
  });

  it('« Nouveau lien » : l’ancien lien est refusé (403 invite_revoked), le nouveau fonctionne', async () => {
    const id = await createRoom();
    const old = (await link(id)).body.token;
    const fresh = await link(id, true);
    expect(fresh.body.token).not.toBe(old);
    const refused = await enter(id, old, 'Léa');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('invite_revoked');
    expect((await enter(id, fresh.body.token, 'Léa')).status).toBe(201);
  });

  it('lien réservé à l’hôte connecté ; jeton falsifié ou d’un autre salon et pseudo vide refusés', async () => {
    const id = await createRoom();
    const other = await createRoom();
    expect((await request(app, 'POST', `/party/${id}/invite-link`, { body: { profileId: host.profile } })).status).toBe(401);
    const token = (await link(id)).body.token as string;
    expect((await enter(other, token, 'Léa')).body.error).toBe('invite_invalid');
    expect((await enter(id, `${token}x`, 'Léa')).body.error).toBe('invite_invalid');
    expect((await enter(id, 'n-importe-quoi', 'Léa')).status).toBe(403);
    expect((await enter(id, token, '   ')).status).toBe(400);
    expect((await link('inexistant0123456789')).status).toBe(404);
  });
});
