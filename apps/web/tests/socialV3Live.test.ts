// Canal temps réel du Social v3 : lecture des nouveaux événements (saisie, réactions, sondages, listes, demandes de
// rejoindre, réponses, invitations, activité), rejet des formes incomplètes, et émission vers l'écouteur du canal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocialLive, parseLiveEvent, type LiveEvent, type LiveSocket } from '../src/data/socialLive';

const friend = { pid: 'p2', handle: { name: 'Zoe', tag: '2345', full: 'Zoe#2345' }, avatarColor: '#a00', household: false, status: 'online' };

describe('parseLiveEvent (v3)', () => {
  it('reconnaît saisie, réaction, sondage, liste, demande de rejoindre, réponse, invitation et activité', () => {
    expect(parseLiveEvent({ t: 'typing', conv: 'g:G1', pid: 'p2' })).toEqual({ t: 'typing', conv: 'g:G1', pid: 'p2' });
    expect(parseLiveEvent({ t: 'reaction', conv: 'dm:p2', id: 'm1', reactions: [{ emoji: '🔥', count: 1, mine: false }] }))
      .toEqual({ t: 'reaction', conv: 'dm:p2', id: 'm1', reactions: [{ emoji: '🔥', count: 1, mine: false }] });
    const poll = { id: 'P1', question: 'Q ?', options: [], closed: false };
    expect(parseLiveEvent({ t: 'poll', conv: 'g:G1', poll })).toEqual({ t: 'poll', conv: 'g:G1', poll });
    expect(parseLiveEvent({ t: 'list', listId: 'L1' })).toEqual({ t: 'list', listId: 'L1' });
    expect(parseLiveEvent({ t: 'join_request', from: friend })).toEqual({ t: 'join_request', from: friend });
    expect(parseLiveEvent({ t: 'join_answer', pid: 'p2', accept: true, partyId: 'pty1' }))
      .toEqual({ t: 'join_answer', pid: 'p2', accept: true, partyId: 'pty1' });
    expect(parseLiveEvent({ t: 'join_answer', pid: 'p2', accept: false })).toEqual({ t: 'join_answer', pid: 'p2', accept: false });
    expect(parseLiveEvent({ t: 'party_invite', from: friend, partyId: 'pty2', title: 'Dune' }))
      .toEqual({ t: 'party_invite', from: friend, partyId: 'pty2', title: 'Dune' });
    const item = { id: 'a1', pid: 'p2', handle: friend.handle, avatarColor: '#a00', kind: 'started', media: { type: 'movie', tmdbId: 603, title: 'Matrix' }, at: 5 };
    expect(parseLiveEvent({ t: 'activity', item })).toEqual({ t: 'activity', item });
  });

  it('message v3 : reconnu avec ses champs riches (conv, kind, reactions)', () => {
    const message = { id: 'm9', from: 'p2', to: 'me', body: 'salut', createdAt: 1, conv: 'dm:p2', kind: 'text', reactions: [] };
    expect(parseLiveEvent({ t: 'message', message })).toEqual({ t: 'message', message });
  });

  it('rejette les formes incomplètes ou mal typées', () => {
    expect(parseLiveEvent({ t: 'typing', conv: 'g:G1' })).toBeNull();
    expect(parseLiveEvent({ t: 'reaction', conv: 'g:G1', id: 'm1', reactions: 'x' })).toBeNull();
    expect(parseLiveEvent({ t: 'poll', conv: 'g:G1', poll: { question: 'sans id' } })).toBeNull();
    expect(parseLiveEvent({ t: 'list' })).toBeNull();
    expect(parseLiveEvent({ t: 'join_request', from: { handle: friend.handle } })).toBeNull();
    expect(parseLiveEvent({ t: 'join_answer', pid: 'p2', accept: 'oui' })).toBeNull();
    expect(parseLiveEvent({ t: 'party_invite', from: friend, partyId: 'pty2' })).toBeNull();
    expect(parseLiveEvent({ t: 'activity', item: 'a1' })).toBeNull();
  });
});

describe('createSocialLive : événements v3 émis vers l’écouteur', () => {
  let sockets: FakeSocket[];
  let events: LiveEvent[];

  class FakeSocket implements LiveSocket {
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    constructor(public url: string) {}
    send(): void { /* sans effet */ }
    close(): void { /* sans effet */ }
    open(): void { this.onopen?.(); }
    emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('chaque trame v3 reconnue arrive à l’écouteur, les trames inconnues sont ignorées', async () => {
    const live = createSocialLive({
      createTicket: async () => ({ wsPath: '/user/social/live?ticket=T' }),
      baseUrl: () => 'http://localhost:7000',
      openSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      poll: async () => undefined,
      onEvent: (e) => { events.push(e); },
    });
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].emit({ t: 'typing', conv: 'dm:p2', pid: 'p2' });
    sockets[0].emit({ t: 'inconnu' });
    sockets[0].emit({ t: 'list', listId: 'L9' });
    expect(events).toEqual([{ t: 'typing', conv: 'dm:p2', pid: 'p2' }, { t: 'list', listId: 'L9' }]);
    live.stop();
  });
});
