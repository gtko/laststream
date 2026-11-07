// Canal temps réel du Social v2 : URL, ping, pong, reconnexion avec backoff, repli polling, arrêt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay, createSocialLive, LIVE_REPLACED_CODE, parseLiveEvent, PING_EVERY_MS, PONG_TIMEOUT_MS, POLL_EVERY_MS, socketUrl, ticketRetryDelay,
  type LiveEvent, type LiveSocket, type LiveStatus,
} from '../src/data/socialLive';

class FakeSocket implements LiveSocket {
  sent: string[] = [];
  closed: Array<number | undefined> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(public url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(code?: number): void { this.closed.push(code); }
  open(): void { this.onopen?.(); }
  emit(data: unknown): void { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  drop(): void { this.onclose?.({ code: 1006 }); }
  /** Fermeture par le serveur : connexion remplacée par une autre du même profil. */
  replace(): void { this.onclose?.({ code: LIVE_REPLACED_CODE }); }
}

let sockets: FakeSocket[];
let tickets: number;
let polls: number;
let events: LiveEvent[];
let statuses: LiveStatus[];
let ticketResult: () => Promise<{ wsPath: string }>;
/** Retour au premier plan simulé : la dernière fonction abonnée (null une fois désinscrite). */
let foreground: (() => void) | null;

const flush = () => vi.advanceTimersByTimeAsync(0);

/** Canal avec gigue neutralisée (aléa à 1 : délai = plafond) pour garder des délais exacts. */
function make(extra: { random?: () => number } = {}) {
  return createSocialLive({
    createTicket: () => { tickets += 1; return ticketResult(); },
    baseUrl: () => 'http://localhost:7000',
    openSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    poll: async () => { polls += 1; },
    onEvent: (e) => { events.push(e); },
    onStatus: (s) => { statuses.push(s); },
    random: () => 1,
    onForeground: (fn) => { foreground = fn; return () => { foreground = null; }; },
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  tickets = 0;
  polls = 0;
  events = [];
  statuses = [];
  foreground = null;
  ticketResult = async () => ({ wsPath: '/user/social/live?ticket=T' + tickets });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fonctions pures', () => {
  it('backoff exponentiel plafonné à 60 s (sans gigue : aléa à 1)', () => {
    const exact = (attempt: number) => backoffDelay(attempt, () => 1);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(exact)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(exact(500)).toBe(60000);
  });

  it('gigue : le délai tombe entre la moitié et la totalité du plafond', () => {
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(3, () => 0.5)).toBe(6000);
    expect(backoffDelay(9, () => 0)).toBe(30000);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = backoffDelay(6, () => r);
      expect(d).toBeGreaterThanOrEqual(30000);
      expect(d).toBeLessThanOrEqual(60000);
    }
  });

  it('ticket refusé en 429 : au moins 30 s, ou Retry-After s’il est plus long ; autre erreur : rien', () => {
    expect(ticketRetryDelay({ status: 429, retryAfterSec: 5 })).toBe(30000);
    expect(ticketRetryDelay({ status: 429, retryAfterSec: 90 })).toBe(90000);
    expect(ticketRetryDelay({ status: 429 })).toBe(30000);
    expect(ticketRetryDelay({ status: 500, retryAfterSec: 90 })).toBe(0);
    expect(ticketRetryDelay(new Error('reseau'))).toBe(0);
    expect(ticketRetryDelay(undefined)).toBe(0);
  });

  it('adresse WebSocket relative au serveur (https -> wss, http -> ws)', () => {
    expect(socketUrl('https://laststream.example/', '/user/social/live?ticket=T')).toBe('wss://laststream.example/user/social/live?ticket=T');
    expect(socketUrl('http://localhost:7000', '/user/social/live?ticket=T')).toBe('ws://localhost:7000/user/social/live?ticket=T');
  });

  it('lit chaque événement serveur et rejette le reste', () => {
    expect(parseLiveEvent('{"t":"pong"}')).toEqual({ t: 'pong' });
    expect(parseLiveEvent({ t: 'read', pid: 'p9', at: 5 })).toEqual({ t: 'read', pid: 'p9', at: 5 });
    expect(parseLiveEvent({ t: 'unfriend', pid: 'p9' })).toEqual({ t: 'unfriend', pid: 'p9' });
    expect(parseLiveEvent({ t: 'request', request: { pid: 'p9' } })).toEqual({ t: 'request', request: { pid: 'p9' } });
    expect(parseLiveEvent({ t: 'friend', friend: { pid: 'p9' } })).toEqual({ t: 'friend', friend: { pid: 'p9' } });
    expect(parseLiveEvent({ t: 'presence', friend: { pid: 'p9' } })).toEqual({ t: 'presence', friend: { pid: 'p9' } });
    expect(parseLiveEvent({ t: 'message', message: { id: 'm', from: 'a', to: 'b' } })?.t).toBe('message');
    expect(parseLiveEvent({ t: 'note', media: { type: 'movie', tmdbId: 1 }, note: { id: 'n' } })?.t).toBe('note');

    expect(parseLiveEvent('pas du json')).toBeNull();
    expect(parseLiveEvent(null)).toBeNull();
    expect(parseLiveEvent({ t: 'inconnu' })).toBeNull();
    expect(parseLiveEvent({ t: 'message' })).toBeNull();
    expect(parseLiveEvent({ t: 'presence', friend: {} })).toBeNull();
    expect(parseLiveEvent({ t: 'read', pid: 'p9' })).toBeNull();
  });

  it('note_removed : accepté avec le média et un identifiant, refusé sans l’un des deux', () => {
    const media = { type: 'movie', tmdbId: 603 };
    expect(parseLiveEvent({ t: 'note_removed', media, id: 'n1' })).toEqual({ t: 'note_removed', media, id: 'n1' });
    expect(parseLiveEvent(JSON.stringify({ t: 'note_removed', media, id: 'n1' }))).toEqual({ t: 'note_removed', media, id: 'n1' });
    expect(parseLiveEvent({ t: 'note_removed', media })).toBeNull();
    expect(parseLiveEvent({ t: 'note_removed', media, id: '' })).toBeNull();
    expect(parseLiveEvent({ t: 'note_removed', media, id: 42 })).toBeNull();
    expect(parseLiveEvent({ t: 'note_removed', id: 'n1' })).toBeNull();
    expect(parseLiveEvent({ t: 'note_removed', media: 'movie', id: 'n1' })).toBeNull();
  });
});

describe('connexion et ping', () => {
  it('ouvre la WebSocket avec le ticket et envoie un ping toutes les 25 s', async () => {
    const live = make();
    live.start();
    await flush();
    expect(tickets).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('ws://localhost:7000/user/social/live?ticket=T1');

    sockets[0].open();
    expect(live.status).toBe('open');
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS - 1);
    expect(sockets[0].sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0].sent).toEqual(['{"t":"ping"}']);
    live.stop();
  });

