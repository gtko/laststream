import { describe, expect, it } from 'vitest';
import { filterChat } from '../src/party/filter.js';
import {
  CHAT_MAX_CHARS,
  CLOSE,
  EMPTY_ROOM_TTL_MS,
  HOST_GRACE_MS,
  PARTY_RESUME_AHEAD_SEC,
  PARTY_WAIT_MAX_MS,
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
/** Diffusions hors événements lisibles (`event`, testés à part par eventsOf) : les attentes existantes restent lisibles. */
function broadcasts(effects: Effect[]): ServerMessage[] {
  return effects.flatMap((e) => (e.kind === 'broadcast' && e.msg.t !== 'event' ? [e.msg] : []));
}
function eventsOf(effects: Effect[]): ServerMessage[] {
  return effects.flatMap((e) => (e.kind === 'broadcast' && e.msg.t === 'event' ? [e.msg] : []));
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
    expect(welcome.you).toEqual({ username: 'bob', host: false, muted: false, peerId: expect.any(String) });
    expect(welcome.room).toMatchObject({ title: 'Severance', host: 'host', maxParticipants: 20, media: { season: 1, episode: 1 } });
    expect(welcome.participants.map((p) => p.username)).toEqual(['host', 'bob']);
    expect(welcome.chat).toHaveLength(1);
    expect(JSON.stringify(welcome)).not.toContain('a-host');
    expect(broadcasts(effects)).toEqual([{ t: 'join', participant: expect.objectContaining({ username: 'bob' }) }]);
  });

  it('bienvenue avec TURN : identifiants joints au seul message du participant, jamais diffusés', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    const turn = { urls: ['turns:turn.example.test:5349?transport=tcp'], username: 'user-turn-1', credential: 'cred-turn-secret' };
    const effects = fx.core.join(fx.member('a-bob'), turn);
    const welcome = sent(effects, 'a-bob')[0];
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.turn).toEqual(turn);
    expect(JSON.stringify(broadcasts(effects))).not.toContain('cred-turn-secret');
    expect(sent(effects, 'a-host')).toEqual([]);
  });

  it('bienvenue sans TURN (null ou absent) : aucun champ turn, la réponse reste identique', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    const withNull = sent(fx.core.join(fx.member('a-bob'), null), 'a-bob')[0];
    const withDefault = sent(fx.core.join(fx.member('a-tom')), 'a-tom')[0];
    if (withNull?.t !== 'welcome' || withDefault?.t !== 'welcome') throw new Error('welcome attendu');
    expect(withNull).not.toHaveProperty('turn');
    expect(withDefault).not.toHaveProperty('turn');
    expect(Object.keys(withNull).sort()).toEqual(Object.keys(withDefault).sort());
  });

  it('play, pause et seek viennent de tout participant ; seul l’hôte change d’épisode et envoie le rapport de position', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(errors(fx.core.handle('a-bob', msg({ t: 'episode', season: 1, episode: 2 })))).toEqual(['not_host']);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'sync', pos: 5 })))).toEqual(['not_host']);
    expect(fx.data.state).toEqual({ playing: false, pos: 0, at: T0, rev: 0 });
    // L'invité met en lecture : diffusé à tous, y compris à l'hôte.
    const played = fx.core.handle('a-bob', msg({ t: 'ctl', action: 'play', pos: 5 }));
    expect(broadcasts(played)).toEqual([{ t: 'state', state: { playing: true, pos: 5, at: T0, rev: 1 }, serverTime: T0, by: 'bob' }]);
    // Puis l'hôte met en pause, et l'invité saute : à chaque fois, rev croît et l'état est rediffusé.
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'ctl', action: 'pause', pos: 9 })))).toEqual([{ t: 'state', state: { playing: false, pos: 9, at: T0, rev: 2 }, serverTime: T0, by: 'host' }]);
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'seek', pos: 50 })))).toEqual([{ t: 'state', state: { playing: false, pos: 50, at: T0, rev: 3 }, serverTime: T0, by: 'bob' }]);
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
    // Envoyé par destinataire : l'hôte reçoit l'empreinte complète (un invité ne la reçoit pas, voir party-guest).
    expect(sent(effects, 'a-host').find((m) => m.t === 'media')).toMatchObject({
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

  it('transfert d’hôte : le nouvel hôte seul envoie le rapport de position et change d’épisode', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'transfer', user: 'bob' })))).toEqual([{ t: 'host', user: 'bob' }]);
    expect(errors(fx.core.handle('a-host', msg({ t: 'ctl', action: 'sync', pos: 1 })))).toEqual(['not_host']);
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 1 })))).toHaveLength(1);
    expect(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'sync', pos: 30 }))).toHaveLength(1);
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
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'react', emoji: '🔥', pos: null })))).toEqual([{ t: 'react', user: 'bob', by: 'bob', emoji: '🔥', at: T0, pos: null }]);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'react', emoji: '<script>' })))).toEqual(['invalid_reaction']);
  });

  it('réactions : 😱 et 🤯 sont prévues comme les autres', () => {
    const fx = makeRoom();
    joined(fx, 'a-bob');
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'react', emoji: '😱', pos: null })))).toEqual([{ t: 'react', user: 'bob', by: 'bob', emoji: '😱', at: T0, pos: null }]);
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'react', emoji: '🤯', pos: null })))).toEqual([{ t: 'react', user: 'bob', by: 'bob', emoji: '🤯', at: T0, pos: null }]);
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

