import { isKidProfile, isServerMode } from './auth';
import { requireBase } from './config';
import { UserApiError } from './userApi';
import * as api from './socialV2Api';
import type {
  Conversation, FriendRequest, FriendView, FriendsResponse, MediaRef, Message, MessageContext, Note, RequestOutcome, SocialMe, Status,
} from './socialV2Api';
import { createSocialLive, type LiveEvent, type LiveStatus, type SocialLive } from './socialLive';

/* Store du Social v2 : moi, amis, foyer, demandes, conversations, messages chargés, non-lus, statut et badge.
 * Les événements du canal temps réel sont réduits ici ; les notes vont aux écouteurs `onNote`. Le social n'existe
 * jamais pour un profil enfant : `start()` ne fait rien dans ce cas, ni hors mode serveur (pas de session). */

export const MESSAGE_MAX = 1000;

export type NoteListener = (media: MediaRef, note: Note) => void;

export interface SocialState {
  me: SocialMe | null;
  status: Status;
  friends: FriendView[];
  household: FriendView[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  conversations: Conversation[];
  /** Messages chargés, par pid du correspondant, chronologiques. */
  messages: Record<string, Message[]>;
  live: LiveStatus;
  /** Non-lus : somme des compteurs de conversation. */
  unread: number;
  /** Badge : demandes entrantes + non-lus. */
  badge: number;
}

type Base = Omit<SocialState, 'unread' | 'badge'>;
type Person = { handle: Conversation['handle']; avatarColor: string };

export function initialSocialState(): SocialState {
  return withCounts({
    me: null, status: 'online', friends: [], household: [], incoming: [], outgoing: [], conversations: [], messages: {}, live: 'idle',
  });
}

function withCounts(b: Base): SocialState {
  const unread = b.conversations.reduce((n, c) => n + c.unread, 0);
  return { ...b, unread, badge: b.incoming.length + unread };
}

const removePid = <T extends { pid: string }>(list: T[], pid: string): T[] => list.filter((x) => x.pid !== pid);
const upsertPid = <T extends { pid: string }>(list: T[], item: T): T[] =>
  list.some((x) => x.pid === item.pid) ? list.map((x) => (x.pid === item.pid ? item : x)) : [...list, item];

/** Retire les demandes (reçues ou envoyées) de ce pid. */
function removeRequests(b: Base, pid: string): Base {
  return { ...b, incoming: removePid(b.incoming, pid), outgoing: removePid(b.outgoing, pid) };
}

/** Range un ami dans le foyer ou dans les amis, selon `household` ; remplace la fiche précédente. */
function placeFriend(b: Base, f: FriendView): Base {
  const friends = removePid(b.friends, f.pid);
  const household = removePid(b.household, f.pid);
  return f.household
    ? { ...b, friends, household: upsertPid(household, f) }
    : { ...b, friends: upsertPid(friends, f), household };
}

/** Amis acceptés : la demande disparaît, la fiche ami est rangée. */
function befriend(b: Base, f: FriendView): Base {
  return placeFriend(removeRequests(b, f.pid), f);
}

/** Remplace les listes par celles du serveur (réponse complète de /friends). */
function withFriendLists(b: Base, r: FriendsResponse): Base {
  return { ...b, friends: r.friends, household: r.household, incoming: r.incoming, outgoing: r.outgoing };
}

function findPerson(b: Base, pid: string): Person | undefined {
  const f = b.friends.find((x) => x.pid === pid) ?? b.household.find((x) => x.pid === pid)
    ?? b.incoming.find((x) => x.pid === pid) ?? b.outgoing.find((x) => x.pid === pid);
  return f ? { handle: f.handle, avatarColor: f.avatarColor } : undefined;
}

const byLastDesc = (a: Conversation, b: Conversation): number => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0);

/** Fusionne deux listes de messages par id (la seconde l'emporte), chronologique. */
export function mergeMessages(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt);
}

