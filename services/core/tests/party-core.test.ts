import { describe, expect, it } from 'vitest';
import { filterChat } from '../src/party/filter.js';
import {
  CHAT_MAX_CHARS,
  CLOSE,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  parseClientMessage,
  parseFingerprint,
  type PlaybackState,
  type RoomData,
  ROOM_MAX_AGE_MS,
  type ServerMessage,
} from '../src/party/protocol.js';
import { type Effect, type Member, RoomCore } from '../src/party/room-core.js';
import { driftAction, estimateOffset, expectedPosition } from '../src/party/sync.js';
import { signTicket, verifyTicket } from '../src/party/ticket.js';

const SECRET = 'party-test-secret-with-more-than-32-chars';
const T0 = 1_800_000_000_000;

function makeRoom(options: { max?: number; type?: 'movie' | 'series' } = {}) {
  const clock = { now: T0 };
  const data: RoomData = {
    meta: {
      id: 'room-0123456789abcdef',
      visibility: 'private',
      hostId: 'a-host',
      hostName: 'host',
      title: 'Severance',
      poster: null,
      language: 'fr',
      media: { type: options.type ?? 'series', tmdbId: 95396, imdbId: null, season: 1, episode: 1 },
      fingerprint: { fileName: 'Severance.S01E01.1080p.mkv', size: 3_000_000_000, hash: null },
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
  const member = (id: string, name = id.replace(/^a-/, '')): Member => ({ accountId: id, username: name, avatarColor: '#3b82f6', connId: `c${n++}`, joinedAt: clock.now });
  return { core, clock, data, member };
}

type Fixture = ReturnType<typeof makeRoom>;

function sent(effects: Effect[], to?: string): ServerMessage[] {
  return effects.flatMap((e) => (e.kind === 'send' && (to === undefined || e.to === to) ? [e.msg] : []));
}
function broadcasts(effects: Effect[]): ServerMessage[] {
  return effects.flatMap((e) => (e.kind === 'broadcast' ? [e.msg] : []));
}
function errors(effects: Effect[]): string[] {
  return sent(effects).flatMap((m) => (m.t === 'error' ? [m.code] : []));
}

function joined(fx: Fixture, ...ids: string[]) {
  for (const id of ids) fx.core.join(fx.member(id));
}
const msg = (value: unknown) => {
  const parsed = parseClientMessage(JSON.stringify(value));
  if (parsed === undefined) throw new Error('message invalide');
  return parsed;
};

describe('synchronisation par horloge serveur', () => {
  const playing: PlaybackState = { playing: true, pos: 100, at: T0, rev: 1 };

  it('position attendue : avance avec l’horloge serveur tant que ça joue, fixe à l’arrêt', () => {
    expect(expectedPosition(playing, T0 + 2500)).toBeCloseTo(102.5);
    expect(expectedPosition({ ...playing, playing: false }, T0 + 60_000)).toBe(100);
    // Horloge légèrement en retard : jamais de position négative ni en arrière.
    expect(expectedPosition(playing, T0 - 500)).toBe(100);
  });

  it('estimation du décalage d’horloge à partir d’un ping / pong', () => {
    // Le client est en retard de 1 s sur le serveur ; aller-retour de 200 ms.
    expect(estimateOffset(10_000, 10_200, 11_100)).toBe(1000);
  });

  it('correction de dérive : ignore < 0,3 s, rattrape en vitesse jusqu’à 2 s, saute au-delà', () => {
    expect(driftAction(100.2, 100, true)).toEqual({ kind: 'none' });
    expect(driftAction(99.8, 100, true)).toEqual({ kind: 'none' });
    expect(driftAction(101, 100, true)).toEqual({ kind: 'rate', rate: 0.95 });
    expect(driftAction(99, 100, true)).toEqual({ kind: 'rate', rate: 1.05 });
    expect(driftAction(103, 100, true)).toEqual({ kind: 'seek', to: 100 });
    expect(driftAction(90, 100, true)).toEqual({ kind: 'seek', to: 100 });
    // À l'arrêt, on se cale directement.
    expect(driftAction(100.5, 100, false)).toEqual({ kind: 'seek', to: 100 });
  });

  it('un participant qui rejoint en cours de lecture calcule la bonne position', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 30 }));
    fx.clock.now += 12_000;
    const welcome = sent(fx.core.join(fx.member('a-bob')), 'a-bob').find((m) => m.t === 'welcome');
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.serverTime).toBe(T0 + 12_000);
    expect(expectedPosition(welcome.state, welcome.serverTime)).toBeCloseTo(42);
  });
});