describe('attente de tampon : lecture suspendue tant qu’un invité charge', () => {
  const buf = (ready: boolean) => msg({ t: 'buf', ready, ahead: ready ? 12 : 0 });
  const guest = (fx: Fixture, id: string, name: string): Member => ({ ...fx.member(`guest:${id}`, name), guest: true });
  /** Salon dont l'hôte lit depuis 10 s (instant T0). */
  function playing(): Fixture {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 10 }));
    return fx;
  }

  it('déclaration de tampon : prêt ou non, avance bornée à 0..600 s', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'buf', ready: false, ahead: 0 }))).toEqual({ t: 'buf', ready: false, ahead: 0 });
    expect(parseClientMessage(JSON.stringify({ t: 'buf', ready: true, ahead: 600 }))).toEqual({ t: 'buf', ready: true, ahead: 600 });
    for (const bad of [
      { t: 'buf', ready: 'oui', ahead: 5 },
      { t: 'buf', ready: true, ahead: 601 },
      { t: 'buf', ready: true, ahead: -1 },
      { t: 'buf', ready: true },
      { t: 'buf', ahead: 5 },
      { t: 'buf', ready: true, ahead: '5' },
    ]) {
      expect(parseClientMessage(JSON.stringify(bad))).toBeUndefined();
    }
    expect(PARTY_RESUME_AHEAD_SEC).toBe(10);
    expect(PARTY_WAIT_MAX_MS).toBe(45_000);
  });

  it('un invité qui entre pendant la lecture la suspend à la position atteinte et annonce l’attente', () => {
    const fx = playing();
    fx.clock.now += 5000;
    const effects = fx.core.join(guest(fx, 'lea', 'Léa'));
    // Pause à 15 s (10 s + 5 s écoulées), rev 2 ; l'attente est diffusée avant l'arrivée du participant.
    expect(broadcasts(effects)).toEqual([
      { t: 'state', state: { playing: false, pos: 15, at: T0 + 5000, rev: 2 }, serverTime: T0 + 5000, by: 'Léa' },
      { t: 'wait', who: ['Léa'], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'join', participant: expect.objectContaining({ username: 'Léa', guest: true }) },
    ]);
    // La bienvenue porte déjà l'état suspendu.
    expect(sent(effects, 'guest:lea')[0]).toMatchObject({ t: 'welcome', state: { playing: false, pos: 15, rev: 2 } });
  });

  it('salon déjà en pause : un invité qui entre ouvre l’attente sans toucher à l’état', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    const effects = fx.core.join(guest(fx, 'lea', 'Léa'));
    expect(broadcasts(effects)[0]).toEqual({ t: 'wait', who: ['Léa'], since: T0, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC });
    expect(fx.data.state).toEqual({ playing: false, pos: 0, at: T0, rev: 0 });
    expect(fx.data.heldByWait).toBe(false);
  });

  it('reprise quand le dernier retardataire est prêt, à la position figée', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.core.join(guest(fx, 'tom', 'Tom'));
    fx.clock.now += 3000;
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([{ t: 'wait', who: ['Tom'], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC }]);
    expect(broadcasts(fx.core.handle('guest:tom', buf(true)))).toEqual([
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 15, at: T0 + 8000, rev: 3 }, serverTime: T0 + 8000, by: 'Tom' },
    ]);
    expect(fx.data.state).toEqual({ playing: true, pos: 15, at: T0 + 8000, rev: 3 });
  });

  it('attente trop longue : au bout de 45 s les retardataires sont retirés et la lecture reprend (horloge simulée)', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    const deadline = T0 + 5000 + PARTY_WAIT_MAX_MS;
    expect(fx.core.nextWake()).toBe(deadline);
    fx.clock.now = deadline - 1;
    expect(fx.core.tick().effects).toEqual([]);
    fx.clock.now = deadline;
    expect(broadcasts(fx.core.tick().effects)).toEqual([
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 15, at: deadline, rev: 3 }, serverTime: deadline, by: 'host' },
    ]);
    // Le réveil suivant ne concerne plus l'attente.
    expect(fx.core.nextWake()).toBe(fx.data.meta.createdAt + ROOM_MAX_AGE_MS);
  });

  it('pause manuelle pendant l’attente : jamais relancée, ni à la fin de l’attente ni au délai', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += 1000;
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'ctl', action: 'pause', pos: 16 })))).toEqual([
      { t: 'state', state: { playing: false, pos: 16, at: T0 + 6000, rev: 3 }, serverTime: T0 + 6000, by: 'host' },
    ]);
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([{ t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC }]);
    expect(fx.data.state).toMatchObject({ playing: false, pos: 16 });
    fx.clock.now = T0 + 5000 + PARTY_WAIT_MAX_MS;
    expect(fx.core.tick().effects).toEqual([]);
    expect(fx.data.state.playing).toBe(false);
  });

  it('pause manuelle pendant l’attente : annule la reprise automatique, la lecture reste en pause à la fin', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.core.handle('a-host', msg({ t: 'ctl', action: 'pause', pos: 40 }));
    expect(fx.data.heldByWait).toBe(false);
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([{ t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC }]);
    expect(fx.data.state.playing).toBe(false);
  });

  it.each([
    ['seek', 40],
    ['sync', 20],
  ] as const)('%s pendant l’attente : la position suit, la reprise automatique est conservée', (action, pos) => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += 1000;
    fx.core.handle('a-host', msg({ t: 'ctl', action, pos }));
    expect(fx.data.heldByWait).toBe(true);
    expect(fx.data.state).toMatchObject({ playing: false, pos });
    fx.clock.now += 1000;
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos, at: T0 + 7000, rev: 4 }, serverTime: T0 + 7000, by: 'Léa' },
    ]);
  });

  it('lecture demandée pendant l’attente : différée, reprise à la fin de l’attente à la position demandée', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += 2000;
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 17 })))).toEqual([
      { t: 'state', state: { playing: false, pos: 17, at: T0 + 7000, rev: 3 }, serverTime: T0 + 7000, by: 'host' },
    ]);
    expect(fx.data.heldByWait).toBe(true);
    // Un rapport de position de l'hôte dans la tolérance ne change rien à l'attente.
    expect(fx.core.handle('a-host', msg({ t: 'ctl', action: 'sync', pos: 17.2 }))).toEqual([]);
    fx.clock.now += 1000;
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 17, at: T0 + 8000, rev: 4 }, serverTime: T0 + 8000, by: 'Léa' },
    ]);
  });

  it('un retardataire qui part ne retient plus la lecture ; tant qu’il en reste un, pas de reprise', () => {
    const fx = playing();
    fx.clock.now += 5000;
    const lea = guest(fx, 'lea', 'Léa');
    const tom = guest(fx, 'tom', 'Tom');
    fx.core.join(lea);
    fx.core.join(tom);
    fx.clock.now += 1000;
    expect(broadcasts(fx.core.leave(lea.accountId, lea.connId))).toEqual([
      { t: 'leave', user: 'Léa' },
      { t: 'wait', who: ['Tom'], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
    ]);
    expect(broadcasts(fx.core.leave(tom.accountId, tom.connId))).toEqual([
      { t: 'leave', user: 'Tom' },
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 15, at: T0 + 6000, rev: 3 }, serverTime: T0 + 6000, by: 'Tom' },
    ]);
  });

  it('un retardataire exclu : l’attente se termine comme pour un départ', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'kick', user: 'Léa' })))).toEqual([
      { t: 'leave', user: 'Léa' },
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 15, at: T0 + 5000, rev: 3 }, serverTime: T0 + 5000, by: 'host' },
    ]);
  });

  it('un participant qui entre pendant l’attente reçoit l’attente en cours', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += 1000;
    const effects = fx.core.join(fx.member('a-bob'));
    expect(sent(effects, 'a-bob')).toContainEqual({ t: 'wait', who: ['Léa'], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC });
    expect(broadcasts(effects)).toEqual([{ t: 'join', participant: expect.objectContaining({ username: 'bob' }) }]);
  });

  it('un invité qui se reconnecte doit de nouveau charger : la lecture est suspendue à nouveau', () => {
    const fx = playing();
    fx.clock.now += 5000;
    const lea = guest(fx, 'lea', 'Léa');
    fx.core.join(lea);
    fx.core.handle('guest:lea', buf(true));
    expect(fx.data.state.playing).toBe(true);
    fx.clock.now += 1000;
    const effects = fx.core.join(guest(fx, 'lea', 'Léa'));
    expect(broadcasts(effects)).toContainEqual({ t: 'wait', who: ['Léa'], since: T0 + 6000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC });
    expect(fx.data.state).toEqual({ playing: false, pos: 16, at: T0 + 6000, rev: 4 });
  });

  it('épisode changé pendant l’attente : le nouvel épisode reste en pause à la fin de l’attente', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.core.handle('a-host', msg({ t: 'episode', season: 1, episode: 2, fingerprint: null }));
    expect(broadcasts(fx.core.handle('guest:lea', buf(true)))).toEqual([{ t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC }]);
    expect(fx.data.state).toMatchObject({ playing: false, pos: 0 });
  });

  it('l’attente survit à une reprise du salon depuis son stockage (hibernation du Durable Object)', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    const revived = new RoomCore(fx.data, [], [], () => fx.clock.now);
    const deadline = T0 + 5000 + PARTY_WAIT_MAX_MS;
    expect(revived.nextWake()).toBe(deadline);
    fx.clock.now = deadline;
    expect(broadcasts(revived.tick().effects)).toEqual([
      { t: 'wait', who: [], since: T0 + 5000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
      { t: 'state', state: { playing: true, pos: 15, at: deadline, rev: 3 }, serverTime: deadline, by: 'host' },
    ]);
  });

  it('déclarations de tampon : au plus 20 par 10 s, puis erreur rate_limited, puis déconnexion', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    const outcomes: string[] = [];
    for (let i = 0; i < 41; i += 1) {
      const effects = fx.core.handle('a-bob', buf(true));
      outcomes.push(effects.some((e) => e.kind === 'close') ? 'close' : (errors(effects)[0] ?? 'ok'));
    }
    expect(outcomes.slice(0, 20)).toEqual(Array(20).fill('ok'));
    expect(outcomes.slice(20, 40)).toEqual(Array(20).fill('rate_limited'));
    expect(outcomes[40]).toBe('close');
    fx.clock.now += 10_000;
    expect(errors(fx.core.handle('a-bob', buf(true)))).toEqual([]);
  });

  it('retardataire retiré par le délai : ses « pas prêt » répétés ne remettent pas la lecture en pause', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += PARTY_WAIT_MAX_MS;
    fx.core.tick();
    expect(fx.data.state.playing).toBe(true);
    expect(fx.data.waitTimedOut).toEqual(['guest:lea']);
    for (let i = 0; i < 10; i += 1) {
      fx.clock.now += 2000;
      expect(fx.core.handle('guest:lea', buf(false))).toEqual([]);
    }
    expect(fx.data.state.playing).toBe(true);
    expect(fx.data.waiting).toEqual([]);
  });

  it('retardataire retiré par le délai : « prêt » puis « pas prêt » ouvre une nouvelle attente', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += PARTY_WAIT_MAX_MS;
    fx.core.tick();
    fx.clock.now += 2000;
    expect(fx.core.handle('guest:lea', buf(true))).toEqual([]);
    expect(fx.data.waitTimedOut).toEqual([]);
    expect(broadcasts(fx.core.handle('guest:lea', buf(false)))).toEqual([
      { t: 'state', state: { playing: false, pos: 17, at: T0 + 52000, rev: 4 }, serverTime: T0 + 52000, by: 'Léa' },
      { t: 'wait', who: ['Léa'], since: T0 + 52000, maxMs: PARTY_WAIT_MAX_MS, resumeAhead: PARTY_RESUME_AHEAD_SEC },
    ]);
  });

  it('retardataire retiré par le délai : un seek lève l’exclusion, son « pas prêt » suivant rouvre l’attente', () => {
    const fx = playing();
    fx.clock.now += 5000;
    fx.core.join(guest(fx, 'lea', 'Léa'));
    fx.clock.now += PARTY_WAIT_MAX_MS;
    fx.core.tick();
    fx.core.handle('guest:lea', msg({ t: 'ctl', action: 'seek', pos: 20 }));
    expect(fx.data.waitTimedOut).toEqual([]);
    expect(broadcasts(fx.core.handle('guest:lea', buf(false)))).toContainEqual({
      t: 'wait',
      who: ['Léa'],
      since: T0 + 50000,
      maxMs: PARTY_WAIT_MAX_MS,
      resumeAhead: PARTY_RESUME_AHEAD_SEC,
    });
  });

  it('retardataire retiré par le délai : son départ efface l’exclusion, son retour ouvre une attente', () => {
    const fx = playing();
    fx.clock.now += 5000;
    const lea = guest(fx, 'lea', 'Léa');
    fx.core.join(lea);
    fx.clock.now += PARTY_WAIT_MAX_MS;
    fx.core.tick();
    fx.core.leave(lea.accountId, lea.connId);
    expect(fx.data.waitTimedOut).toEqual([]);
    expect(broadcasts(fx.core.join(guest(fx, 'lea', 'Léa')))).toContainEqual({
      t: 'wait',
      who: ['Léa'],
      since: T0 + 50000,
      maxMs: PARTY_WAIT_MAX_MS,
      resumeAhead: PARTY_RESUME_AHEAD_SEC,
    });
  });
});