/** Un message entre moi et `peer` : cache des messages, dernier message, non-lus (seulement pour un message reçu, une fois). */
function applyMessage(b: Base, m: Message): Base {
  const me = b.me?.pid ?? '';
  const peer = m.from === me ? m.to : m.from;
  const cached = b.messages[peer];
  const duplicate = cached?.some((x) => x.id === m.id) ?? false;
  const messages = cached ? { ...b.messages, [peer]: mergeMessages(cached, [m]) } : b.messages;
  const incoming = m.from !== me && !duplicate ? 1 : 0;
  const known = b.conversations.find((c) => c.pid === peer);
  let conversations: Conversation[];
  if (known) {
    conversations = b.conversations.map((c) => (c.pid === peer ? { ...c, last: m, unread: c.unread + incoming } : c));
  } else {
    const who = findPerson(b, peer);
    conversations = who ? [...b.conversations, { pid: peer, handle: who.handle, avatarColor: who.avatarColor, last: m, unread: incoming }] : b.conversations;
  }
  return { ...b, messages, conversations: [...conversations].sort(byLastDesc) };
}

/** Accusé de lecture reçu : `pid` a lu mes messages envoyés jusqu'à `at`. */
function markSentRead(messages: Record<string, Message[]>, me: string | undefined, pid: string, at: number): Record<string, Message[]> {
  const list = messages[pid];
  if (!list) return messages;
  return {
    ...messages,
    [pid]: list.map((m) => (m.from === me && m.to === pid && m.readAt === undefined && m.createdAt <= at ? { ...m, readAt: at } : m)),
  };
}

/**
 * Réduction d'un événement temps réel. Pur : renvoie un nouvel état. Les notes ne touchent pas à l'état (elles vont aux
 * écouteurs `onNote`) ; `pong` ne change rien.
 */
export function reduceLiveEvent(s: SocialState, ev: LiveEvent): SocialState {
  switch (ev.t) {
    case 'pong':
    case 'note':
      return s;
    case 'presence':
      return withCounts(placeFriend(s, ev.friend));
    case 'friend':
      return withCounts(befriend(s, ev.friend));
    case 'unfriend':
      return withCounts({ ...s, friends: removePid(s.friends, ev.pid), household: removePid(s.household, ev.pid) });
    case 'request':
      return withCounts({ ...s, incoming: upsertPid(s.incoming, ev.request) });
    case 'read':
      return withCounts({ ...s, messages: markSentRead(s.messages, s.me?.pid, ev.pid, ev.at) });
    case 'message':
      return withCounts(applyMessage(s, ev.message));
  }
}

// ---- Store ----
let state: SocialState = initialSocialState();
const subs = new Set<(s: SocialState) => void>();
const noteSubs = new Set<NoteListener>();
let live: SocialLive | null = null;
/** Incrémenté à chaque démarrage et arrêt : une réponse réseau dont l'époque a changé est périmée et n'est pas écrite. */
let epoch = 0;

function commit(next: SocialState): void {
  state = next;
  subs.forEach((f) => {
    try { f(state); } catch { /* un abonné ne casse pas le store */ }
  });
}

export function getState(): SocialState {
  return state;
}

