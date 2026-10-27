import type { FriendRequest, FriendView, MediaRef, Message, Note } from './socialV2Api';
import type { ActivityItem, EveningEvent, Poll, Reaction } from './socialV3Api';

/* Canal temps réel du Social v2 et v3 : une WebSocket par profil actif (ticket à 60 s, même mécanisme que les salons).
 * Ping toutes les 25 s, attente de pong (10 s), reconnexion avec backoff exponentiel plafonné à 60 s, avec gigue. Tant que
 * la WebSocket ne fonctionne pas, repli sur un polling (`poll`, appelé toutes les 20 s) ; il s'arrête à la réouverture.
 * Cas particuliers : ticket refusé en 429 → attente d'au moins 30 s (ou Retry-After) ; connexion remplacée (fermeture 4000,
 * le serveur a ouvert une autre connexion pour ce profil) → pas de reconnexion automatique, repli polling jusqu'au retour
 * au premier plan. Une seule connexion par instance : `start()` répété ou après `start()` ne rouvre rien.
 * Aucune dépendance au navigateur : socket, minuteurs, ticket, aléa et retour au premier plan sont injectés.
 * Le message v3 garde la forme `Message` ; les champs v3 (conv, kind, reactions) sont normalisés dans le store. */

export const PING_EVERY_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const POLL_EVERY_MS = 20_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Attente minimale après un ticket refusé en 429 (un Retry-After plus long prime). */
const RATE_LIMIT_MIN_WAIT_MS = 30_000;
/** Fermeture 4000 : connexion remplacée par une autre du même profil (miroir de SOCIAL_LIVE_REPLACED côté serveur). */
export const LIVE_REPLACED_CODE = 4000;

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
  | { t: 'note'; media: MediaRef; note: Note }
  /** Note supprimée par son auteur. */
  | { t: 'note_removed'; media: MediaRef; id: string }
  /** Saisie d'un membre d'une conversation (`dm:<pid>` ou `g:<id>`). */
  | { t: 'typing'; conv: string; pid: string }
  | { t: 'reaction'; conv: string; id: string; reactions: Reaction[] }
  | { t: 'poll'; conv: string; poll: Poll }
  | { t: 'list'; listId: string }
  | { t: 'join_request'; from: FriendView }
  | { t: 'join_answer'; pid: string; accept: boolean; partyId?: string }
  | { t: 'party_invite'; from: FriendView; partyId: string; title: string }
  | { t: 'activity'; item: ActivityItem }
  /** Trame d'une soirée planifiée (LAST-198) : l'évènement est discriminé par son propre `type`. */
  | { t: 'evening'; event: EveningEvent };

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
  /** Source d'aléa de la gigue du backoff (0 inclus, 1 exclu) ; défaut : Math.random. */
  random?: () => number;
  /** Abonnement au retour au premier plan ; défaut : visibilitychange du document. Renvoie la désinscription. */
  onForeground?: (fn: () => void) => () => void;
}

export interface SocialLive {
  start(): void;
  stop(): void;
  readonly status: LiveStatus;
}

/**
 * Délai avant la tentative n (0, 1, 2…) : 1 s, 2 s, 4 s… plafonné à 60 s. Gigue (« moitié à totalité » du plafond) pour
 * éviter que les clients coupés ensemble ne se reconnectent au même instant.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.min(Math.max(0, Math.floor(attempt)), 30);
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

/**
 * Attente imposée par l'erreur du ticket : un 429 (limite de tickets du profil) impose au moins 30 s, ou le Retry-After
 * du serveur s'il est plus long. Toute autre erreur n'impose rien (0). Lit `status` et `retryAfterSec` (UserApiError).
 */
export function ticketRetryDelay(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 0;
  const { status, retryAfterSec } = err as { status?: unknown; retryAfterSec?: unknown };
  if (status !== 429) return 0;
  const sec = typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 0;
  return Math.max(RATE_LIMIT_MIN_WAIT_MS, sec * 1000);
}