describe('watch party enrichie (S4)', () => {
  const guestOf = (fx: Fixture, id: string, name: string): Member => ({ ...fx.member(`guest:${id}`, name), guest: true });
  const VOTE_OPTIONS = [
    { type: 'movie', tmdbId: 603, title: 'Matrix' },
    { type: 'movie', tmdbId: 27205, title: 'Inception' },
    { type: 'series', tmdbId: 1396, title: 'Breaking Bad' },
  ];

  it('réglages : hôte seul ; contrôle hôte refuse play, pause et seek des autres, la synchronisation de l’hôte reste ouverte', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(errors(fx.core.handle('a-bob', msg({ t: 'settings', control: 'host' })))).toEqual(['not_host']);
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'settings', control: 'host' })))).toEqual([
      { t: 'settings', settings: { control: 'host', waitLate: 'always', reactions: 'float' }, by: 'host' },
    ]);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'play', pos: 5 })))).toEqual(['not_host']);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'seek', pos: 5 })))).toEqual(['not_host']);
    expect(fx.data.state.playing).toBe(false);
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'ctl', action: 'play', pos: 5 })))).toEqual([
      { t: 'state', state: { playing: true, pos: 5, at: T0, rev: 1 }, serverTime: T0, by: 'host' },
    ]);
    // Contrôle libre rétabli : l'invité peut de nouveau mettre en pause.
    fx.core.handle('a-host', msg({ t: 'settings', control: 'all' }));
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'pause', pos: 6 }))).map((m) => m.t)).toEqual(['state']);
  });

  it('attente de tampon : « désactivée » n’ouvre aucune attente ; « 10 s » fixe le délai annoncé', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    fx.core.handle('a-host', msg({ t: 'settings', waitLate: 'off' }));
    const lea = fx.core.join(guestOf(fx, 'lea', 'Léa'));
    expect(broadcasts(lea).some((m) => m.t === 'wait')).toBe(false);
    expect(sent(lea, 'guest:lea').some((m) => m.t === 'wait')).toBe(false);
    fx.core.handle('a-host', msg({ t: 'settings', waitLate: '10s' }));
    const tom = fx.core.join(guestOf(fx, 'tom', 'Tom'));
    expect(broadcasts(tom)).toContainEqual({ t: 'wait', who: ['Tom'], since: T0, maxMs: 10_000, resumeAhead: PARTY_RESUME_AHEAD_SEC });
  });

  it('réactions : « désactivées » refusé ; une réaction signée porte son auteur et la position du film', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    fx.core.handle('a-host', msg({ t: 'settings', reactions: 'off' }));
    expect(errors(fx.core.handle('a-bob', msg({ t: 'react', emoji: '🔥', pos: null })))).toEqual(['reactions_off']);
    fx.core.handle('a-host', msg({ t: 'settings', reactions: 'discreet' }));
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'react', emoji: '🔥', pos: 42.5 })))).toEqual([
      { t: 'react', user: 'bob', by: 'bob', emoji: '🔥', at: T0, pos: 42.5 },
    ]);
  });

  it('préparation : prêt, qualité et état diffusés au changement seulement ; présents au bienvenue ; retirés au départ', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'ready', ready: true, quality: '  1080p​ ' })))).toEqual([
      { t: 'prep', user: 'bob', ready: true, quality: '1080p', status: 'searching' },
    ]);
    expect(fx.core.handle('a-bob', msg({ t: 'ready', ready: true, quality: '1080p' }))).toEqual([]);
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'status', status: 'buffering' })))).toEqual([
      { t: 'prep', user: 'bob', ready: true, quality: '1080p', status: 'buffering' },
    ]);
    expect(fx.core.handle('a-bob', msg({ t: 'status', status: 'buffering' }))).toEqual([]);
    const welcome = sent(fx.core.join(fx.member('a-tom')), 'a-tom')[0];
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.participants.find((p) => p.username === 'bob')).toMatchObject({ ready: true, quality: '1080p', status: 'buffering' });
    expect(welcome.participants.find((p) => p.username === 'tom')).toMatchObject({ ready: false, quality: null, status: 'searching' });
    expect(welcome.settings).toEqual({ control: 'all', waitLate: 'always', reactions: 'float' });
    expect(welcome.countdownAt).toBeNull();
    expect(welcome.vote).toBeNull();
    fx.core.leave('a-bob', fx.core.members.get('a-bob')?.connId ?? '');
    expect(fx.data.prep).not.toHaveProperty('a-bob');
  });

  it('démarrage : compte à rebours diffusé, lecture reprise à l’échéance (horloge simulée) ; réservé à l’hôte, une seule fois', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(errors(fx.core.handle('a-bob', msg({ t: 'start', countdown: 3 })))).toEqual(['not_host']);
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'start', countdown: 3 })))).toEqual([{ t: 'countdown', at: T0 + 3000, by: 'host' }]);
    expect(fx.core.nextWake()).toBe(T0 + 3000);
    fx.clock.now += 2000;
    expect(fx.core.tick().effects).toEqual([]);
    fx.clock.now += 1000;
    expect(broadcasts(fx.core.tick().effects)).toEqual([
      { t: 'countdown', at: null, by: 'host' },
      { t: 'state', state: { playing: true, pos: 0, at: T0 + 3000, rev: 1 }, serverTime: T0 + 3000, by: 'host' },
    ]);
    expect(fx.data.countdownAt).toBeNull();
    expect(errors(fx.core.handle('a-host', msg({ t: 'start', countdown: 3 })))).toEqual(['already_playing']);
  });

  it('une commande de lecture pendant le compte à rebours l’annule', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    fx.core.handle('a-host', msg({ t: 'start', countdown: 5 }));
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'play', pos: 0 })))).toEqual([
      { t: 'state', state: { playing: true, pos: 0, at: T0, rev: 1 }, serverTime: T0, by: 'bob' },
      { t: 'countdown', at: null, by: 'bob' },
    ]);
    expect(fx.data.countdownAt).toBeNull();
  });

  it('vote du titre : ouvert par l’hôte, une voix par compte modifiable, fermé par l’hôte ; le titre le plus voté remplace le média', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob', 'a-tom');
    expect(errors(fx.core.handle('a-bob', msg({ t: 'vote_open', options: VOTE_OPTIONS })))).toEqual(['not_host']);
    expect(broadcasts(fx.core.handle('a-host', msg({ t: 'vote_open', options: VOTE_OPTIONS })))).toEqual([
      {
        t: 'vote',
        open: true,
        options: [
          { id: 'o0', type: 'movie', tmdbId: 603, title: 'Matrix', votes: 0 },
          { id: 'o1', type: 'movie', tmdbId: 27205, title: 'Inception', votes: 0 },
          { id: 'o2', type: 'series', tmdbId: 1396, title: 'Breaking Bad', votes: 0 },
        ],
      },
    ]);
    expect(errors(fx.core.handle('a-host', msg({ t: 'vote_open', options: VOTE_OPTIONS })))).toEqual(['vote_already_open']);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'vote', optionId: 'o9' })))).toEqual(['invalid_option']);
    const countsOf = (effects: Effect[]) => broadcasts(effects).flatMap((m) => (m.t === 'vote' ? m.options.map((o) => o.votes) : []));
    expect(countsOf(fx.core.handle('a-bob', msg({ t: 'vote', optionId: 'o1' })))).toEqual([0, 1, 0]);
    expect(countsOf(fx.core.handle('a-bob', msg({ t: 'vote', optionId: 'o2' })))).toEqual([0, 0, 1]);
    expect(countsOf(fx.core.handle('a-tom', msg({ t: 'vote', optionId: 'o2' })))).toEqual([0, 0, 2]);
    expect(errors(fx.core.handle('a-bob', msg({ t: 'vote_close' })))).toEqual(['not_host']);
    const closed = fx.core.handle('a-host', msg({ t: 'vote_close' }));
    expect(broadcasts(closed)).toEqual([
      {
        t: 'vote',
        open: false,
        options: [
          { id: 'o0', type: 'movie', tmdbId: 603, title: 'Matrix', votes: 0 },
          { id: 'o1', type: 'movie', tmdbId: 27205, title: 'Inception', votes: 0 },
          { id: 'o2', type: 'series', tmdbId: 1396, title: 'Breaking Bad', votes: 2 },
        ],
      },
    ]);
    expect(sent(closed, 'a-tom')).toContainEqual({
      t: 'media',
      media: { type: 'series', tmdbId: 1396, imdbId: null, season: null, episode: null },
      fingerprint: null,
      state: { playing: false, pos: 0, at: T0, rev: 1 },
      serverTime: T0,
    });
    expect(fx.data.meta.title).toBe('Breaking Bad');
    expect(fx.data.vote).toBeNull();
  });

  it('vote : sans aucune voix, fermeture sans changement de titre ; à égalité, la première option proposée l’emporte', () => {
    const empty = makeRoom();
    joined(empty, 'a-host', 'a-bob');
    empty.core.handle('a-host', msg({ t: 'vote_open', options: VOTE_OPTIONS }));
    expect(sent(empty.core.handle('a-host', msg({ t: 'vote_close' })), 'a-bob').some((m) => m.t === 'media')).toBe(false);
    expect(empty.data.meta.title).toBe('Severance');

    const tie = makeRoom();
    joined(tie, 'a-host', 'a-bob', 'a-tom');
    tie.core.handle('a-host', msg({ t: 'vote_open', options: VOTE_OPTIONS }));
    tie.core.handle('a-bob', msg({ t: 'vote', optionId: 'o1' }));
    tie.core.handle('a-tom', msg({ t: 'vote', optionId: 'o2' }));
    tie.core.handle('a-host', msg({ t: 'vote_close' }));
    // Inception (o1) et Breaking Bad (o2) ont une voix chacun : la première proposée, Inception, l'emporte.
    expect(tie.data.meta.media).toMatchObject({ type: 'movie', tmdbId: 27205 });
  });

  it('vote : un votant qui part retire sa voix ; un nouvel entrant voit le vote en cours au bienvenue', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    fx.core.handle('a-host', msg({ t: 'vote_open', options: VOTE_OPTIONS.slice(0, 2) }));
    fx.core.handle('a-bob', msg({ t: 'vote', optionId: 'o1' }));
    const welcome = sent(fx.core.join(fx.member('a-tom')), 'a-tom')[0];
    if (welcome?.t !== 'welcome') throw new Error('welcome attendu');
    expect(welcome.vote?.map((o) => o.votes)).toEqual([0, 1]);
    const left = fx.core.leave('a-bob', fx.core.members.get('a-bob')?.connId ?? '');
    expect(broadcasts(left)).toContainEqual({
      t: 'vote',
      open: true,
      options: [
        { id: 'o0', type: 'movie', tmdbId: 603, title: 'Matrix', votes: 0 },
        { id: 'o1', type: 'movie', tmdbId: 27205, title: 'Inception', votes: 0 },
      ],
    });
  });

  it('chat : position du film jointe au message quand elle est connue, absente sinon', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    expect(broadcasts(fx.core.handle('a-bob', msg({ t: 'chat', text: 'Quelle scène', pos: 754.2 })))).toEqual([
      { t: 'chat', line: expect.objectContaining({ from: 'bob', text: 'Quelle scène', pos: 754.2 }) },
    ]);
    const plain = broadcasts(fx.core.handle('a-bob', msg({ t: 'chat', text: 'ok', pos: null })))[0];
    if (plain?.t !== 'chat') throw new Error('chat attendu');
    expect(plain.line).not.toHaveProperty('pos');
  });

  it('événements lisibles : arrivée, lecture, pause, saut (écart signé en secondes) et départ', () => {
    const fx = makeRoom();
    joined(fx, 'a-host');
    expect(eventsOf(fx.core.join(fx.member('a-bob')))).toEqual([{ t: 'event', kind: 'join', by: 'bob', pos: 0 }]);
    expect(eventsOf(fx.core.handle('a-bob', msg({ t: 'ctl', action: 'play', pos: 5 })))).toEqual([{ t: 'event', kind: 'play', by: 'bob', pos: 5 }]);
    fx.clock.now += 10_000;
    expect(eventsOf(fx.core.handle('a-host', msg({ t: 'ctl', action: 'pause', pos: 15 })))).toEqual([{ t: 'event', kind: 'pause', by: 'host', pos: 15 }]);
    expect(eventsOf(fx.core.handle('a-host', msg({ t: 'ctl', action: 'seek', pos: 4 })))).toEqual([{ t: 'event', kind: 'seek', by: 'host', pos: 4, delta: -11 }]);
    expect(eventsOf(fx.core.leave('a-bob', fx.core.members.get('a-bob')?.connId ?? ''))).toEqual([{ t: 'event', kind: 'leave', by: 'bob', pos: 4 }]);
    // Une synchronisation de l'hôte ne produit aucun événement.
    expect(eventsOf(fx.core.handle('a-host', msg({ t: 'ctl', action: 'sync', pos: 40 })))).toEqual([]);
  });

  it('connexion : seul un compte connecté est « connecté » ; un invité ne l’est pas', () => {
    const fx = makeRoom();
    joined(fx, 'a-host', 'a-bob');
    fx.core.join(guestOf(fx, 'lea', 'Léa'));
    expect(fx.core.isConnected('a-bob')).toBe(true);
    expect(fx.core.isConnected('guest:lea')).toBe(false);
    expect(fx.core.isConnected('a-absent')).toBe(false);
  });

  it('messages S4 invalides refusés à l’analyse ; valeurs par défaut quand le champ est absent', () => {
    const invalid = [
      { t: 'settings', control: 'anarchy' },
      { t: 'settings' },
      { t: 'ready', ready: 'oui', quality: null },
      { t: 'ready', ready: true, quality: 5 },
      { t: 'status', status: 'pause' },
      { t: 'start', countdown: 0 },
      { t: 'start', countdown: 11 },
      { t: 'vote_open', options: [{ type: 'movie', tmdbId: 1, title: 'A' }] },
      { t: 'vote_open', options: [{ type: 'book', tmdbId: 1, title: 'A' }, { type: 'movie', tmdbId: 2, title: 'B' }] },
      { t: 'vote', optionId: 'x'.repeat(17) },
      { t: 'chat', text: 'hé', pos: '12' },
    ];
    for (const message of invalid) expect(parseClientMessage(JSON.stringify(message))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ t: 'start' }))).toEqual({ t: 'start', countdown: 5 });
    expect(parseClientMessage(JSON.stringify({ t: 'ready', ready: true, quality: '  ' }))).toEqual({ t: 'ready', ready: true, quality: null });
    expect(parseClientMessage(JSON.stringify({ t: 'chat', text: 'hé' }))).toEqual({ t: 'chat', text: 'hé', pos: null });
    expect(parseClientMessage(JSON.stringify({ t: 'settings', waitLate: '10s' }))).toEqual({ t: 'settings', waitLate: '10s' });
  });
});