describe('salon : rejoindre et contrôles', () => {
  it('bienvenue : état, participants, historique du chat, sans identifiant de compte', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'chat', text: 'bonjour' }));
    const effects = fx.core.join(fx.member('a-bob'));
    const welcome = sent(effects, 'a-bob')[0];
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.you).toEqual({ username: 'bob', host: false, muted: false });
    expect(welcome.room).toMatchObject({ title: 'Severance', host: 'host', maxParticipants: 20, media: { season: 1, episode: 1 } });
    expect(welcome.participants.map((p) => p.username)).toEqual(['host', 'bob']);
    expect(welcome.chat).toHaveLength(1);
    expect(JSON.stringify(welcome)).not.toContain('a-host');
    expect(broadcasts(effects)).toEqual([{ t: 'join', participant: expect.objectContaining({ username: 'bob' }) }]);
  });

  it('seul l’hôte contrôle lecture, pause, seek et changement d’épisode', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    for (const m of [
      { t: 'ctl', action: 'play', pos: 5 },
      { t: 'ctl', action: 'pause', pos: 5 },
      { t: 'ctl', action: 'seek', pos: 50 },
      { t: 'episode', season: 1, episode: 2 },
    ]) {
      expect(errors(fx.core.handle('a-bob', msg(m)))).toEqual(['not_host']);
    }
    expect(fx.data.state).toEqual({ playing: false, pos: 0, at: T0, rev: 0 });
    const played = fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 5 }));
    expect(broadcasts(played)).toEqual([{ t: 'state', state: { playing: true, pos: 5, at: T0, rev: 1 }, serverTime: T0, by: 'host' }]);
  });

  it('play / pause / seek mettent à jour l’état (seek garde l’état de lecture)', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 10 }));
    fx.clock.now += 1000;
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'seek', pos: 600 }));
    expect(fx.data.state).toEqual({ playing: true, pos: 600, at: T0 + 1000, rev: 2 });
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'pause', pos: 612 }));
    expect(fx.data.state).toMatchObject({ playing: false, pos: 612, rev: 3 });
    expect(fx.core.dirty.has('room')).toBe(true);
  });

  it('rapport de position de l’hôte : ne rediffuse que si l’écart dépasse la tolérance', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 10 }));
    fx.clock.now += 5000;
    expect(fx.core.handle('a-host', msg({ t: 'ctl', action: 'sync', pos: 15.3 }))).toEqual([]);
    expect(fx.data.state.rev).toBe(1);
    const corrected = fx.core.handle('a-host', msg({ t: 'ctl', action: 'sync', pos: 18 }));
    expect(broadcasts(corrected)).toHaveLength(1);
    expect(fx.data.state).toMatchObject({ pos: 18, rev: 2, playing: true });
  });

  it('changement d’épisode : met à jour le média, l’empreinte, remet la lecture à zéro, uniquement pour une série', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 900 }));
    const fp = { fileName: 'Severance.S01E02.mkv', size: 2_000_000_000 };
    const effects = fx.core.handle('a-host', msg({ t: 'episode', season: 1, episode: 2, fingerprint: fp }));
    expect(broadcasts(effects)[0]).toMatchObject({
      t: 'media',
      media: { season: 1, episode: 2, tmdbId: 95396 },
      fingerprint: { fileName: 'Severance.S01E02.mkv', size: 2_000_000_000, hash: null },
      state: { playing: false, pos: 0 },
    });
    const movie = makeRoom({ type: 'movie' });
    joined(movie, 'a-host');
    expect(errors(movie.core.handle('a-host', msg({ t: 'episode', season: 1, episode: 2 })))).toEqual(['not_series']);
  });

  it('limite de participants : plein, mais une reconnexion du même compte reste possible', () => {
    const fx = makeRoom({ max: 3 });
    joined(fx, 'a-host', 'a-bob', 'a-carol');
    expect(fx.core.canJoin('a-dave')).toBe('room_full');
    expect(fx.core.canJoin('a-bob')).toBe('ok');
    const second = fx.member('a-bob');
    fx.core.join(second);
    expect(fx.core.members.size).toBe(3);
    // L'ancienne connexion qui se ferme ne retire pas la nouvelle.
    expect(fx.core.leave('a-bob', 'ancienne-connexion')).toEqual([]);
    expect(fx.core.members.has('a-bob')).toBe(true);
    expect(broadcasts(fx.core.leave('a-bob', second.connId))).toEqual([{ t: 'leave', user: 'bob' }]);
    expect(fx.core.canJoin('a-dave')).toBe('ok');
  });

  it('ping : répond avec l’horloge serveur', () => {
    const fx = makeRoom();
    joined(fx, 'a-bob');
    expect(sent(fx.core.handle('a-bob', msg({ t: 'ping', c: 123 })))).toEqual([{ t: 'pong', c: 123, s: T0 }]);
  });
});