export function subscribe(fn: (s: SocialState) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Écouteur des notes reçues en direct (ami ou foyer). */
export function onNote(cb: NoteListener): () => void {
  noteSubs.add(cb);
  return () => { noteSubs.delete(cb); };
}

/** Relit profil, amis et conversations. */
export async function refresh(): Promise<void> {
  const e = epoch;
  const [me, lists, convs] = await Promise.all([api.getMe(), api.getFriends(), api.getConversations()]);
  if (epoch !== e) return;
  commit(withCounts({
    ...withFriendLists(state, lists),
    me,
    status: me.status,
    conversations: [...convs.conversations].sort(byLastDesc),
  }));
}

/** Relit amis et conversations (et le profil s'il manque) : repli polling et resynchronisation à la reconnexion. */
async function refreshLists(): Promise<void> {
  if (!state.me) return refresh();
  const e = epoch;
  const [lists, convs] = await Promise.all([api.getFriends(), api.getConversations()]);
  if (epoch !== e) return;
  commit(withCounts({ ...withFriendLists(state, lists), conversations: [...convs.conversations].sort(byLastDesc) }));
}

const resync = (): Promise<void> => refreshLists().catch(() => undefined);

export async function setStatus(status: Status): Promise<void> {
  const e = epoch;
  const r = await api.putStatus(status);
  if (epoch !== e) return;
  commit(withCounts({ ...state, status: r.status, me: state.me && { ...state.me, status: r.status } }));
}

/** Demande d'ami vers `Nom#TAG`. Si l'autre m'avait déjà demandé, l'ami est accepté directement. */
export async function sendRequest(handle: string): Promise<RequestOutcome> {
  const e = epoch;
  const out = await api.sendFriendRequest(handle);
  if (epoch !== e) return out;
  if ('friend' in out) commit(withCounts(befriend(state, out.friend)));
  else commit(withCounts({ ...state, outgoing: upsertPid(state.outgoing, out.request) }));
  return out;
}

export async function accept(pid: string): Promise<FriendView> {
  const e = epoch;
  const { friend } = await api.acceptFriendRequest(pid);
  if (epoch !== e) return friend;
  commit(withCounts(befriend(state, friend)));
  return friend;
}

/** Refuse une demande reçue ou annule une demande envoyée. */
export async function decline(pid: string): Promise<void> {
  const e = epoch;
  await api.declineFriendRequest(pid);
  if (epoch !== e) return;
  commit(withCounts(removeRequests(state, pid)));
}

export async function removeFriend(pid: string): Promise<void> {
  const e = epoch;
  await api.removeFriend(pid);
  if (epoch !== e) return;
  commit(withCounts({ ...state, friends: removePid(state.friends, pid), household: removePid(state.household, pid) }));
}

/** Range un message (envoyé ou reçu) ; relit les conversations si le correspondant est encore inconnu. */
function receive(m: Message): void {
  commit(withCounts(applyMessage(state, m)));
  const peer = m.from === state.me?.pid ? m.to : m.from;
  if (!state.conversations.some((c) => c.pid === peer)) void resync();
}

/** Envoie un message (texte rogné, 1 à 1000 caractères). Un texte vide ou trop long est refusé sans appel réseau. */
export async function sendMessage(pid: string, body: string, context?: MessageContext): Promise<Message> {
  const text = body.trim();
  if (text === '' || Array.from(text).length > MESSAGE_MAX) throw new UserApiError(400, 'invalid_body');
  const e = epoch;
  const { message } = await api.sendMessage(pid, text, context);
  if (epoch !== e) return message;
  receive(message);
  return message;
}

/** Marque tout lu avec ce correspondant : compteur à zéro, messages reçus datés de maintenant. */
export async function markRead(pid: string): Promise<void> {
  const e = epoch;
  await api.markMessagesRead(pid);
  if (epoch !== e) return;
  const now = Date.now();
  const list = state.messages[pid];
  commit(withCounts({
    ...state,
    conversations: state.conversations.map((c) => (c.pid === pid ? { ...c, unread: 0 } : c)),
    messages: list
      ? { ...state.messages, [pid]: list.map((m) => (m.from === pid && m.readAt === undefined ? { ...m, readAt: now } : m)) }
      : state.messages,
  }));
}

/** Charge les messages d'une conversation (les plus récents, ou ceux d'avant `before`) et les fusionne au cache. */
export async function loadMessages(pid: string, o: { before?: number; limit?: number } = {}): Promise<Message[]> {
  const e = epoch;
  const { messages } = await api.getMessages(pid, o);
  if (epoch !== e) return [];
  const merged = mergeMessages(state.messages[pid] ?? [], messages);
  commit(withCounts({ ...state, messages: { ...state.messages, [pid]: merged } }));
  return merged;
}

function applyLive(ev: LiveEvent): void {
  if (ev.t === 'note') {
    noteSubs.forEach((cb) => {
      try { cb(ev.media, ev.note); } catch { /* un écouteur ne casse pas le canal */ }
    });
    return;
  }
  if (ev.t === 'message') {
    receive(ev.message);
    return;
  }
  commit(reduceLiveEvent(state, ev));
}

/**
 * Démarre le temps réel et charge l'état. No-op pour un profil enfant, et hors mode serveur. Un nouvel ouverture du
 * canal resynchronise l'état (événements manqués pendant la coupure).
 */
export function start(): void {
  if (live || isKidProfile() || !isServerMode()) return;
  const e = ++epoch;
  live = createSocialLive({
    createTicket: () => api.createLiveTicket(),
    baseUrl: () => requireBase(),
    poll: () => (e === epoch ? resync() : Promise.resolve()),
    onEvent: (ev) => { if (e === epoch) applyLive(ev); },
    onStatus: (s) => {
      if (e !== epoch) return;
      commit({ ...state, live: s });
      if (s === 'open') void resync();
    },
  });
  live.start();
}

/** Arrête le temps réel et vide l'état (déconnexion, changement de profil : rien ne doit fuir d'un profil à l'autre). */
export function stop(): void {
  epoch++;
  const l = live;
  live = null;
  l?.stop();
  commit(initialSocialState());
}