/** Retour au premier plan du navigateur (visibilitychange) ; sans document (Node) : aucun abonnement. */
function onVisibleSubscription(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const handler = (): void => {
    if (document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

/** Adresse WebSocket d'un ticket : `wsPath` est relatif au serveur (http -> ws, https -> wss). Même règle que les salons. */
export function socketUrl(base: string, wsPath: string): string {
  return base.replace(/\/+$/, '').replace(/^http/i, 'ws') + wsPath;
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasPid = (x: unknown): boolean => isRec(x) && typeof x.pid === 'string';

const RESPONSES: readonly unknown[] = ['yes', 'maybe', 'no'];

/** Trame de soirée bien formée : `type` connu et champs requis par ce type ; tout le reste est écarté. */
function isEveningEvent(e: Record<string, unknown>): e is EveningEvent {
  if (typeof e.eveningId !== 'string' || e.eveningId === '') return false;
  switch (e.type) {
    case 'evening_invite':
      return typeof e.title === 'string' && typeof e.startsAt === 'number' && typeof e.tz === 'string' && hasPid(e.host);
    case 'evening_update':
      return e.change === 'updated' || e.change === 'cancelled';
    case 'evening_response':
      return typeof e.pid === 'string' && RESPONSES.includes(e.response);
    case 'evening_reminder':
      return typeof e.title === 'string' && typeof e.startsAt === 'number' && typeof e.tz === 'string';
    case 'evening_open':
      return isRec(e.party) && typeof e.party.partyId === 'string';
    default:
      return false;
  }
}

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
    case 'note_removed':
      return isRec(v.media) && typeof v.id === 'string' && v.id !== '' ? { t: 'note_removed', media: v.media as unknown as MediaRef, id: v.id } : null;
    case 'typing':
      return typeof v.conv === 'string' && typeof v.pid === 'string' ? { t: 'typing', conv: v.conv, pid: v.pid } : null;
    case 'reaction':
      return typeof v.conv === 'string' && typeof v.id === 'string' && Array.isArray(v.reactions)
        ? { t: 'reaction', conv: v.conv, id: v.id, reactions: v.reactions as Reaction[] } : null;
    case 'poll':
      return typeof v.conv === 'string' && isRec(v.poll) && typeof v.poll.id === 'string'
        ? { t: 'poll', conv: v.conv, poll: v.poll as unknown as Poll } : null;
    case 'list':
      return typeof v.listId === 'string' ? { t: 'list', listId: v.listId } : null;
    case 'join_request':
      return hasPid(v.from) ? { t: 'join_request', from: v.from as unknown as FriendView } : null;
    case 'join_answer':
      if (typeof v.pid !== 'string' || typeof v.accept !== 'boolean') return null;
      return typeof v.partyId === 'string'
        ? { t: 'join_answer', pid: v.pid, accept: v.accept, partyId: v.partyId }
        : { t: 'join_answer', pid: v.pid, accept: v.accept };
    case 'party_invite':
      return hasPid(v.from) && typeof v.partyId === 'string' && typeof v.title === 'string'
        ? { t: 'party_invite', from: v.from as unknown as FriendView, partyId: v.partyId, title: v.title } : null;
    case 'activity':
      return isRec(v.item) && typeof v.item.id === 'string' ? { t: 'activity', item: v.item as unknown as ActivityItem } : null;
    case 'evening':
      return isRec(v.event) && isEveningEvent(v.event) ? { t: 'evening', event: v.event } : null;
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
  /** Connexion remplacée (4000) : pas de reconnexion avant le retour au premier plan. */
  let replaced = false;
  let unsubscribeForeground: (() => void) | null = null;
  const random = o.random ?? Math.random;
  const subscribeForeground = o.onForeground ?? onVisibleSubscription;

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
      .catch((err: unknown) => {
        if (g === gen) onFailure(ticketRetryDelay(err));
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
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      if ((ev as { code?: unknown } | undefined)?.code === LIVE_REPLACED_CODE) onReplaced();
      else onFailure();
    };
    s.onerror = () => { /* la fermeture suit */ };
  }

  /** Canal coupé ou muet : on ferme ce qui reste, on passe en repli polling et on planifie la reconnexion (`minDelayMs` en plus). */
  function onFailure(minDelayMs = 0): void {
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
    scheduleReconnect(minDelayMs);
  }

  /** Connexion remplacée par une autre du même profil (4000) : aucune reconnexion ; polling jusqu'au retour au premier plan. */
  function onReplaced(): void {
    pingT = clear(pingT);
    pongT = clear(pongT);
    reconnectT = clear(reconnectT);
    replaced = true;
    if (!running) return;
    setStatus('polling');
    startPolling();
  }

  /** Retour au premier plan : seule reprise après une connexion remplacée (une tentative, sans attendre le backoff). */
  function onForeground(): void {
    if (!running || !replaced || socket !== null) return;
    replaced = false;
    connect();
  }

  function scheduleReconnect(minDelayMs = 0): void {
    reconnectT = clear(reconnectT);
    const delay = Math.max(backoffDelay(attempt, random), minDelayMs);
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
      replaced = false;
      unsubscribeForeground = subscribeForeground(onForeground);
      connect();
    },
    stop(): void {
      running = false;
      gen += 1;
      replaced = false;
      unsubscribeForeground?.();
      unsubscribeForeground = null;
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
