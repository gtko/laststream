// Watch party : synchronisation (fonctions pures), client de protocole (messages, reconnexion), contrôleur (l'hôte seul pilote),
// choix de la version par empreinte, profils enfants.
import { describe, expect, it, vi } from 'vitest';
import { PartyClient, BACKOFF_MS, PONG_TIMEOUT_MS, type SocketLike } from '../src/party/client';
import { canBrowsePublicParties, canJoinRoom, partyVisibilityChoices, requestOfRoom, roomBodyOf, socketUrl, type SessionAdapter } from '../src/party/bridge';
import { PartyController, HOST_SYNC_EVERY_MS, type PlayerLike } from '../src/party/controller';
import { fingerprintOf, matchScore, nameSimilarity, pickByFingerprint } from '../src/party/fingerprint';
import { encodeClientMessage, parseServerMessage } from '../src/party/protocol';
import { ClockEstimator, driftAction, estimateOffset, expectedPosition } from '../src/party/sync';
import type { PartyRoom } from '../src/data/socialApi';

// ---------- Synchronisation ----------
describe('horloge et position attendue', () => {
  it('position attendue : fixe en pause, avance avec l’horloge serveur en lecture', () => {
    expect(expectedPosition({ playing: false, pos: 120, at: 1000 }, 99999)).toBe(120);
    expect(expectedPosition({ playing: true, pos: 120, at: 1000 }, 4500)).toBeCloseTo(123.5);
    expect(expectedPosition({ playing: true, pos: 10, at: 5000 }, 4000)).toBe(10); // horloge en retard : jamais en arrière
  });

  it('décalage d’horloge : milieu de l’aller-retour ; garde le plus petit aller-retour', () => {
    expect(estimateOffset(1000, 1100, 6050)).toBe(5000);
    const c = new ClockEstimator();
    c.add(1000, 1400, 6300); // aller-retour 400 ms, offset 4900
    c.add(2000, 2060, 7030); // aller-retour 60 ms, offset 5000
    c.add(3000, 3300, 8100); // aller-retour 300 ms : ignoré
    expect(c.offset).toBe(5000);
    expect(c.rtt).toBe(60);
  });
});

describe('correction de dérive', () => {
  it('sous 0,5 s : rien', () => {
    expect(driftAction(100.3, 100, true)).toEqual({ kind: 'none' });
    expect(driftAction(99.7, 100, true)).toEqual({ kind: 'none' });
  });
  it('entre 0,5 s et 2 s : vitesse 0,95 (en avance) ou 1,05 (en retard)', () => {
    expect(driftAction(101, 100, true)).toEqual({ kind: 'rate', rate: 0.95 });
    expect(driftAction(99, 100, true)).toEqual({ kind: 'rate', rate: 1.05 });
  });
  it('à partir de 2 s : saut à la position attendue', () => {
    expect(driftAction(97, 100, true)).toEqual({ kind: 'seek', to: 100 });
    expect(driftAction(103, 100, true)).toEqual({ kind: 'seek', to: 100 });
  });
  it('à l’arrêt : tout écart de 0,5 s fait sauter', () => {
    expect(driftAction(100.6, 100, false)).toEqual({ kind: 'seek', to: 100 });
    expect(driftAction(100.2, 100, false)).toEqual({ kind: 'none' });
  });
  it('hystérésis : une vitesse corrective se poursuit jusqu’à 0,15 s', () => {
    expect(driftAction(100.3, 100, true, { correcting: true })).toEqual({ kind: 'rate', rate: 0.95 });
    expect(driftAction(100.1, 100, true, { correcting: true })).toEqual({ kind: 'none' });
  });
  it('sans vitesse réglable : saut dès 1 s, rien en dessous', () => {
    expect(driftAction(100.8, 100, true, { canRate: false })).toEqual({ kind: 'none' });
    expect(driftAction(101.2, 100, true, { canRate: false })).toEqual({ kind: 'seek', to: 100 });
  });
});

