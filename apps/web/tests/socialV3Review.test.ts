// Retours de relecture Social v3 : drapeau du salon d'attente, validateur d'images, capacités v3 du serveur, mode cinéma.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { PartyClient, type SocketLike } from '../src/party/client';
import { partyErrorText } from '../src/party/protocol';
import { cssUrl, safeTmdbImage } from '../src/ui/safeImg.js';
import { posterSrc as fmtPoster } from '../src/ui/socialFmt.js';
import { posterSrc, stillSrc } from '../src/ui/socialConvDom.js';
import { cinemaEndsOnTeardown } from '../src/player/playbackSocial';

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

const ROOM = { id: 'r1', visibility: 'private', title: 'Dune', poster: null, language: 'fr', media: { type: 'movie', tmdbId: 1 }, fingerprint: null, host: 'alice', participants: 2, maxParticipants: 20, createdAt: '2026-01-01T00:00:00Z' };
const welcome = (over: Record<string, unknown> = {}) => ({
  t: 'welcome', you: { username: 'bob', host: false, muted: false }, room: ROOM, state: { playing: false, pos: 0, at: 1000, rev: 1 }, serverTime: 1000,
  participants: [{ username: 'alice', host: true }, { username: 'bob' }], chat: [], ...over,
});

describe('images : validateur commun', () => {
  it('accepte une URL TMDB ou un chemin converti, refuse le reste', () => {
    expect(safeTmdbImage('https://image.tmdb.org/t/p/w500/abc.jpg')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(safeTmdbImage('/abc.jpg', 'w185')).toBe('https://image.tmdb.org/t/p/w185/abc.jpg');
    const bad = ['https://evil.example/a.jpg', 'http://image.tmdb.org/t/p/w500/a.jpg', 'https://image.tmdb.org/t/p/w500/a.jpg?x=1',
      'https://image.tmdb.org/t/p/w500/a")x.jpg', '/a/b.jpg', '//evil.example/a.jpg', '/a.jpg"),url(x', 'javascript:alert(1)', '', null, undefined, 4];
    for (const b of bad) expect(safeTmdbImage(b as never)).toBeNull();
  });
  it('affiches et scènes passent par lui', () => {
    for (const f of [posterSrc, fmtPoster]) {
      expect(f('/p.jpg')).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
      expect(f('https://evil.example/p.jpg')).toBe('');
    }
    expect(stillSrc('/s.jpg')).toBe('https://image.tmdb.org/t/p/w500/s.jpg');
    expect(stillSrc('https://evil.example/s.jpg')).toBe('');
  });
  it('cssUrl : seulement une URL validée', () => {
    expect(cssUrl('https://image.tmdb.org/t/p/w780/b.jpg')).toBe('url("https://image.tmdb.org/t/p/w780/b.jpg")');
    expect(cssUrl('https://evil.example/b.jpg')).toBe('');
    expect(cssUrl('x") ,url(y')).toBe('');
  });
});

describe('capacités v3 du serveur', () => {
  async function connect(over: Record<string, unknown> = {}) {
    const sockets: FakeSocket[] = [];
    const client = new PartyClient({ connect: async () => { const s = new FakeSocket(); sockets.push(s); return s; } });
    client.start();
    await new Promise((r) => setTimeout(r, 0));
    sockets[0].open();
    sockets[0].recv(welcome(over));
    return { client, socket: sockets[0] };
  }
  it('sans `settings` dans le welcome : ni ready ni status', async () => {
    const { client, socket } = await connect();
    const n = socket.sent.length;
    expect(client.v3).toBe(false);
    expect(client.sendReady(true, '1080p')).toBe(false);
    expect(client.sendStatus('ready')).toBe(false);
    expect(socket.sent.length).toBe(n);
  });
  it('avec `settings` : envoyés', async () => {
    const { client, socket } = await connect({ settings: { control: 'all', waitLate: '10s', reactions: 'float' } });
    expect(client.v3).toBe(true);
    expect(client.sendReady(true, null)).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ t: 'ready', ready: true, quality: null });
  });
  it('erreur de code inconnu : ignorée sans message', () => {
    expect(partyErrorText('unknown_type')).toBe('');
    expect(partyErrorText('not_host')).not.toBe('');
  });
});

describe('salon d’attente : drapeau lobby', () => {
  beforeEach(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
    reloadSettings();
  });
  it('posé après connect(), un `media` reçu ne lance pas le lecteur', async () => {
    const sockets: FakeSocket[] = [];
    vi.stubGlobal('WebSocket', function () { const s = new FakeSocket(); sockets.push(s); return s; });
    vi.resetModules();
    vi.doMock('../src/data/socialApi', async (orig) => ({
      ...(await orig<typeof import('../src/data/socialApi')>()),
      joinParty: async () => ({ ticket: 't', expiresAt: '', wsPath: '/ws', room: ROOM }),
    }));
    const { partyBridge } = await import('../src/party/bridge');
    const launcher = vi.fn(async () => undefined);
    partyBridge.launcher = launcher as never;
    await partyBridge.connect('r1', 'p1', true);
    expect(partyBridge.lobby).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    sockets[0].open();
    sockets[0].recv(welcome({ settings: {} }));
    sockets[0].recv({ t: 'media', media: { type: 'movie', tmdbId: 2 }, fingerprint: null, state: { playing: false, pos: 0, at: 1, rev: 2 }, serverTime: 1 });
    expect(launcher).not.toHaveBeenCalled();
    partyBridge.leave();
    expect(partyBridge.lobby).toBe(false);
    vi.doUnmock('../src/data/socialApi');
    vi.unstubAllGlobals();
  });
});

describe('mode cinéma au démontage du lecteur', () => {
  it('survit au changement d’épisode (silent), levé à la fermeture réelle', () => {
    expect(cinemaEndsOnTeardown(true, true)).toBe(false);
    expect(cinemaEndsOnTeardown(false, true)).toBe(true);
    expect(cinemaEndsOnTeardown(false, false)).toBe(false);
  });
});