  it('transmet les messages reconnus au gestionnaire, pong compris', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    sockets[0].emit({ t: 'pong' });
    sockets[0].emit({ t: 'unfriend', pid: 'p9' });
    sockets[0].emit('pas du json');
    expect(events).toEqual([{ t: 'pong' }, { t: 'unfriend', pid: 'p9' }]);
    live.stop();
  });

  it('sans pong dans les 10 s, ferme le canal et se reconnecte', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS);
    expect(sockets[0].sent).toEqual(['{"t":"ping"}']);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS - 1);
    expect(live.status).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(live.status).toBe('polling');
    expect(sockets[0].closed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[1].url).toBe('ws://localhost:7000/user/social/live?ticket=T2');
    live.stop();
  });

  it('un pong reçu à temps annule le délai', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS);
    sockets[0].emit({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS * 2);
    expect(live.status).toBe('open');
    expect(sockets[0].closed).toHaveLength(0);
    live.stop();
  });
});

describe('reconnexion et repli polling', () => {
  it('repli polling immédiat quand le ticket échoue, reconnexion avec backoff (1 s, 2 s, 4 s)', async () => {
    ticketResult = async () => { throw new Error('reseau'); };
    const live = make();
    live.start();
    await flush();
    expect(live.status).toBe('polling');
    expect(polls).toBe(1);
    expect(tickets).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(tickets).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(tickets).toBe(4);
    live.stop();
  });

  it('le polling tourne toutes les 20 s tant que le canal est coupé, puis s’arrête à la réouverture', async () => {
    let fails = 3;
    ticketResult = async () => {
      if (fails > 0) { fails -= 1; throw new Error('reseau'); }
      return { wsPath: '/user/social/live?ticket=ok' };
    };
    const live = make();
    live.start();
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(polls).toBe(2);

    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS - 1000);
    expect(sockets).toHaveLength(1);
    expect(live.status).toBe('polling');

    sockets[0].open();
    expect(live.status).toBe('open');
    const pollsAtOpen = polls;
    // Avant le premier ping (25 s), le polling de 20 s ne doit plus tourner.
    await vi.advanceTimersByTimeAsync(PING_EVERY_MS - 1);
    expect(polls).toBe(pollsAtOpen);
    live.stop();
  });

  it('une coupure après ouverture repasse en polling et reconnecte après 1 s', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    expect(statuses).toContain('open');

    sockets[0].drop();
    expect(live.status).toBe('polling');
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickets).toBe(2);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(live.status).toBe('open');
    live.stop();
  });

  it('la tentative réussie remet le backoff à zéro', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1].open();
    sockets[1].drop();
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(3);
    live.stop();
  });
});