// ---------- Protocole ----------
describe('messages', () => {
  it('lit les messages serveur connus, ignore le reste', () => {
    expect(parseServerMessage('{"t":"pong","c":1,"s":2}')).toEqual({ t: 'pong', c: 1, s: 2 });
    expect(parseServerMessage('{"t":"inconnu"}')).toBeNull();
    expect(parseServerMessage('pas du json')).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
  it('refuse d’envoyer une trame de plus de 4 Ko', () => {
    expect(encodeClientMessage({ t: 'chat', text: 'salut' })).toBe('{"t":"chat","text":"salut"}');
    expect(encodeClientMessage({ t: 'chat', text: 'é'.repeat(3000) })).toBeNull();
  });
});

// ---------- Client (faux socket et minuteurs) ----------
class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed: number | undefined;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number) { this.closed = code ?? 1000; }
  open() { this.onopen?.(); }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

const ROOM = (over: Partial<PartyRoom> = {}): PartyRoom => ({
  id: 'r1', visibility: 'private', title: 'Severance', poster: '/s.jpg', language: 'fr', media: { type: 'series', tmdbId: 95396, season: 1, episode: 1 },
  fingerprint: { fileName: 'Severance.S01E01.1080p.mkv', size: 3_000_000_000 }, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01T00:00:00Z', ...over,
});
const welcome = (me: string, host: boolean, over: Record<string, unknown> = {}) => ({
  t: 'welcome', you: { username: me, host, muted: false }, room: ROOM(), state: { playing: false, pos: 0, at: 1000, rev: 1 }, serverTime: 1000,
  participants: [{ username: 'alice', host: true }, { username: 'bob', host: false }], chat: [{ id: 'm1', from: 'alice', text: 'hello', at: 1 }], ...over,
});

/** Minuteurs manuels : on avance le temps à la main. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function setup(me = 'bob', host = false, clock?: () => number) {
  const timers = fakeTimers();
  const sockets: FakeSocket[] = [];
  let connects = 0;
  const client = new PartyClient({
    connect: async () => { connects += 1; const s = new FakeSocket(); sockets.push(s); return s; },
    now: clock ?? timers.now, setTimer: timers.set, clearTimer: timers.clear,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { client, timers, sockets, flush, connects: () => connects, me, host };
}

describe('client du salon', () => {
  it('se connecte, reçoit welcome (état, participants, chat) et estime l’horloge serveur', async () => {
    const { client, sockets, flush, timers } = setup();
    client.start();
    await flush();
    sockets[0].open();
    expect(client.status).toBe('open');
    sockets[0].recv(welcome('bob', false));
    expect(client.you).toEqual({ username: 'bob', host: false, muted: false });
    expect(client.participants).toHaveLength(2);
    expect(client.chat.map((l) => l.text)).toEqual(['hello']);
    expect(client.state).toMatchObject({ playing: false, pos: 0 });
    // Rafale de pings : le serveur est 5000 ms en avance, aller-retour de 40 ms.
    timers.advance(10);
    const ping = sockets[0].sent.find((m) => m.t === 'ping');
    expect(ping).toBeTruthy();
    timers.advance(20);
    sockets[0].recv({ t: 'pong', c: ping.c, s: ping.c + 20 + 5000 });
    expect(client.clock.offset).toBeCloseTo(5000 + 20 - 15, 5); // s - (t0 + t1) / 2 avec t1 = 30
    expect(client.serverNow()).toBe(timers.now() + client.clock.offset);
  });

  it('applique state, media (changement d’épisode), chat sans doublon, réactions, muet, hôte', async () => {
    const { client, sockets, flush } = setup();
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    const seen: string[] = [];
    client.on('state', (s) => seen.push('state:' + s.pos));
    client.on('media', (m) => seen.push('media:' + m.media.episode));
    client.on('react', (r) => seen.push('react:' + r.emoji));
    sockets[0].recv({ t: 'state', state: { playing: true, pos: 12, at: 2000, rev: 2 }, serverTime: 2000 });
    sockets[0].recv({ t: 'media', media: { type: 'series', tmdbId: 95396, season: 1, episode: 2 }, fingerprint: { fileName: 'E02.mkv' }, state: { playing: false, pos: 0, at: 3000 }, serverTime: 3000 });
    sockets[0].recv({ t: 'chat', line: { id: 'm2', from: 'alice', text: 'yo', at: 2 } });
    sockets[0].recv({ t: 'chat', line: { id: 'm2', from: 'alice', text: 'yo', at: 2 } });
    sockets[0].recv({ t: 'react', user: 'alice', emoji: '🔥', at: 3 });
    sockets[0].recv({ t: 'muted', user: 'bob', muted: true });
    sockets[0].recv({ t: 'host', user: 'bob' });
    expect(seen).toContain('state:12');
    expect(seen).toContain('media:2');
    expect(seen).toContain('react:🔥');
    expect(client.room?.media.episode).toBe(2);
    expect(client.room?.fingerprint).toEqual({ fileName: 'E02.mkv' });
    expect(client.chat.filter((l) => l.id === 'm2')).toHaveLength(1);
    expect(client.you).toEqual({ username: 'bob', host: true, muted: true });
  });

  it('seul l’hôte envoie ctl / episode / kick / mute ; tous peuvent écrire, réagir et signaler', async () => {
    const { client, sockets, flush } = setup();
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    const before = sockets[0].sent.length;
    expect(client.control('play', 10)).toBe(false);
    expect(client.changeEpisode(1, 2)).toBe(false);
    expect(client.kick('alice')).toBe(false);
    expect(client.mute('alice', true)).toBe(false);
    expect(sockets[0].sent.length).toBe(before);
    expect(client.sendChat('  salut  ')).toBe(true);
    expect(client.sendChat('   ')).toBe(false);
    expect(client.react('👍')).toBe(true);
    expect(client.report('m1', 'spam')).toBe(true);
    expect(sockets[0].sent.slice(before)).toEqual([{ t: 'chat', text: 'salut' }, { t: 'react', emoji: '👍' }, { t: 'report', messageId: 'm1', reason: 'spam' }]);
    sockets[0].recv({ t: 'host', user: 'bob' });
    expect(client.control('seek', 61.23456)).toBe(true);
    expect(client.changeEpisode(1, 3, { fileName: 'x.mkv' })).toBe(true);
    expect(client.kick('alice')).toBe(true);
    expect(sockets[0].sent.slice(-3)).toEqual([{ t: 'ctl', action: 'seek', pos: 61.235 }, { t: 'episode', season: 1, episode: 3, fingerprint: { fileName: 'x.mkv' } }, { t: 'kick', user: 'alice' }]);
  });

  it('reconnexion automatique avec reprise : nouveau ticket, welcome, état et chat refaits', async () => {
    const { client, sockets, flush, timers, connects } = setup();
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    sockets[0].drop(1006); // coupure réseau
    expect(client.status).toBe('reconnecting');
    expect(connects()).toBe(1);
    timers.advance(BACKOFF_MS[0] + 1);
    await flush();
    expect(connects()).toBe(2);
    sockets[1].open();
    sockets[1].recv(welcome('bob', false, { state: { playing: true, pos: 500, at: 9000 }, chat: [{ id: 'm9', from: 'alice', text: 'de retour', at: 9 }] }));
    expect(client.status).toBe('open');
    expect(client.resumes).toBe(1);
    expect(client.state).toMatchObject({ playing: true, pos: 500 });
    expect(client.chat.map((l) => l.id)).toEqual(['m9']);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  it('le délai de reconnexion augmente puis plafonne, et un échec de connexion est retenté', async () => {
    const timers = fakeTimers();
    let n = 0;
    const client = new PartyClient({
      connect: async () => { n += 1; throw new Error('ticket refusé'); },
      now: timers.now, setTimer: timers.set, clearTimer: timers.clear,
    });
    client.start();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    await flush();
    expect(n).toBe(1);
    for (let i = 0; i < BACKOFF_MS.length + 1; i++) {
      const wait = BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
      timers.advance(wait - 1);
      await flush();
      expect(n).toBe(1 + i); // pas encore
      timers.advance(2);
      await flush();
      expect(n).toBe(2 + i);
    }
    client.close();
  });

  it('pas de reconnexion après exclusion (4003), fin du salon (4000) ou remplacement (4009)', async () => {
    for (const [code, why] of [[4003, 'kicked'], [4000, 'ended'], [4009, 'replaced']] as const) {
      const { client, sockets, flush, timers, connects } = setup();
      const ends: string[] = [];
      client.on('end', (r) => ends.push(r));
      client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
      sockets[0].drop(code);
      timers.advance(60_000);
      await flush();
      expect(ends).toEqual([why]);
      expect(client.status).toBe('closed');
      expect(connects()).toBe(1);
    }
  });

  it('message ended : le salon est terminé, sans reconnexion', async () => {
    const { client, sockets, flush, timers, connects } = setup();
    const ends: string[] = [];
    client.on('end', (r) => ends.push(r));
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    sockets[0].recv({ t: 'ended', reason: 'host_ended' });
    sockets[0].drop(4000);
    timers.advance(60_000);
    expect(ends).toEqual(['ended']);
    expect(connects()).toBe(1);
  });

  it('une connexion muette (pas de pong) est relancée', async () => {
    const { client, sockets, flush, timers, connects } = setup();
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    timers.advance(1); // premier ping parti, aucune réponse
    timers.advance(PONG_TIMEOUT_MS + 1);
    expect(sockets[0].closed).toBeDefined();
    expect(client.status).toBe('reconnecting');
    timers.advance(BACKOFF_MS[0] + 1);
    await flush();
    expect(connects()).toBe(2);
  });

  it('close() quitte sans reconnecter', async () => {
    const { client, sockets, flush, timers, connects } = setup();
    client.start(); await flush(); sockets[0].open(); sockets[0].recv(welcome('bob', false));
    client.close();
    sockets[0].drop(1000);
    timers.advance(60_000);
    expect(connects()).toBe(1);
    expect(client.status).toBe('closed');
  });
});

// ---------- Contrôleur ----------
class FakePlayer implements PlayerLike {
  t = 0; paused_ = true; rate_ = 1; buf = false; dur = 3600; canRate = true; isReady = true;
  calls: string[] = [];
  ready() { return this.isReady; }
  time() { return this.t; }
  duration() { return this.dur; }
  paused() { return this.paused_; }
  buffering() { return this.buf; }
  rate() { return this.rate_; }
  play() { this.paused_ = false; this.calls.push('play'); }
  pause() { this.paused_ = true; this.calls.push('pause'); }
  seek(to: number) { this.t = to; this.calls.push('seek:' + to.toFixed(1)); }
  setRate(r: number) { this.rate_ = r; this.calls.push('rate:' + r); }
}

async function room(host: boolean, state = { playing: false, pos: 0, at: 0 }) {
  let now = 100_000;
  const s = setup(host ? 'alice' : 'bob', host, () => now);
  s.client.start(); await s.flush(); s.sockets[0].open();
  s.sockets[0].recv(welcome(host ? 'alice' : 'bob', host, { state }));
  const ctl = new PartyController(s.client, () => now);
  // Horloge serveur = horloge locale + 0 (offset nul) : `at` en ms locales.
  return { ...s, ctl, setNow: (n: number) => { now = n; }, getNow: () => now, sent: () => s.sockets[0].sent.filter((m) => m.t === 'ctl' || m.t === 'episode') };
}

describe('contrôleur : l’hôte pilote', () => {
  it('envoie play, pause, seek puis des rapports de position toutes les ~5 s', async () => {
    const r = await room(true);
    const p = new FakePlayer();
    p.paused_ = true;
    r.ctl.tick(p); // première mesure : salon en pause, lecteur en pause -> rien
    expect(r.sent()).toEqual([]);
    p.paused_ = false; p.t = 3; r.setNow(100_100); r.ctl.tick(p);
    expect(r.sent().at(-1)).toMatchObject({ action: 'play', pos: 3 });
    p.t = 8; r.setNow(100_100 + HOST_SYNC_EVERY_MS + 100); r.ctl.tick(p);
    expect(r.sent().at(-1)).toMatchObject({ action: 'sync' });
    p.t = 600; r.setNow(r.getNow() + 100); r.ctl.tick(p); // grand saut vers l'avant
    expect(r.sent().at(-1)).toMatchObject({ action: 'seek', pos: 600 });
    p.paused_ = true; r.setNow(r.getNow() + 100); r.ctl.tick(p);
    expect(r.sent().at(-1)).toMatchObject({ action: 'pause', pos: 600 });
  });

  it('aligne le salon sur le lecteur de l’hôte dès la première mesure', async () => {
    const r = await room(true, { playing: false, pos: 0, at: 0 });
    const p = new FakePlayer();
    p.paused_ = false; p.t = 42;
    r.ctl.tick(p);
    expect(r.sent()).toEqual([{ t: 'ctl', action: 'play', pos: 42 }]);
  });

  it('un lecteur pas prêt ou en chargement ne déclenche rien', async () => {
    const r = await room(true);
    const p = new FakePlayer();
    p.isReady = false;
    r.ctl.tick(p);
    p.isReady = true; p.paused_ = false; p.t = 5;
    r.ctl.tick(p); // première mesure
    p.buf = true; p.t = 5; r.setNow(r.getNow() + 3000); r.ctl.tick(p);
    expect(r.sent().filter((m) => m.action === 'seek')).toEqual([]);
  });
});

describe('contrôleur : l’invité suit, sans jamais piloter', () => {
  it('n’envoie aucune commande de lecture, même si son lecteur bouge', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.paused_ = false; p.t = 0;
    r.ctl.tick(p);
    p.paused_ = true; p.t = 500; r.setNow(r.getNow() + 2000); r.ctl.tick(p);
    expect(r.sent()).toEqual([]);
  });

  it('se cale sur la position de l’hôte : saut si grand écart, lecture si le salon joue', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.t = 0; p.paused_ = true;
    r.setNow(102_000); // le salon est à 102 s
    r.ctl.tick(p);
    expect(p.calls).toContain('play');
    expect(p.calls).toContain('seek:102.0');
  });

  it('petit écart : vitesse corrective, puis retour à 1 quand c’est rattrapé', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.paused_ = false;
    r.setNow(101_000); // attendu 101 s
    p.t = 100.2; // 0,8 s de retard
    r.ctl.tick(p);
    expect(p.calls).toEqual(['rate:1.05']);
    r.setNow(103_000); p.t = 102.9; // presque rattrapé (attendu 103)
    r.ctl.tick(p);
    expect(p.calls).toEqual(['rate:1.05', 'rate:1']);
    expect(p.rate_).toBe(1);
  });

  it('écart sous 0,5 s : on ne touche à rien', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.paused_ = false; p.t = 100.4;
    r.setNow(100_000);
    r.ctl.tick(p);
    expect(p.calls).toEqual([]);
  });

  it('salon en pause : l’invité s’arrête et se cale', async () => {
    const r = await room(false, { playing: false, pos: 250, at: 90_000 });
    const p = new FakePlayer();
    p.paused_ = false; p.t = 10;
    r.ctl.tick(p);
    expect(p.calls).toEqual(['pause', 'seek:250.0']);
  });

  it('sans vitesse réglable (libVLC), un retard d’une seconde est corrigé par un saut', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.canRate = false; p.paused_ = false; p.t = 99.7;
    r.setNow(100_000);
    r.ctl.tick(p);
    expect(p.calls).toEqual([]); // 0,3 s : toléré
    r.setNow(101_000); p.t = 99.7; // attendu 101 : 1,3 s de retard
    r.ctl.tick(p);
    expect(p.calls).toEqual(['seek:101.0']);
  });

  it('attend la fin d’un saut avant de re-mesurer, et ne corrige pas pendant un chargement', async () => {
    const r = await room(false, { playing: true, pos: 100, at: 100_000 });
    const p = new FakePlayer();
    p.paused_ = false; p.t = 0;
    r.ctl.tick(p);
    expect(p.calls).toEqual(['seek:100.0']);
    p.t = 0; r.setNow(r.getNow() + 600); r.ctl.tick(p); // trop tôt : le saut se termine
    expect(p.calls).toHaveLength(1);
    p.buf = true; r.setNow(r.getNow() + 3000); r.ctl.tick(p);
    expect(p.calls).toHaveLength(1);
  });
});

// ---------- Empreinte et choix de version ----------
describe('choix de la version par empreinte', () => {
  const src = (filename: string, sizeBytes: number, extra: Record<string, unknown> = {}) => ({ filename, sizeBytes, playable: true, stream: { infoHash: extra.hash as string | undefined }, ...extra });
  const host = { fileName: 'Severance.S01E01.1080p.WEB-DL.DDP5.1.x264-NTb.mkv', size: 3_100_000_000 };

  it('l’empreinte reprend nom, taille et hash, sans aucun lien', () => {
    const fp = fingerprintOf({ filename: 'a.mkv', sizeBytes: 5, playable: true, stream: { infoHash: 'ABCDEF', behaviorHints: { videoSize: 9 } } });
    expect(fp).toEqual({ fileName: 'a.mkv', size: 5, hash: 'abcdef' });
    expect(fingerprintOf({ filename: '', sizeBytes: 0, stream: {} })).toBeNull();
    expect(JSON.stringify(fp)).not.toMatch(/https?:/);
  });

  it('même hash : version identique, toujours choisie', () => {
    const views = [src('Autre.mkv', 1, { hash: 'zzz' }), src('Severance.1080p.mkv', 123, { hash: 'abc' })];
    expect(pickByFingerprint(views, { hash: 'abc' })).toBe(views[1]);
  });

  it('même nom de fichier : la bonne version malgré un meilleur classement des autres', () => {
    const views = [
      src('Severance.S01E01.2160p.UHD.REMUX.mkv', 60_000_000_000),
      src('Severance.S01E01.1080p.WEB-DL.DDP5.1.x264-NTb.mkv', 3_100_000_000),
      src('Severance.S01E01.720p.HDTV.mkv', 1_200_000_000),
    ];
    expect(pickByFingerprint(views, host)).toBe(views[1]);
  });

  it('nom proche et taille à moins de 1 % : acceptée ; sinon aucune correspondance (meilleure source habituelle)', () => {
    const near = src('severance s01e01 1080p web-dl ddp5 1 x264 ntb.mp4', 3_110_000_000);
    expect(pickByFingerprint([near], host)).toBe(near);
    const far = src('Autre.film.2020.mkv', 3_100_000_000);
    expect(pickByFingerprint([far], host)).toBeNull(); // la taille seule ne suffit pas
    expect(pickByFingerprint([src('x.mkv', 1)], null)).toBeNull();
  });

  it('ignore les sources non lisibles et garde la première à égalité', () => {
    const a = { ...src(host.fileName, host.size), playable: false };
    const b = src(host.fileName, host.size);
    const c = src(host.fileName, host.size);
    expect(pickByFingerprint([a, b, c], host)).toBe(b);
  });

  it('similarité de noms et score', () => {
    expect(nameSimilarity('A.B.C.mkv', 'a b c')).toBe(1);
    expect(nameSimilarity('abc', 'xyz')).toBe(0);
    expect(matchScore(src('Z.mkv', 1), host)).toBe(0);
  });
});

// ---------- Profils enfants et construction des salons ----------
describe('profil enfant et lien du salon', () => {
  it('un enfant n’accède pas aux salons publics et ne crée que des salons privés', () => {
    expect(canBrowsePublicParties(true)).toBe(false);
    expect(canBrowsePublicParties(false)).toBe(true);
    expect(partyVisibilityChoices(true)).toEqual(['private']);
    expect(partyVisibilityChoices(false)).toEqual(['private', 'public']);
    expect(canJoinRoom({ visibility: 'public' }, true)).toBe(false);
    expect(canJoinRoom({ visibility: 'private' }, true)).toBe(true);
    expect(canJoinRoom({ visibility: 'public' }, false)).toBe(true);
  });

  it('adresse WebSocket : relative au serveur (https -> wss, http -> ws)', () => {
    expect(socketUrl('https://laststream.gtux-prog.workers.dev', '/party/r1/ws?ticket=T')).toBe('wss://laststream.gtux-prog.workers.dev/party/r1/ws?ticket=T');
    expect(socketUrl('http://localhost:7000/', '/party/r1/ws?ticket=T')).toBe('ws://localhost:7000/party/r1/ws?ticket=T');
  });

  it('salon -> cible de lecture ; lecture en cours -> corps de création (sans lien de lecture)', () => {
    expect(requestOfRoom(ROOM())).toEqual({ type: 'tv', id: '95396', name: 'Severance', season: 1, episode: 1, key: 'tv:95396' });
    expect(requestOfRoom(ROOM({ media: { type: 'movie', tmdbId: 550 } }))).toMatchObject({ type: 'movie', season: null, episode: null, key: 'movie:550' });
    expect(requestOfRoom(ROOM({ media: { type: 'movie', imdbId: 'tt1' } }))).toBeNull();
    const a = {
      req: { type: 'tv', id: '95396', name: 'Severance', season: 1, episode: 2, key: 'tv:95396' }, cur: { season: 1, episode: 2 },
      view: { filename: 'S01E02.mkv', sizeBytes: 123, playable: true, stream: { url: 'https://debrid.example/secret' } }, poster: '/s.jpg', engine: null, ready: true,
    } as unknown as SessionAdapter;
    const body = roomBodyOf(a, 'public', 'p1', 'fr');
    expect(body).toMatchObject({ profileId: 'p1', visibility: 'public', title: 'Severance', poster: '/s.jpg', language: 'fr', media: { type: 'series', tmdbId: 95396, season: 1, episode: 2 }, fingerprint: { fileName: 'S01E02.mkv', size: 123 } });
    expect(JSON.stringify(body)).not.toContain('debrid.example');
  });
});

describe('profil enfant : routes', () => {
  it('#/friends, #/friend/x et #/parties ne sont pas des routes ; un salon privé s’ouvre par son lien', async () => {
    vi.resetModules();
    vi.doMock('../src/data/auth', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/data/auth')>();
      return { ...real, isKidProfile: () => true };
    });
    const html = (await import('node:fs')).readFileSync((await import('node:path')).resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    const { parseRoute } = await import('../src/ui/router.js');
    for (const h of ['#/friends', '#/friend/alice', '#/parties']) { location.hash = h; expect(parseRoute()).toBeNull(); }
    location.hash = '#/party/abc_123';
    expect(parseRoute()).toEqual({ kind: 'party', id: 'abc_123' });
    vi.doUnmock('../src/data/auth');
  });
});
