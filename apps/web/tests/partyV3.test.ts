// Watch party Social v3 (F6) : messages du protocole étendu (réglages, préparation, compte à rebours, vote, événements,
// réactions signées, chat avec position), compatibilité avec un serveur antérieur, modèle du salon d'attente (textes, états).
import { describe, expect, it } from 'vitest';
import { PartyClient, type SocketLike } from '../src/party/client';
import {
  countdownLeft, eventText, formatDelta, formatTimecode, initialsOf, prepView, qualityLabel, readySummary, readyText, startWithoutText, syncText, voteShare,
} from '../src/party/lobbyModel';
import { DEFAULT_SETTINGS, encodeClientMessage, parseServerMessage } from '../src/party/protocol';

class FakeSocket implements SocketLike {
  sent: any[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() {}
  open() { this.onopen?.(); }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const ROOM = { id: 'r1', visibility: 'private', title: 'Dune', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 693134 }, fingerprint: null, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01T00:00:00Z' };
const welcome = (me: string, host: boolean, over: Record<string, unknown> = {}) => ({
  t: 'welcome', you: { username: me, host, muted: false }, room: ROOM, state: { playing: false, pos: 0, at: 1000, rev: 1 }, serverTime: 1000,
  participants: [{ username: 'alice', host: true, ready: true, quality: '4K HDR', status: 'ready' }, { username: 'bob', ready: false, quality: null, status: 'searching' }], chat: [], settings: DEFAULT_SETTINGS, ...over,
});

async function connect(me = 'bob', host = false, over: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const client = new PartyClient({ connect: async () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  client.start();
  await new Promise((r) => setTimeout(r, 0));
  sockets[0].open();
  sockets[0].recv(welcome(me, host, over));
  return { client, socket: sockets[0] };
}

describe('protocole v3 : réception', () => {
  it('welcome sans champs v3 (serveur antérieur) : défauts, aucun compte à rebours ni vote', async () => {
    const { client } = await connect();
    expect(client.settings).toEqual(DEFAULT_SETTINGS);
    expect(client.countdownAt).toBeNull();
    expect(client.vote).toBeNull();
  });

  it('welcome v3 : réglages, compte à rebours en cours et vote ouvert', async () => {
    const vote = [{ id: 'o0', type: 'movie', tmdbId: 1, title: 'A', votes: 2 }, { id: 'o1', type: 'movie', tmdbId: 2, title: 'B', votes: 1 }];
    const { client } = await connect('bob', false, { settings: { control: 'host', waitLate: '10s', reactions: 'off' }, countdownAt: 5000, vote });
    expect(client.settings).toEqual({ control: 'host', waitLate: '10s', reactions: 'off' });
    expect(client.countdownAt).toBe(5000);
    expect(client.vote).toHaveLength(2);
  });

  it('prep met à jour le participant ; settings, countdown, vote, event sont relayés', async () => {
    const { client, socket } = await connect();
    const seen: string[] = [];
    client.on('settings', (s) => seen.push('settings:' + s.control));
    client.on('countdown', (at) => seen.push('countdown:' + at));
    client.on('vote', (v) => seen.push('vote:' + (v ? v.length : 'null')));
    client.on('event', (e) => seen.push('event:' + e.kind + ':' + e.by + ':' + e.delta));
    socket.recv({ t: 'prep', user: 'bob', ready: true, quality: '1080p', status: 'ready' });
    expect(client.participants.find((p) => p.username === 'bob')).toMatchObject({ ready: true, quality: '1080p', status: 'ready' });
    socket.recv({ t: 'settings', settings: { control: 'host', waitLate: 'off', reactions: 'discreet' }, by: 'alice' });
    socket.recv({ t: 'countdown', at: 9000, by: 'alice' });
    expect(client.countdownAt).toBe(9000);
    socket.recv({ t: 'countdown', at: null, by: 'alice' });
    socket.recv({ t: 'vote', open: true, options: [{ id: 'o0', type: 'movie', tmdbId: 1, title: 'A', votes: 0 }] });
    socket.recv({ t: 'vote', open: false, options: [] });
    socket.recv({ t: 'event', kind: 'seek', by: 'hugo', pos: 100, delta: -10 });
    expect(seen).toEqual(['settings:host', 'countdown:9000', 'countdown:null', 'vote:1', 'vote:null', 'event:seek:hugo:-10']);
    expect(client.vote).toBeNull();
  });

  it('réaction signée : `by` et `pos` ; un serveur antérieur n’envoie que `user`', async () => {
    const { client, socket } = await connect();
    const got: any[] = [];
    client.on('react', (r) => got.push(r));
    socket.recv({ t: 'react', user: 'léa', by: 'léa', emoji: '🔥', at: 5, pos: 4352 });
    socket.recv({ t: 'react', user: 'tom', emoji: '👍', at: 6 });
    expect(got[0]).toMatchObject({ by: 'léa', pos: 4352 });
    expect(got[1]).toMatchObject({ by: 'tom', pos: null });
  });

  it('messages v3 reconnus par le décodeur ; chat avec position conservée', () => {
    expect(parseServerMessage('{"t":"countdown","at":null,"by":"a"}')).not.toBeNull();
    expect(parseServerMessage('{"t":"event","kind":"pause","by":"a","pos":1}')).not.toBeNull();
    const m = parseServerMessage('{"t":"chat","line":{"id":"1","from":"a","text":"x","at":1,"pos":72.5}}');
    expect(m && m.t === 'chat' && m.line.pos).toBe(72.5);
  });
});

describe('protocole v3 : envoi', () => {
  it('chat et réaction : `pos` joint seulement s’il est connu (rien de plus pour un serveur antérieur)', async () => {
    const { client, socket } = await connect();
    const before = socket.sent.length;
    client.sendChat('salut');
    client.sendChat('au ciné', 4352.46);
    client.sendReact('🔥');
    client.sendReact('🔥', 12);
    expect(socket.sent.slice(before)).toEqual([
      { t: 'chat', text: 'salut' }, { t: 'chat', text: 'au ciné', pos: 4352.5 }, { t: 'react', emoji: '🔥' }, { t: 'react', emoji: '🔥', pos: 12 },
    ]);
  });

  it('préparation : ready, status ; réglages, départ et vote réservés à l’hôte', async () => {
    const guest = await connect('bob', false);
    const n = guest.socket.sent.length;
    expect(guest.client.sendReady(true, '1080p')).toBe(true);
    expect(guest.client.sendStatus('searching')).toBe(true);
    expect(guest.client.sendSettings({ control: 'host' })).toBe(false);
    expect(guest.client.startPlayback(5)).toBe(false);
    expect(guest.client.openVote([])).toBe(false);
    expect(guest.client.castVote('o1')).toBe(true);
    expect(guest.socket.sent.slice(n)).toEqual([{ t: 'ready', ready: true, quality: '1080p' }, { t: 'status', status: 'searching' }, { t: 'vote', optionId: 'o1' }]);

    const host = await connect('alice', true);
    const h = host.socket.sent.length;
    expect(host.client.sendSettings({ waitLate: '10s', reactions: 'off' })).toBe(true);
    expect(host.client.sendSettings({})).toBe(false);
    expect(host.client.startPlayback(5)).toBe(true);
    expect(host.client.startPlayback(99)).toBe(true);
    expect(host.client.openVote([{ type: 'movie', tmdbId: 1, title: 'A' }, { type: 'series', tmdbId: 2, title: 'B' }])).toBe(true);
    expect(host.client.closeVote()).toBe(true);
    expect(host.socket.sent.slice(h)).toEqual([
      { t: 'settings', waitLate: '10s', reactions: 'off' }, { t: 'start', countdown: 5 }, { t: 'start', countdown: 10 },
      { t: 'vote_open', options: [{ type: 'movie', tmdbId: 1, title: 'A' }, { type: 'series', tmdbId: 2, title: 'B' }] }, { t: 'vote_close' },
    ]);
  });

  it('trames de plus de 4 Ko refusées (vote_open trop long)', () => {
    expect(encodeClientMessage({ t: 'vote_open', options: [{ type: 'movie', tmdbId: 1, title: 'é'.repeat(3000) }, { type: 'movie', tmdbId: 2, title: 'B' }] })).toBeNull();
  });
});

describe('modèle du salon d’attente', () => {
  it('état de préparation : prêt (qualité), recherche, tampon, invité, serveur antérieur', () => {
    expect(prepView({ ready: true, quality: '4K HDR', status: 'ready' })).toEqual({ state: 'ready', label: 'Prêt · 4K HDR' });
    expect(prepView({ ready: false, quality: null, status: 'searching' })).toEqual({ state: 'searching', label: 'Cherche une source…' });
    expect(prepView({ ready: false, quality: null, status: 'buffering' }).state).toBe('buffering');
    expect(prepView({ guest: true }).label).toBe('Prêt · via le lien');
    expect(prepView({}).state).toBe('ready');
  });

  it('résumé : « 3 prêts sur 4 », bouton « Démarrer sans Hugo »', () => {
    const list = [
      { username: 'Greg', ready: true, status: 'ready' as const }, { username: 'Léa', ready: true, status: 'ready' as const },
      { username: 'Hugo', ready: false, status: 'searching' as const }, { username: 'Julie', guest: true },
    ];
    const sum = readySummary(list);
    expect(sum).toEqual({ ready: 3, total: 4, waiting: ['Hugo'] });
    expect(readyText(sum)).toBe('3 prêts sur 4');
    expect(startWithoutText(sum.waiting)).toBe('Démarrer sans Hugo');
    expect(startWithoutText(['A', 'B'])).toBe('Démarrer sans 2 personnes');
    expect(readyText({ ready: 2, total: 2, waiting: [] })).toBe('Tout le monde est prêt');
  });

  it('compte à rebours, position du film, durée d’un saut', () => {
    expect(countdownLeft(10_000, 5_100)).toBe(5);
    expect(countdownLeft(10_000, 10_500)).toBe(0);
    expect(countdownLeft(null, 1)).toBeNull();
    expect(formatTimecode(4382)).toBe('1:13:02');
    expect(formatTimecode(75)).toBe('1:15');
    expect(formatDelta(-10)).toBe('10 s');
    expect(formatDelta(90)).toBe('1 min 30 s');
  });

  it('événements lisibles du salon', () => {
    expect(eventText({ kind: 'seek', by: 'Hugo', pos: 100, delta: -10 })).toBe('Hugo a reculé de 10 s');
    expect(eventText({ kind: 'seek', by: 'Hugo', pos: 100, delta: 30 })).toBe('Hugo a avancé de 30 s');
    expect(eventText({ kind: 'pause', by: 'Léa', pos: 4290 })).toBe('Léa a mis en pause · 1:11:30');
    expect(eventText({ kind: 'play', by: 'Léa', pos: 0 })).toBe('Léa a relancé la lecture');
    expect(eventText({ kind: 'join', by: 'Tom', pos: 0 })).toBe('Tom a rejoint le salon');
  });

  it('synchronisation, vote, qualité, initiales', () => {
    expect(syncText(0.24)).toEqual({ ok: true, text: 'Synchronisés · écart 0,2 s' });
    expect(syncText(null).text).toBe('Synchronisés');
    expect(syncText(-3).ok).toBe(false);
    const options = [{ votes: 3 }, { votes: 1 }];
    expect(voteShare(options[0], options)).toBe(75);
    expect(voteShare({ votes: 0 }, [{ votes: 0 }])).toBe(0);
    expect(qualityLabel({ quality: '4K', hdr: ['HDR10'] })).toBe('4K HDR10');
    expect(qualityLabel(null)).toBe('');
    expect(initialsOf('julie', true)).toBe('JU');
    expect(initialsOf('greg')).toBe('G');
  });
});