describe('connexion remplacée (4000) et ticket refusé (429)', () => {
  it('remplacée : aucune reconnexion, polling tant que la page est en arrière-plan', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    sockets[0].replace();
    expect(live.status).toBe('polling');
    expect(polls).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tickets).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(polls).toBeGreaterThan(1);
    expect(live.status).toBe('polling');
    live.stop();
  });

  it('remplacée puis retour au premier plan : une seule tentative immédiate, puis canal ouvert', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    sockets[0].replace();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tickets).toBe(1);

    foreground?.();
    expect(tickets).toBe(2);
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(live.status).toBe('open');
    live.stop();
  });

  it('retour au premier plan sans connexion remplacée : rien de nouveau', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    foreground?.();
    await flush();
    expect(tickets).toBe(1);
    expect(sockets).toHaveLength(1);
    live.stop();
  });

  it('une coupure ordinaire (pas 4000) reconnecte toujours avec backoff', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickets).toBe(2);
    live.stop();
  });

  it('ticket refusé en 429 : attend au moins 30 s, puis Retry-After s’il est plus long', async () => {
    let retryAfterSec = 5;
    ticketResult = async () => {
      const err = Object.assign(new Error('rate_limited'), { status: 429, retryAfterSec });
      throw err;
    };
    const live = make();
    live.start();
    await flush();
    expect(tickets).toBe(1);
    expect(live.status).toBe('polling');

    // Retry-After de 5 s : le minimum de 30 s prime.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(tickets).toBe(1);
    retryAfterSec = 90;
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(2);
    // Le refus suivant annonce 90 s : plus long que le minimum, il prime.
    await vi.advanceTimersByTimeAsync(89_999);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(3);
    live.stop();
  });

  it('gigue réelle (aléa par défaut) : la reconnexion reste dans la fenêtre du backoff', async () => {
    ticketResult = async () => { throw new Error('reseau'); };
    const live = createSocialLive({
      createTicket: () => { tickets += 1; return ticketResult(); },
      baseUrl: () => 'http://localhost:7000',
      openSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      poll: async () => undefined,
      onEvent: () => undefined,
      onForeground: () => () => undefined,
    });
    live.start();
    await flush();
    // Première tentative suivante : entre 500 ms (moitié de 1 s) et 1 s.
    await vi.advanceTimersByTimeAsync(499);
    expect(tickets).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    expect(tickets).toBe(2);
    live.stop();
  });
});

describe('arrêt', () => {
  it('stop ferme la WebSocket, coupe la reconnexion et le ping', async () => {
    const live = make();
    live.start();
    await flush();
    sockets[0].open();
    live.stop();
    expect(sockets[0].closed).toEqual([1000]);
    expect(live.status).toBe('stopped');
    expect(foreground).toBeNull();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tickets).toBe(1);
    expect(sockets[0].sent).toEqual([]);
  });

  it('stop pendant une coupure annule la reconnexion et le polling', async () => {
    ticketResult = async () => { throw new Error('reseau'); };
    const live = make();
    live.start();
    await flush();
    live.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tickets).toBe(1);
    expect(polls).toBe(1);
  });

  it('start deux fois n’ouvre qu’une connexion', async () => {
    const live = make();
    live.start();
    live.start();
    await flush();
    expect(tickets).toBe(1);
    live.stop();
  });

  it('utilise WebSocket du navigateur quand aucune ouverture n’est injectée', async () => {
    const urls: string[] = [];
    class GlobalFake extends FakeSocket {
      constructor(url: string) { super(url); urls.push(url); }
    }
    vi.stubGlobal('WebSocket', GlobalFake);
    const live = createSocialLive({
      createTicket: async () => ({ wsPath: '/user/social/live?ticket=G' }),
      baseUrl: () => 'https://laststream.example',
      poll: async () => undefined,
      onEvent: () => undefined,
    });
    live.start();
    await flush();
    expect(urls).toEqual(['wss://laststream.example/user/social/live?ticket=G']);
    live.stop();
  });
});