describe('modération', () => {
  it('l’hôte exclut : le participant est fermé (4003), retiré, et ne peut plus rejoindre', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    const effects = fx.core.handle('a-host', msg({ t: 'kick', user: 'bob' }));
    expect(effects).toContainEqual({ kind: 'close', to: 'a-bob', code: CLOSE.kicked, reason: 'kicked' });
    expect(broadcasts(effects)).toEqual([{ t: 'leave', user: 'bob' }]);
    expect(fx.core.members.has('a-bob')).toBe(false);
    expect(fx.core.canJoin('a-bob')).toBe('banned');
    expect(fx.data.banned).toEqual(['a-bob']);
  });

  it('seul l’hôte exclut, rend muet ou transfère ; jamais sur soi-même ; cible inconnue refusée', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob', 'a-carol');
    for (const t of ['kick', 'mute', 'transfer']) {
      expect(errors(fx.core.handle('a-bob', msg({ t, user: 'carol', muted: true })))).toEqual(['not_host']);
      expect(errors(fx.core.handle('a-host', msg({ t, user: 'host', muted: true })))).toEqual(['cannot_target_self']);
      expect(errors(fx.core.handle('a-host', msg({ t, user: 'fantome', muted: true })))).toEqual(['user_not_found']);
    }
    expect(fx.core.canJoin('a-carol')).toBe('ok');
  });

  it('muet : ne peut plus écrire ni réagir ; rétabli par l’hôte ; persiste à la reconnexion', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'mute', user: 'bob', muted: true })))).toEqual([{ t: 'muted', user: 'bob', muted: true }]);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'chat', text: 'salut' })))).toEqual(['muted']);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'react', emoji: '👍' })))).toEqual(['muted']);
    const again = sent(fx.core.join(fx.member('a-bob')), 'a-bob')[0];
    if (again?.t !== 'welcome') throw new Error('welcome attendu');
    expect(again.you.muted).toBe(true);
    fx.core.handle('a-host', msg({ t: 'mute', user: 'bob', muted: false }));
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'chat', text: 'salut' })))).toHaveLength(1);
  });

  it('transfert d’hôte : le nouvel hôte contrôle, l’ancien non', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'transfer', user: 'bob' })))).toEqual([{ t: 'host', user: 'bob' }]);
    expect(errors(fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 1 })))).toEqual(['not_host']);
    expect(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'play', pos: 1 }))).toHaveLength(1);
  });

  it('signalement : retrouve le message, notifie l’hôte, pas de doublon, pas d’auto-signalement', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob', 'a-carol');
    const chat = broadcasts(fx.core.handle('a-bob', msg({ t: 'chat', text: 'message gênant' })))[0];
    if (chat?.t !== 'chat') throw new Error('chat attendu');
    expect(JSON.stringify(chat)).not.toContain('a-bob');
    const id = chat.line.id;
    const effects = fx.core.handle('a-carol', msg({ t: 'report', messageId: id, reason: 'insulte' }));
    expect(sent(effects, 'a-carol')).toEqual([{ t: 'reported', messageId: id }]);
    expect(sent(effects, 'a-host')).toEqual([{ t: 'reported', messageId: id, by: 'carol', against: 'bob', text: 'message gênant' }]);
    expect(fx.core.reports).toEqual([{ messageId: id, by: 'carol', against: 'bob', text: 'message gênant', reason: 'insulte', at: T0 }]);
    fx.core.handle('a-carol', msg({ t: 'report', messageId: id }));
    expect(fx.core.reports).toHaveLength(1);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'report', messageId: id })))).toEqual(['cannot_report_self']);
    expect(errors(fx.core.handle('a-carol', msg({ t: 'report', messageId: 'inconnu' })))).toEqual(['message_not_found']);
  });

  it('filtrage du chat : insultes masquées, liens retirés, contrôles supprimés, longueur bornée', () => {
    const insult = filterChat('Quel connard !');
    expect(insult.ok && insult.text).toMatch(/^Quel \*+ !$/);
    const masked = filterChat('quel c0nnard, vraiment');
    expect(masked.ok && masked.text).toMatch(/^quel \*+ vraiment$/);
    expect(filterChat('allez sur https://spam.example/x maintenant')).toEqual({ ok: true, text: 'allez sur [lien] maintenant' });
    expect(filterChat('va sur spam.com/promo')).toEqual({ ok: true, text: 'va sur [lien]' });
    expect(filterChat(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c`)).toEqual({ ok: true, text: 'abc' });
    expect(filterChat('   \n\t ')).toEqual({ ok: false, reason: 'empty' });
    const long = filterChat('x'.repeat(2000));
    expect(long.ok && long.text.length).toBe(CHAT_MAX_CHARS);
    // Un mot qui en contient un autre n'est pas masqué (« technique », « computer »).
    expect(filterChat('technique du computer en retard')).toEqual({ ok: true, text: 'technique du computer en retard' });
  });

  it('limite de débit par participant : au-delà de la limite erreur, au-delà du double déconnexion', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    const outcomes: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const effects = fx.core.handle('a-bob', msg({ t: 'chat', text: `m${i}` }));
      outcomes.push(effects.some((e) => e.kind === 'close') ? 'close' : errors(effects)[0] ?? 'ok');
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'rate_limited', 'close']);
    // Les autres participants ne sont pas affectés, et la fenêtre se vide avec le temps.
    expect(errors(fx.core.handle('a-host', msg({ t: 'chat', text: 'ok' })))).toEqual([]);
    fx.clock.now += 11_000;
    expect(errors(fx.core.handle('a-bob', msg({ t: 'chat', text: 'de nouveau' })))).toEqual([]);
  });

  it('réactions : seules les réactions prévues sont diffusées', () => {
    const fx = makeRoom();
    joined(fx, 'a-bob');
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'react', emoji: '🔥' })))).toEqual([{ t: 'react', user: 'bob', emoji: '🔥', at: T0 }]);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'react', emoji: '<script>' })))).toEqual(['invalid_reaction']);
  });

  it('fin du salon par l’hôte uniquement', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(errors(fx.core.handle('a-bob', msg({ t: 'end' })))).toEqual(['not_host']);
    expect(fx.core.handle('a-host', msg({ t: 'end' }))).toContainEqual({ kind: 'end' });
  });
});

describe('cycle de vie du salon', () => {
  it('hôte absent depuis plus d’une minute : le participant le plus ancien devient hôte', () => {
    const fx = makeRoom();
    const host = fx.member('a-host');
    fx.core.join(host);
    fx.clock.now += 1000;
    joined(fx, 'a-bob', 'a-carol');
    fx.core.leave('a-host', host.connId);
    expect(fx.core.nextWake()).toBe(T0 + 1000 + HOST_GRACE_MS);
    fx.clock.now += HOST_GRACE_MS - 1;
    expect(fx.core.tick().effects).toEqual([]);
    fx.clock.now += 2;
    const tick = fx.core.tick();
    expect(broadcasts(tick.effects)).toEqual([{ t: 'host', user: 'bob' }]);
    expect(fx.core.hostId).toBe('a-bob');
  });

  it('si l’hôte revient à temps il garde son rôle', () => {
    const fx = makeRoom();
    const host = fx.member('a-host');
    fx.core.join(host);
    joined(fx, 'a-bob');
    fx.core.leave('a-host', host.connId);
    fx.clock.now += 30_000;
    fx.core.join(fx.member('a-host'));
    fx.clock.now += HOST_GRACE_MS * 2;
    expect(fx.core.tick().effects).toEqual([]);
    expect(fx.core.hostId).toBe('a-host');
  });

  it('salon vide : supprimé après le délai ; salon trop ancien : supprimé même occupé', () => {
    const fx = makeRoom();
    const host = fx.member('a-host');
    fx.core.join(host);
    fx.core.leave('a-host', host.connId);
    fx.clock.now += EMPTY_ROOM_TTL_MS - 1;
    expect(fx.core.tick().effects).toEqual([]);
    fx.clock.now += 1;
    expect(fx.core.tick().effects).toContainEqual({ kind: 'end' });

    const old = makeRoom();
    joined(old, 'a-host');
    old.clock.now += ROOM_MAX_AGE_MS;
    expect(old.core.tick().effects).toContainEqual({ kind: 'end' });
  });
});

describe('protocole et tickets', () => {
  it('messages client invalides refusés (jamais d’exception)', () => {
    for (const bad of ['pas du json', '[]', '{"t":42}', '{"t":"ctl","action":"explode","pos":1}', '{"t":"ctl","action":"play","pos":-1}', '{"t":"ctl","action":"play","pos":"1"}', '{"t":"episode","season":1.5,"episode":1}', '{"t":"inconnu"}', 'x'.repeat(5000)]) {
      expect(parseClientMessage(bad)).toBeUndefined();
    }
  });

  it('empreinte de version : champs bornés', () => {
    expect(parseFingerprint({ fileName: ' Film.mkv ', size: 123.9, hash: 'abcdef0123456789' })).toEqual({ fileName: 'Film.mkv', size: 123, hash: 'abcdef0123456789' });
    expect(parseFingerprint({ hash: 'a b' })).toBeNull();
    expect(parseFingerprint('x')).toBeNull();
    expect(parseFingerprint({ fileName: 'x'.repeat(500) })?.fileName).toHaveLength(260);
  });

  it('ticket : lié au salon, expire en 60 s, signature vérifiée, secret différent refusé', () => {
    const identity = { accountId: 'a-1', username: 'bob', avatarColor: '#112233' };
    const { ticket } = signTicket('room-0123456789abcdef', identity, T0, SECRET);
    expect(verifyTicket(ticket, 'room-0123456789abcdef', T0 + 59_000, SECRET)).toEqual(identity);
    expect(verifyTicket(ticket, 'room-0123456789abcdef', T0 + 61_000, SECRET)).toBeUndefined();
    expect(verifyTicket(ticket, 'autre-salon-0123456789', T0, SECRET)).toBeUndefined();
    expect(verifyTicket(ticket, 'room-0123456789abcdef', T0, 'autre-secret-with-more-than-32-chars!!')).toBeUndefined();
    expect(verifyTicket(`${ticket}x`, 'room-0123456789abcdef', T0, SECRET)).toBeUndefined();
    expect(verifyTicket('n.importe.quoi', 'room-0123456789abcdef', T0, SECRET)).toBeUndefined();
    const tampered = ticket.replace(/^[^.]+/, Buffer.from(JSON.stringify({ ...identity, roomId: 'room-0123456789abcdef', exp: T0 + 9e9, purpose: 'x' })).toString('base64url'));
    expect(verifyTicket(tampered, 'room-0123456789abcdef', T0, SECRET)).toBeUndefined();
  });
});
