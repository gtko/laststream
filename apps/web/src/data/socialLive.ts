import type { FriendRequest, FriendView, MediaRef, Message, Note } from './socialV2Api';

/* Canal temps réel du Social v2 : une WebSocket par profil actif (ticket à 60 s, même mécanisme que les salons).
 * Ping toutes les 25 s, attente de pong (10 s), reconnexion avec backoff exponentiel plafonné. Tant que la WebSocket
 * ne fonctionne pas, repli sur un polling (`poll`, appelé toutes les 20 s) ; il s'arrête à la réouverture du canal.
 * Aucune dépendance au navigateur : socket, minuteurs et ticket sont injectés. */

export const PING_EVERY_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const POLL_EVERY_MS = 20_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'polling' | 'stopped';

/** Messages serveur → client (contrat, section WebSocket). */
export type LiveEvent =
  | { t: 'pong' }
  | { t: 'message'; message: Message }
  | { t: 'read'; pid: string; at: number }
  | { t: 'presence'; friend: FriendView }
  | { t: 'request'; request: FriendRequest }
  | { t: 'friend'; friend: FriendView }
  | { t: 'unfriend'; pid: string }
  | { t: 'note'; media: MediaRef; note: Note };

/** Sous-ensemble de WebSocket utilisé ici (le vrai objet, ou un faux en test). */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface SocialLiveOptions {
  /** Ticket du canal (POST /user/social/live-ticket) : demandé à chaque tentative. */
  createTicket: () => Promise<{ wsPath: string }>;
  /** Adresse du serveur lastAddon (http(s) ou ws(s)). */
  baseUrl: () => string;
  /** Ouvre la connexion ; défaut : `new WebSocket(url)`. */
  openSocket?: (url: string) => LiveSocket;
  /** Repli : rafraîchit /friends et /conversations pendant que le canal est coupé. */
  poll: () => Promise<unknown>;
  /** Reçoit chaque message serveur reconnu (pong compris). */
  onEvent: (ev: LiveEvent) => void;
  onStatus?: (s: LiveStatus) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface SocialLive {
  start(): void;
  stop(): void;
  readonly status: LiveStatus;
}

/** Délai avant la tentative n (0, 1, 2…) : 1 s, 2 s, 4 s… plafonné à 30 s. */
export function backoffDelay(attempt: number): number {
  const n = Math.min(Math.max(0, Math.floor(attempt)), 30);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
}

/** Adresse WebSocket d'un ticket : `wsPath` est relatif au serveur (http -> ws, https -> wss). Même règle que les salons. */
export function socketUrl(base: string, wsPath: string): string {
  return base.replace(/\/+$/, '').replace(/^http/i, 'ws') + wsPath;
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasPid = (x: unknown): boolean => isRec(x) && typeof x.pid === 'string';

/** Lit un message serveur ; renvoie null pour tout ce qui n'est pas un événement connu ou bien formé. */
export function parseLiveEvent(data: unknown): LiveEvent | null {
  let v: unknown = data;
  if (typeof data === 'string') {
    try { v = JSON.parse(data); } catch { return null; }
  }
  if (!isRec(v)) return null;
  switch (v.t) {
    case 'pong':
      return { t: 'pong' };
    case 'message':
      return isRec(v.message) && typeof v.message.id === 'string' && typeof v.message.from === 'string' && typeof v.message.to === 'string'
        ? { t: 'message', message: v.message as unknown as Message } : null;
    case 'read':
      return typeof v.pid === 'string' && typeof v.at === 'number' ? { t: 'read', pid: v.pid, at: v.at } : null;
    case 'presence':
      return hasPid(v.friend) ? { t: 'presence', friend: v.friend as unknown as FriendView } : null;
    case 'request':
      return hasPid(v.request) ? { t: 'request', request: v.request as unknown as FriendRequest } : null;
    case 'friend':
      return hasPid(v.friend) ? { t: 'friend', friend: v.friend as unknown as FriendView } : null;
    case 'unfriend':
      return typeof v.pid === 'string' ? { t: 'unfriend', pid: v.pid } : null;
    case 'note':
      return isRec(v.media) && isRec(v.note) && typeof v.note.id === 'string'
        ? { t: 'note', media: v.media as unknown as MediaRef, note: v.note as unknown as Note } : null;
    default:
      return null;
  }
}

/** Crée le canal temps réel. Rien n'est ouvert avant `start()`. */
export function createSocialLive(o: SocialLiveOptions): SocialLive {
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const openSocket = o.openSocket ?? ((url: string) => new WebSocket(url) as unknown as LiveSocket);

  let status: LiveStatus = 'idle';
  let running = false;
  /** Génération : tout rappel d'une connexion antérieure à `stop()` est ignoré. */
  let gen = 0;
  let attempt = 0;
  let socket: LiveSocket | null = null;
  let reconnectT: unknown = null;
  let pingT: unknown = null;
  let pongT: unknown = null;
  let pollT: unknown = null;

  const clear = (t: unknown): null => {
    if (t !== null) clearTimer(t);
    return null;
  };
  const setStatus = (s: LiveStatus): void => {
    if (status === s) return;
    status = s;
    try { o.onStatus?.(s); } catch { /* un écouteur ne casse pas le canal */ }
  };

  function connect(): void {
    const g = gen;
    if (status !== 'polling') setStatus('connecting');
    new Promise<{ wsPath: string }>((resolve) => resolve(o.createTicket()))
      .then(({ wsPath }) => {
        if (g !== gen) return;
        bind(openSocket(socketUrl(o.baseUrl(), wsPath)));
      })
      .catch(() => {
        if (g === gen) onFailure();
      });
  }

  function bind(s: LiveSocket): void {
    socket = s;
    s.onopen = () => {
      if (socket !== s) return;
      attempt = 0;
      pollT = clear(pollT);
      setStatus('open');
      armPing();
    };
    s.onmessage = (ev) => {
      if (socket !== s) return;
      const e = parseLiveEvent(ev.data);
      if (!e) return;
      if (e.t === 'pong') pongT = clear(pongT);
      try { o.onEvent(e); } catch { /* un écouteur ne casse pas le canal */ }
    };
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      onFailure();
    };
    s.onerror = () => { /* la fermeture suit */ };
  }

  /** Canal coupé ou muet : on ferme ce qui reste, on passe en repli polling et on planifie la reconnexion. */
  function onFailure(): void {
    pingT = clear(pingT);
    pongT = clear(pongT);
    const s = socket;
    socket = null;
    if (s) {
      s.onclose = null;
      try { s.close(); } catch { /* ignoré */ }
    }
    if (!running) return;
    setStatus('polling');
    startPolling();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    reconnectT = clear(reconnectT);
    const delay = backoffDelay(attempt);
    attempt += 1;
    const g = gen;
    reconnectT = setTimer(() => {
      reconnectT = null;
      if (g === gen && running) connect();
    }, delay);
  }

  function runPoll(): void {
    try { void Promise.resolve(o.poll()).catch(() => undefined); } catch { /* ignoré */ }
  }
  function startPolling(): void {
    if (pollT !== null) return;
    runPoll();
    armPoll();
  }
  function armPoll(): void {
    pollT = setTimer(() => {
      pollT = null;
      if (!running) return;
      runPoll();
      armPoll();
    }, POLL_EVERY_MS);
  }

  function armPing(): void {
    pingT = setTimer(() => {
      pingT = null;
      const s = socket;
      if (!s || !running) return;
      try { s.send(JSON.stringify({ t: 'ping' })); } catch { /* la fermeture ou le pong manqué suivra */ }
      if (pongT === null) pongT = setTimer(() => { pongT = null; onFailure(); }, PONG_TIMEOUT_MS);
      armPing();
    }, PING_EVERY_MS);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      attempt = 0;
      connect();
    },
    stop(): void {
      running = false;
      gen += 1;
      reconnectT = clear(reconnectT);
      pingT = clear(pingT);
      pongT = clear(pongT);
      pollT = clear(pollT);
      const s = socket;
      socket = null;
      if (s) {
        s.onclose = null;
        s.onmessage = null;
        try { s.close(1000); } catch { /* ignoré */ }
      }
      setStatus('stopped');
    },
    get status(): LiveStatus {
      return status;
    },
  };
}