describe('clés de participant par profil (LAST-183)', () => {
  /** Salon récent : l'hôte est le profil `p1` du compte `acc` ; le sous-profil `p2` du même compte et un autre compte participent. */
  function profileRoom() {
    const fx = makeRoom();
    fx.data.meta.hostId = 'acc:p1';
    fx.data.meta.hostName = 'alice';
    fx.data.meta.memberKeys = 'profile';
    return fx;
  }
  const named = (fx: Fixture, key: string, name: string): Member => ({ ...fx.member(key), username: name });

  it('accountOf : compte d’une clé de profil ; clé de compte et clé d’invité inchangées', async () => {
    const { accountOf, memberKey } = await import('../src/party/keys.js');
    expect(accountOf('acc:p1')).toBe('acc');
    expect(accountOf('acc')).toBe('acc');
    expect(accountOf('guest:abc')).toBe('guest:abc');
    expect(memberKey('acc', 'p1', 'profile')).toBe('acc:p1');
    expect(memberKey('acc', 'p1', undefined)).toBe('acc');
  });

  it('l’hôte et un sous-profil de son compte sont connectés en même temps, chacun sous sa propre clé', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    fx.core.join(named(fx, 'acc:p2', 'alice · petit'));
    expect([...fx.core.members.keys()].sort()).toEqual(['acc:p1', 'acc:p2']);
    const welcome = sent(fx.core.join(named(fx, 'acc:p2', 'alice · petit')), 'acc:p2').find((m) => m.t === 'welcome');
    expect(welcome).toMatchObject({ you: { username: 'alice · petit', host: false } });
    expect(fx.core.members.get('acc:p1')).toBeDefined();
    // Seule la clé de l’hôte est hôte : le sous-profil ne modère pas.
    expect(errors(fx.core.handle('acc:p2', msg({ t: 'kick', user: 'alice' })))).toEqual(['not_host']);
  });

  it('salon ancien sans drapeau : la clé reste l’identifiant du compte', () => {
    const fx = makeRoom();
    expect(fx.core.keyMode()).toBe('account');
    expect(profileRoom().core.keyMode()).toBe('profile');
    joined(fx, 'a-host', 'a-bob');
    expect(fx.core.canJoin('a-bob')).toBe('ok');
    fx.core.handle('a-host', msg({ t: 'kick', user: 'bob' }));
    expect(fx.data.banned).toEqual(['a-bob']);
    expect(fx.core.canJoin('a-bob')).toBe('banned');
  });

  it('exclure un sous-profil bannit le compte : l’autre profil de ce compte est refusé et sort du salon', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    fx.core.join(named(fx, 'bob:p1', 'bob'));
    fx.core.join(named(fx, 'bob:p2', 'bob · petit'));
    const effects = fx.core.handle('acc:p1', msg({ t: 'kick', user: 'bob · petit' }));
    expect(effects).toContainEqual({ kind: 'close', to: 'bob:p2', code: CLOSE.kicked, reason: 'kicked' });
    expect(effects).toContainEqual({ kind: 'close', to: 'bob:p1', code: CLOSE.kicked, reason: 'kicked' });
    expect(fx.data.banned).toEqual(['bob']);
    expect(fx.core.members.has('bob:p1')).toBe(false);
    expect(fx.core.canJoin('bob:p1', 'bob')).toBe('banned');
    expect(fx.core.canJoin('bob:p3', 'bob · autre')).toBe('banned');
    expect(fx.core.canJoin('acc:p2', 'alice · petit')).toBe('ok');
  });

  it('l’hôte qui exclut son propre sous-profil ferme sa connexion sans bannir son compte', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    fx.core.join(named(fx, 'acc:p2', 'alice · petit'));
    const effects = fx.core.handle('acc:p1', msg({ t: 'kick', user: 'alice · petit' }));
    expect(effects).toContainEqual({ kind: 'close', to: 'acc:p2', code: CLOSE.kicked, reason: 'kicked' });
    expect(fx.data.banned).toEqual([]);
    expect(fx.core.members.has('acc:p2')).toBe(false);
    expect(fx.core.members.has('acc:p1')).toBe(true);
    expect(fx.core.canJoin('acc:p1', 'alice')).toBe('ok');
    expect(fx.core.canJoin('acc:p2', 'alice · petit')).toBe('ok');
  });

  it('deux profils de même pseudo : le second est refusé (name_taken, forme canonique)', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    fx.core.join(named(fx, 'bob:p1', 'Léa'));
    expect(fx.core.canJoin('cat:p1', 'lea')).toBe('name_taken');
    expect(fx.core.canJoin('cat:p1', 'ALICE')).toBe('name_taken');
    expect(fx.core.canJoin('cat:p1', 'cat')).toBe('ok');
    // Le même profil se reconnecte sous son pseudo sans conflit.
    expect(fx.core.canJoin('bob:p1', 'Léa')).toBe('ok');
  });

  it('isConnected reconnaît un compte connecté par n’importe quelle clé de profil, jamais un invité', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'bob:p2', 'bob · petit'));
    expect(fx.core.isConnected('bob')).toBe(true);
    expect(fx.core.isConnected('carl')).toBe(false);
    fx.core.leave('bob:p2', fx.core.members.get('bob:p2')?.connId ?? '');
    expect(fx.core.isConnected('bob')).toBe(false);
    fx.core.join({ ...fx.member('guest:g1', 'visiteur'), guest: true });
    expect(fx.core.isConnected('guest:g1')).toBe(false);
  });

  it('droits d’hôte par compte : invitations, lien et fin accessibles depuis le compte de l’hôte connecté', () => {
    const fx = profileRoom();
    expect(fx.core.inviteVerdict('acc')).toBe('forbidden');
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    expect(fx.core.isHostAccount('acc')).toBe(true);
    expect(fx.core.isHostAccount('bob')).toBe(false);
    expect(fx.core.inviteVerdict('bob')).toBe('forbidden');
    expect(fx.core.inviteVerdict('acc')).toBe('ok');
    expect(fx.core.inviteLink('acc', false)).toMatchObject({ ok: true });
  });

  it('signalement : la file d’administration reçoit le compte de l’auteur, pas la clé de profil', () => {
    const fx = profileRoom();
    fx.core.join(named(fx, 'acc:p1', 'alice'));
    fx.core.join(named(fx, 'bob:p2', 'bob · petit'));
    fx.core.handle('bob:p2', msg({ t: 'chat', text: 'bonjour' }));
    const lineId = fx.core.chat[0]?.id ?? '';
    fx.core.handle('acc:p1', msg({ t: 'report', messageId: lineId, reason: null }));
    expect(fx.core.fresh).toEqual([expect.objectContaining({ againstId: 'bob' })]);
  });
});
