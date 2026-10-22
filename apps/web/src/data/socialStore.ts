import { isKidProfile, isServerMode } from './auth';
import { requireBase } from './config';
import { UserApiError, type MediaKind } from './userApi';
import * as api from './socialV2Api';
import { userStore } from './userStore';
import type {
  Conversation, FriendRequest, FriendView, FriendsResponse, MediaRef, Message, MessageContext, Note, RequestOutcome, SocialMe, Status,
} from './socialV2Api';
import * as v3 from './socialV3Api';
import type {
  ActivityItem, BlockedPerson, ConversationV3, FriendV3, JoinAnswer, ListDetail, ListItemInput, ListSummary, MediaQuery,
  MessageV3, NewMessage, PrefsPatch, ProfilePatch, Reaction, RelationPatch, ReportInput, ShareInput, SocialPrefs,
  SocialProfile, Poll, TagResult,
} from './socialV3Api';
import { createSocialLive, type LiveEvent, type LiveStatus, type SocialLive } from './socialLive';

/* Store du Social v2 et v3 : moi, profil, préférences, amis, foyer, demandes, conversations directes et groupes, messages
 * (DM en cache par pid, messages v3 par conversation), non-lus, saisie, statut, badge, listes partagées, activité et mode
 * cinéma. Les événements du canal temps réel sont réduits ici ; les notes et les événements transitoires (réponse à une
 * demande de rejoindre, invitation au salon) vont aux écouteurs. Le social n'existe jamais pour un profil enfant :
 * `start()` ne fait rien dans ce cas, ni hors mode serveur (pas de session).
 * Protection : chaque appel réseau n'écrit son résultat que si l'époque n'a pas changé (arrêt ou changement de profil). */

export const MESSAGE_MAX = 1000;
/** Une saisie disparaît 5 s après le dernier signal. */
const TYPING_MS = 5_000;
/** Pas plus d'un envoi de saisie toutes les 3 s (le serveur limite à 1/3 s). */
const TYPING_SEND_MIN_MS = 3_000;
const TYPING_MUTE_MS = 60_000;

export type NoteListener = (media: MediaRef, note: Note) => void;
export type NoteRemovedListener = (media: MediaRef, id: string) => void;
export type JoinAnswerListener = (ev: { pid: string; accept: boolean; partyId?: string }) => void;
export type PartyInviteListener = (ev: { from: FriendView; partyId: string; title: string }) => void;

/** Échéance du mode cinéma : fin du film (levée par `endCinema`), epoch ms, ou toujours. */
export type CinemaUntil = 'film' | 'always' | number;
export const CINEMA_ELEMENTS = ['bubbles', 'notes', 'markers', 'friendsPresence', 'myPresence', 'partyRequests'] as const;
export type CinemaElement = (typeof CINEMA_ELEMENTS)[number];
/** Éléments masqués par défaut : les cases cochées de la maquette (bulles, notes, marqueurs). */
export const DEFAULT_CINEMA_HIDDEN: CinemaElement[] = ['bubbles', 'notes', 'markers'];

export interface CinemaState {
  active: boolean;
  until: CinemaUntil | null;
  /** Début du mode (epoch ms) : borne du résumé `GET /missed`. */
  since: number | null;
  /** Éléments masqués pendant le mode. */
  hidden: CinemaElement[];
  /** Messages reçus pendant le mode, dans l'ordre d'arrivée. */
  queue: MessageV3[];
  /** Compteur de l'indicateur « N messages en attente » (= longueur de la file). */
  count: number;
}

export interface SocialState {
  me: SocialMe | null;
  status: Status;
  friends: FriendV3[];
  household: FriendV3[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  conversations: Conversation[];
  /** Messages chargés, par pid du correspondant, chronologiques (v2). */
  messages: Record<string, Message[]>;
  live: LiveStatus;
  /** Non-lus : somme des compteurs de conversations directes et de groupes. */
  unread: number;
  /** Badge : demandes entrantes + non-lus. */
  badge: number;
  /** Groupes : conversations v3 dont `group` est présent. */
  groups: ConversationV3[];
  /** Messages v3 par conversation (`dm:<pid>` ou `g:<id>`), chronologiques ; seulement les conversations chargées. */
  threads: Record<string, MessageV3[]>;
  /** Saisie : conversation -> pid -> échéance (epoch ms). */
  typing: Record<string, Record<string, number>>;
  profile: SocialProfile | null;
  prefs: SocialPrefs | null;
  blocked: BlockedPerson[];
  /** Demandes entrantes de rejoindre mon salon. */
  joinRequests: FriendView[];
  lists: ListSummary[];
  listDetails: Record<string, ListDetail>;
  activity: ActivityItem[];
  cinema: CinemaState;
}

type Base = Omit<SocialState, 'unread' | 'badge'>;
type Person = { handle: Conversation['handle']; avatarColor: string; avatar?: string };

export function initialCinemaState(): CinemaState {
  return { active: false, until: null, since: null, hidden: [...DEFAULT_CINEMA_HIDDEN], queue: [], count: 0 };
}

export function initialSocialState(): SocialState {
  return withCounts({
    me: null, status: 'online', friends: [], household: [], incoming: [], outgoing: [], conversations: [], messages: {}, live: 'idle',
    groups: [], threads: {}, typing: {}, profile: null, prefs: null, blocked: [], joinRequests: [], lists: [], listDetails: {},
    activity: [], cinema: initialCinemaState(),
  });
}

function withCounts(b: Base): SocialState {
  const unread = b.conversations.reduce((n, c) => n + c.unread, 0) + b.groups.reduce((n, g) => n + g.unread, 0);
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
function placeFriend(b: Base, f: FriendV3): Base {
  const friends = removePid(b.friends, f.pid);
  const household = removePid(b.household, f.pid);
  return f.household
    ? { ...b, friends, household: upsertPid(household, f) }
    : { ...b, friends: upsertPid(friends, f), household };
}

/** Amis acceptés : la demande disparaît, la fiche ami est rangée. */
function befriend(b: Base, f: FriendV3): Base {
  return placeFriend(removeRequests(b, f.pid), f);
}

/** Remplace les listes par celles du serveur (réponse complète de /friends). */
function withFriendLists(b: Base, r: FriendsResponse): Base {
  return { ...b, friends: r.friends, household: r.household, incoming: r.incoming, outgoing: r.outgoing };
}

function findPerson(b: Base, pid: string): Person | undefined {
  const f = b.friends.find((x) => x.pid === pid) ?? b.household.find((x) => x.pid === pid)
    ?? b.incoming.find((x) => x.pid === pid) ?? b.outgoing.find((x) => x.pid === pid);
  return f ? { handle: f.handle, avatarColor: f.avatarColor, ...(f.avatar ? { avatar: f.avatar } : {}) } : undefined;
}

/** Une lecture dont la position n'avance plus depuis ce délai n'est plus « en train de regarder » (même seuil que le serveur). */
export const WATCHING_IDLE_MS = 10 * 60_000;
/** Pas de la réévaluation : la carte disparaît sans nouvel événement du serveur. */
const IDLE_CHECK_MS = 30_000;

/** Retire `watching` des amis et du foyer dont la lecture est figée depuis plus de WATCHING_IDLE_MS (sans `movedAt` : inchangé). */
export function expireIdleWatching(s: SocialState, now: number = Date.now()): SocialState {
  const idle = (f: FriendV3): boolean => f.watching?.movedAt !== undefined && now - f.watching.movedAt > WATCHING_IDLE_MS;
  if (!s.friends.some(idle) && !s.household.some(idle)) return s;
  const strip = (f: FriendV3): FriendV3 => {
    if (!idle(f)) return f;
    const out = { ...f };
    delete out.watching;
    return out;
  };
  return { ...s, friends: s.friends.map(strip), household: s.household.map(strip) };
}

const byLastDesc = (a: Conversation, b: Conversation): number => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0);

/** Sépare, dans une même réponse, conversations directes et groupes. */
function splitConversations(list: ConversationV3[]): { conversations: Conversation[]; groups: ConversationV3[] } {
  return {
    conversations: list.filter((c) => !c.group).sort(byLastDesc),
    groups: list.filter((c) => c.group !== undefined).sort(byLastDesc),
  };
}

/** Fusionne deux listes de messages par id (la seconde l'emporte), chronologique. */
export function mergeMessages<T extends Message>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt);
}

/** Fusionne des entrées d'activité par id, la plus récente d'abord. */
export function mergeActivity(a: ActivityItem[], b: ActivityItem[]): ActivityItem[] {
  const map = new Map<string, ActivityItem>();
  for (const x of [...a, ...b]) map.set(x.id, x);
  return [...map.values()].sort((x, y) => y.at - x.at);
}

const dmConv = (pid: string): string => `dm:${pid}`;
const groupConv = (id: string): string => `g:${id}`;
const isGroupConv = (conv: string): boolean => conv.startsWith('g:');

/** Conversation d'un message : `conv` du serveur, ou `dm:<correspondant>` pour un message v2. */
export function convOf(m: Message, me: string): string {
  const c = (m as Partial<MessageV3>).conv;
  if (typeof c === 'string' && c !== '') return c;
  return dmConv(m.from === me ? m.to : m.from);
}

/** Forme v3 d'un message : conversation, type `text` et réactions vides par défaut. */
export function toV3(m: Message, me: string): MessageV3 {
  const x = m as Partial<MessageV3>;
  return { ...m, conv: convOf(m, me), kind: x.kind ?? 'text', reactions: x.reactions ?? [] };
}

/** Remplace le message `id` d'une conversation chargée ; une conversation non chargée reste telle quelle. */
function patchThread(threads: Record<string, MessageV3[]>, conv: string, fn: (m: MessageV3) => MessageV3): Record<string, MessageV3[]> {
  const list = threads[conv];
  return list ? { ...threads, [conv]: list.map(fn) } : threads;
}

/** Ajoute un message à une conversation chargée (sans effet si elle ne l'est pas). */
function threadWith(threads: Record<string, MessageV3[]>, conv: string, m: MessageV3): Record<string, MessageV3[]> {
  const cached = threads[conv];
  return cached ? { ...threads, [conv]: mergeMessages(cached, [m]) } : threads;
}

function without<V>(rec: Record<string, V>, key: string): Record<string, V> {
  const out = { ...rec };
  delete out[key];
  return out;
}

/** Mode cinéma actif à cet instant (une échéance en epoch ms passée le désactive). */
export function cinemaOn(c: CinemaState, now: number): boolean {
  return c.active && !(typeof c.until === 'number' && now >= c.until);
}

/** Mode cinéma : un message reçu pendant le mode entre dans la file (et compte), sans toucher aux non-lus. */
function withQueue(b: Base, m: MessageV3, incoming: boolean, now: number): Base {
  if (!incoming || !cinemaOn(b.cinema, now) || b.cinema.queue.some((x) => x.id === m.id)) return b;
  const queue = [...b.cinema.queue, m];
  return { ...b, cinema: { ...b.cinema, queue, count: queue.length } };
}

/** Un message (DM ou groupe) : cache, dernier message, non-lus (message reçu, une fois), file du mode cinéma. */
function applyMessage(b: Base, m: Message, now: number): Base {
  const me = b.me?.pid ?? '';
  const conv = convOf(m, me);
  if (isGroupConv(conv)) return applyGroupMessage(b, m, me, now);
  const peer = m.from === me ? m.to : m.from;
  const cached = b.messages[peer];
  const duplicate = cached?.some((x) => x.id === m.id) ?? false;
  const messages = cached ? { ...b.messages, [peer]: mergeMessages(cached, [m]) } : b.messages;
  const incoming = m.from !== me && !duplicate;
  const known = b.conversations.find((c) => c.pid === peer);
  let conversations: Conversation[];
  if (known) {
    conversations = b.conversations.map((c) => (c.pid === peer ? { ...c, last: m, unread: c.unread + (incoming ? 1 : 0) } : c));
  } else {
    const who = findPerson(b, peer);
    conversations = who
      ? [...b.conversations, { pid: peer, handle: who.handle, avatarColor: who.avatarColor, ...(who.avatar ? { avatar: who.avatar } : {}), last: m, unread: incoming ? 1 : 0 }]
      : b.conversations;
  }
  const v = toV3(m, me);
  return withQueue({
    ...b, messages, conversations: [...conversations].sort(byLastDesc), threads: threadWith(b.threads, conv, v),
  }, v, incoming, now);
}

/** Un message de groupe : cache de la conversation, dernier message et non-lus du groupe connu. */
function applyGroupMessage(b: Base, m: Message, me: string, now: number): Base {
  const v = toV3(m, me);
  const cached = b.threads[v.conv];
  const duplicate = cached?.some((x) => x.id === m.id) ?? false;
  const incoming = m.from !== me && !duplicate;
  const groups = b.groups.some((g) => g.conv === v.conv)
    ? b.groups.map((g) => (g.conv === v.conv ? { ...g, last: v, unread: g.unread + (incoming ? 1 : 0) } : g)).sort(byLastDesc)
    : b.groups;
  return withQueue({ ...b, groups, threads: threadWith(b.threads, v.conv, v) }, v, incoming, now);
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

/** Saisie : enregistre l'échéance d'un membre pour une conversation. */
export function setTyping(t: Record<string, Record<string, number>>, conv: string, pid: string, expiresAt: number): Record<string, Record<string, number>> {
  return { ...t, [conv]: { ...(t[conv] ?? {}), [pid]: expiresAt } };
}

/** Retire les saisies échues à `now`. */
export function pruneTyping(t: Record<string, Record<string, number>>, now: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [conv, by] of Object.entries(t)) {
    const kept = Object.fromEntries(Object.entries(by).filter(([, exp]) => exp > now));
    if (Object.keys(kept).length > 0) out[conv] = kept;
  }
  return out;
}

/** Pids qui sont en train d'écrire dans cette conversation à `now`. */
export function typingPids(s: SocialState, conv: string, now: number = Date.now()): string[] {
  return Object.entries(s.typing[conv] ?? {}).filter(([, exp]) => exp > now).map(([pid]) => pid);
}

/**
 * Réduction d'un événement temps réel. Pur : renvoie un nouvel état. Les notes, `list`, `join_answer` et `party_invite`
 * ne touchent pas à l'état (ils vont aux écouteurs ou déclenchent un rechargement) ; `pong` ne change rien.
 */
export function reduceLiveEvent(s: SocialState, ev: LiveEvent, now: number = Date.now()): SocialState {
  switch (ev.t) {
    case 'pong':
    case 'note':
    case 'note_removed':
    case 'list':
    case 'join_answer':
    case 'party_invite':
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
      return withCounts(applyMessage(s, ev.message, now));
    case 'typing':
      if (ev.pid === s.me?.pid) return s;
      return { ...s, typing: setTyping(pruneTyping(s.typing, now), ev.conv, ev.pid, now + TYPING_MS) };
    case 'reaction':
      return { ...s, threads: patchThread(s.threads, ev.conv, (m) => (m.id === ev.id ? { ...m, reactions: ev.reactions } : m)) };
    case 'poll':
      return { ...s, threads: patchThread(s.threads, ev.conv, (m) => (m.poll?.id === ev.poll.id ? { ...m, poll: ev.poll } : m)) };
    case 'join_request':
      return { ...s, joinRequests: upsertPid(s.joinRequests, ev.from) };
    case 'activity':
      return { ...s, activity: mergeActivity(s.activity, [ev.item]) };
  }
}

// ---- Store ----
let state: SocialState = initialSocialState();
const subs = new Set<(s: SocialState) => void>();
const noteSubs = new Set<NoteListener>();
const noteRemovedSubs = new Set<NoteRemovedListener>();
const joinAnswerSubs = new Set<JoinAnswerListener>();
const partyInviteSubs = new Set<PartyInviteListener>();
let live: SocialLive | null = null;
/** Incrémenté à chaque démarrage et arrêt : une réponse réseau dont l'époque a changé est périmée et n'est pas écrite. */
let epoch = 0;
/** Minuteurs de saisie (retrait à 5 s) : annulés à l'arrêt. */
const timers = new Set<ReturnType<typeof setTimeout>>();
let cinemaTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
/** Dernier envoi de saisie par conversation (limitation côté client). */
const lastTypingSent = new Map<string, number>();

function commit(next: SocialState): void {
  state = next;
  subs.forEach((f) => {
    try { f(state); } catch { /* un abonné ne casse pas le store */ }
  });
}

function later(fn: () => void, ms: number): void {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
}

function clearTimers(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
}

function clearCinemaTimer(): void {
  if (cinemaTimer !== null) clearTimeout(cinemaTimer);
  cinemaTimer = null;
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

/** Écouteur des notes supprimées en direct (par leur auteur). */
export function onNoteRemoved(cb: NoteRemovedListener): () => void {
  noteRemovedSubs.add(cb);
  return () => { noteRemovedSubs.delete(cb); };
}

/** Écouteur des réponses à une demande de rejoindre (acceptée ou refusée). */
export function onJoinAnswer(cb: JoinAnswerListener): () => void {
  joinAnswerSubs.add(cb);
  return () => { joinAnswerSubs.delete(cb); };
}

/** Écouteur des invitations ciblées à une watch party. */
export function onPartyInvite(cb: PartyInviteListener): () => void {
  partyInviteSubs.add(cb);
  return () => { partyInviteSubs.delete(cb); };
}

/**
 * Appel réseau : son résultat n'est appliqué que si l'époque n'a pas changé (arrêt ou changement de profil entre-temps).
 * `apply` lit l'état courant, au moment où la réponse arrive.
 */
async function run<T>(req: () => Promise<T>, apply?: (r: T) => Partial<SocialState>): Promise<T> {
  const e = epoch;
  const r = await req();
  if (epoch === e && apply) commit(withCounts({ ...state, ...apply(r) }));
  return r;
}

/**
 * Avatar du profil agissant : celui que renvoie le serveur, sinon celui du profil actif de l'appareil (même profil : le
 * serveur et l'appareil décrivent la même personne), pour ne jamais retomber sur la lettre alors qu'un avatar existe.
 */
export function withLocalAvatar(me: SocialMe): SocialMe {
  if (me.avatar) return me;
  let local: unknown;
  try {
    local = userStore.currentProfile().avatar;
  } catch {
    local = undefined;
  }
  return typeof local === 'string' && local !== '' ? { ...me, avatar: local } : me;
}

/**
 * Source unique de mon avatar : `state.me` (sidebar, en-tête et listes des discussions, écran « Mon profil social »).
 * À appeler dès que l'avatar du profil actif change : le profil local de l'appareil est aligné (sinon `withLocalAvatar`
 * ressortirait l'ancien avatar au prochain `refresh`) et l'état est publié, sans recharger l'app.
 */
export function setMyAvatar(avatar: string | null): void {
  const next = typeof avatar === 'string' && avatar !== '' ? avatar : undefined;
  try {
    userStore.currentProfile().avatar = next ?? null;
  } catch {
    /* pas de profil local : l'état du store suffit */
  }
  const withAvatar = <T extends { avatar?: string }>(x: T): T => {
    const { avatar: _old, ...rest } = x;
    return (next ? { ...rest, avatar: next } : rest) as T;
  };
  commit({ ...state, me: state.me && withAvatar(state.me), profile: state.profile && withAvatar(state.profile) });
}

/** Mon avatar tel que l'affichent la sidebar et le chat (jamais l'avatar local brut de l'écran de profil). */
export function myAvatar(): string | null {
  return state.me?.avatar ?? null;
}

/** Relit profil, amis et conversations. */
export async function refresh(): Promise<void> {
  const e = epoch;
  const [rawMe, lists, convs] = await Promise.all([api.getMe(), api.getFriends(), v3.listConversations()]);
  const me = withLocalAvatar(rawMe);
  if (epoch !== e) return;
  commit(withCounts({
    ...withFriendLists(state, lists),
    me,
    status: me.status,
    ...splitConversations(convs.conversations),
  }));
}

/** Relit amis et conversations (et le profil s'il manque) : repli polling et resynchronisation à la reconnexion. */
async function refreshLists(): Promise<void> {
  if (!state.me) return refresh();
  const e = epoch;
  const [lists, convs] = await Promise.all([api.getFriends(), v3.listConversations()]);
  if (epoch !== e) return;
  commit(withCounts({ ...withFriendLists(state, lists), ...splitConversations(convs.conversations) }));
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

/** Range un message (envoyé ou reçu) ; relit les conversations si le correspondant ou le groupe est encore inconnu. */
function receive(m: Message): void {
  commit(withCounts(applyMessage(state, m, Date.now())));
  const me = state.me?.pid ?? '';
  const conv = convOf(m, me);
  if (isGroupConv(conv)) {
    if (!state.groups.some((g) => g.conv === conv)) void resync();
    return;
  }
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

// ---- Profil (S1) ----
const withProfile = (p: SocialProfile): Partial<SocialState> => ({
  profile: p,
  me: state.me && { ...state.me, handle: p.handle, avatarColor: p.avatarColor, ...(p.avatar ? { avatar: p.avatar } : {}) },
});

/** Mon profil social étendu. */
export const loadProfile = (): Promise<SocialProfile> => run(v3.getProfile, withProfile);

/** Modifie le profil (corps partiel) ; le nom peut changer le handle. */
export const saveProfile = (patch: ProfilePatch): Promise<SocialProfile> => run(() => v3.updateProfile(patch), withProfile);

/** Tire un nouveau tag (30 jours entre deux tirages côté serveur). */
export const rerollTag = (): Promise<TagResult> => run(v3.rerollTag, (r) => ({
  me: state.me && { ...state.me, handle: r.handle },
  profile: state.profile && { ...state.profile, handle: r.handle, tagChangeableAt: r.tagChangeableAt },
}));

// ---- Préférences (S2) ----
export const loadPrefs = (): Promise<SocialPrefs> => run(v3.getPrefs, (p) => ({ prefs: p }));
export const savePrefs = (patch: PrefsPatch): Promise<SocialPrefs> => run(() => v3.updatePrefs(patch), (p) => ({ prefs: p }));

// ---- Relations, blocages, signalements, demandes de rejoindre (S2) ----
/** Réglages d'un ami (favori, surnom, sourdine, activité) ; la fiche renvoyée remplace l'ancienne. */
export const saveRelation = (pid: string, patch: RelationPatch): Promise<FriendV3> =>
  run(() => v3.updateRelation(pid, patch), (f) => {
    const prev = state.friends.find((x) => x.pid === pid) ?? state.household.find((x) => x.pid === pid);
    return placeFriend(state, { ...prev, ...f });
  });

/** Bloque : l'amitié et les demandes disparaissent des deux côtés. */
export const block = (pid: string): Promise<void> => run(() => v3.blockUser(pid), () => {
  const who = findPerson(state, pid);
  const already = state.blocked.some((x) => x.pid === pid);
  return {
    incoming: removePid(state.incoming, pid),
    outgoing: removePid(state.outgoing, pid),
    friends: removePid(state.friends, pid),
    household: removePid(state.household, pid),
    blocked: who && !already ? [...state.blocked, { pid, handle: who.handle }] : state.blocked,
  };
});

export const unblock = (pid: string): Promise<void> => run(() => v3.unblockUser(pid), () => ({ blocked: removePid(state.blocked, pid) }));
export const report = (input: ReportInput): Promise<void> => run(() => v3.reportUser(input));

/** Demande à rejoindre le salon d'un ami. */
export const requestJoin = (pid: string): Promise<void> => run(() => v3.requestJoin(pid));

/** Répond à une demande de rejoindre : la demande disparaît de la liste. */
export const answerJoin = (pid: string, answer: JoinAnswer): Promise<void> =>
  run(() => v3.answerJoin(pid, answer), () => ({ joinRequests: removePid(state.joinRequests, pid) }));

// ---- Conversations, groupes, messages v3 (S3) ----
/** Groupe créé : il rejoint la liste des groupes. */
export const createGroup = (name: string, members: string[]): Promise<ConversationV3> =>
  run(() => v3.createGroup({ name, members }), (g) => ({
    groups: [...state.groups.filter((x) => x.conv !== g.conv), g].sort(byLastDesc),
  }));

/** Renomme ou change les membres d'un groupe, puis relit les conversations. */
export async function updateGroup(id: string, patch: { name?: string; add?: string[]; remove?: string[] }): Promise<void> {
  const e = epoch;
  await v3.updateGroup(id, patch);
  if (epoch !== e) return;
  await refreshLists();
}

/** Quitte un groupe : il disparaît avec ses messages chargés. */
export const leaveGroup = (id: string): Promise<void> => run(() => v3.leaveGroup(id), () => {
  const conv = groupConv(id);
  return { groups: state.groups.filter((g) => g.conv !== conv), threads: without(state.threads, conv), typing: without(state.typing, conv) };
});

/** Charge les messages v3 d'une conversation (les plus récents, ou ceux d'avant `before`) et les fusionne. */
export async function loadThread(conv: string, o: { before?: number; limit?: number } = {}): Promise<MessageV3[]> {
  const e = epoch;
  const { messages } = await v3.getConvMessages(conv, o);
  if (epoch !== e) return [];
  const merged = mergeMessages(state.threads[conv] ?? [], messages);
  commit(withCounts({ ...state, threads: { ...state.threads, [conv]: merged } }));
  return merged;
}

/**
 * Envoie un message v3 dans une conversation. Un texte vide ou trop long est refusé sans appel réseau ; le corps est rogné.
 * Le message reçu est rangé comme un message entrant (DM ou groupe) mais ne compte pas comme non-lu.
 */
export async function sendToConv(conv: string, input: NewMessage): Promise<MessageV3> {
  // L'invitation à une watch party passe par POST /party/:id/invite : le serveur refuse `party` sur /conv.
  if ((input.kind as string) === 'party') throw new UserApiError(400, 'invalid_kind');
  const body = input.body?.trim();
  if (body !== undefined && Array.from(body).length > MESSAGE_MAX) throw new UserApiError(400, 'invalid_body');
  if (input.kind === 'text' && (body === undefined || body === '')) throw new UserApiError(400, 'invalid_body');
  const e = epoch;
  const { message } = await v3.sendConvMessage(conv, { ...input, ...(body !== undefined ? { body } : {}) });
  if (epoch !== e) return message;
  receive(message);
  return message;
}

/** Marque une conversation lue : compteur à zéro. */
export const markConvRead = (conv: string): Promise<void> => run(() => v3.markConvRead(conv), () => ({
  conversations: state.conversations.map((c) => (dmConv(c.pid) === conv ? { ...c, unread: 0 } : c)),
  groups: state.groups.map((g) => (g.conv === conv ? { ...g, unread: 0 } : g)),
}));

/** Bascule une réaction sur un message ; les réactions renvoyées par le serveur remplacent les anciennes. */
export const react = (conv: string, id: string, emoji: string): Promise<Reaction[]> =>
  run(() => v3.toggleReaction(conv, id, emoji), (r) => ({
    threads: patchThread(state.threads, conv, (m) => (m.id === id ? { ...m, reactions: r.reactions } : m)),
  })).then((r) => r.reactions);

/** Vote dans un sondage ; le sondage renvoyé par le serveur remplace l'ancien. */
export const vote = (conv: string, pollId: string, optionId: string): Promise<Poll> =>
  run(() => v3.votePoll(conv, pollId, optionId), (r) => ({
    threads: patchThread(state.threads, conv, (m) => (m.poll?.id === pollId ? { ...m, poll: r.poll } : m)),
  })).then((r) => r.poll);

/** Signale que je tape dans cette conversation ; au plus un envoi toutes les 3 s. Sans effet visible si l'appel échoue. */
export function notifyTyping(conv: string): void {
  const now = Date.now();
  const last = lastTypingSent.get(conv);
  if (last !== undefined && now - last < TYPING_SEND_MIN_MS) return;
  lastTypingSent.set(conv, now);
  // Frappe refusée (403 not_allowed, 404) : silencieux, et on cesse d'insister un moment.
  void v3.sendTyping(conv).catch((e: { status?: number }) => {
    if (e && (e.status === 403 || e.status === 404)) lastTypingSent.set(conv, Date.now() + TYPING_MUTE_MS);
  });
}

/** Partage un titre ou un moment vers plusieurs destinations ; les messages renvoyés sont rangés comme les autres. */
export async function share(input: ShareInput): Promise<MessageV3[]> {
  const e = epoch;
  const { messages } = await v3.shareTo(input);
  if (epoch === e) messages.forEach((m) => receive(m));
  return messages;
}

// ---- Listes partagées (S3) ----
export const loadLists = (): Promise<ListSummary[]> => run(v3.getLists, (r) => ({ lists: r.lists })).then((r) => r.lists);
export const createList = (name: string, members: string[]): Promise<ListSummary> =>
  run(() => v3.createList({ name, members }), (l) => ({ lists: [...state.lists.filter((x) => x.id !== l.id), l] }));
export const loadList = (id: string): Promise<ListDetail> =>
  run(() => v3.getList(id), (d) => ({ listDetails: { ...state.listDetails, [id]: d } }));

/** Mutation d'une liste, puis relecture du détail et du résumé (les réponses de mutation ne sont pas décrites). */
async function mutateList(id: string, op: () => Promise<unknown>): Promise<void> {
  const e = epoch;
  await op();
  if (epoch !== e) return;
  await Promise.all([loadList(id), loadLists()]);
}

export const updateList = (id: string, patch: { name?: string; add?: string[]; remove?: string[] }): Promise<void> =>
  mutateList(id, () => v3.updateList(id, patch));
export const addToList = (id: string, item: ListItemInput): Promise<void> => mutateList(id, () => v3.addListItem(id, item));
export const removeFromList = (id: string, type: MediaKind, tmdbId: number): Promise<void> =>
  mutateList(id, () => v3.removeListItem(id, type, tmdbId));

// ---- Activité (S5) ----
/** Activité des amis, la plus récente d'abord ; fusionnée avec ce qui est déjà chargé. */
export const loadActivity = (o: { before?: number; limit?: number } = {}): Promise<ActivityItem[]> =>
  run(() => v3.getActivity(o), (r) => ({ activity: mergeActivity(state.activity, r.items) })).then(() => state.activity);

// ---- Mode cinéma ----
function sanitizeHidden(list: readonly string[]): CinemaElement[] {
  const known = new Set<string>(CINEMA_ELEMENTS);
  return [...new Set(list)].filter((x): x is CinemaElement => known.has(x));
}

/**
 * Active le mode cinéma. Échéance `'film'` (levée par `endCinema`), epoch ms (fin automatique, une échéance déjà passée
 * ne fait rien) ou `'always'`. `hidden` remplace les éléments masqués ; sinon les réglages précédents restent.
 */
export function startCinema(until: CinemaUntil, hidden?: readonly CinemaElement[]): void {
  const now = Date.now();
  if (typeof until === 'number' && until <= now) return;
  clearCinemaTimer();
  if (typeof until === 'number') cinemaTimer = setTimeout(() => { cinemaTimer = null; endCinema(); }, until - now);
  commit(withCounts({
    ...state,
    cinema: {
      active: true, until, since: now, hidden: hidden ? sanitizeHidden(hidden) : state.cinema.hidden, queue: [], count: 0,
    },
  }));
}

/**
 * Termine le mode cinéma. Renvoie le début du mode (borne du résumé `getMissed`) et les messages reçus pendant le mode ;
 * sans mode actif, rien. Les éléments masqués restent mémorisés pour la prochaine fois.
 */
export function endCinema(): { since: number | null; queue: MessageV3[] } {
  clearCinemaTimer();
  const { since, queue } = state.cinema;
  commit(withCounts({ ...state, cinema: { ...state.cinema, active: false, until: null, since: null, queue: [], count: 0 } }));
  return { since, queue };
}

/** Change les éléments masqués, sans toucher au mode lui-même. */
export function setCinemaHidden(hidden: readonly CinemaElement[]): void {
  commit(withCounts({ ...state, cinema: { ...state.cinema, hidden: sanitizeHidden(hidden) } }));
}

/** Demande de résumé : `since` et la requête de média pour `getMissed`, à partir du mode en cours. */
export function cinemaMissedQuery(media: MediaQuery): { since: number; type: MediaKind; tmdbId: number; season?: number; episode?: number } | null {
  const since = state.cinema.since;
  return since === null ? null : { since, ...media };
}

function applyLive(ev: LiveEvent): void {
  switch (ev.t) {
    case 'note':
      noteSubs.forEach((cb) => {
        try { cb(ev.media, ev.note); } catch { /* un écouteur ne casse pas le canal */ }
      });
      return;
    case 'note_removed':
      noteRemovedSubs.forEach((cb) => {
        try { cb(ev.media, ev.id); } catch { /* un écouteur ne casse pas le canal */ }
      });
      return;
    case 'message':
      receive(ev.message);
      return;
    case 'list':
      if (state.listDetails[ev.listId]) void loadList(ev.listId).catch(() => undefined);
      void loadLists().catch(() => undefined);
      return;
    case 'join_answer':
      joinAnswerSubs.forEach((cb) => {
        try { cb({ pid: ev.pid, accept: ev.accept, partyId: ev.partyId }); } catch { /* un écouteur ne casse pas le canal */ }
      });
      return;
    case 'party_invite':
      partyInviteSubs.forEach((cb) => {
        try { cb({ from: ev.from, partyId: ev.partyId, title: ev.title }); } catch { /* un écouteur ne casse pas le canal */ }
      });
      return;
    case 'typing':
      commit(reduceLiveEvent(state, ev));
      later(() => commit(withCounts({ ...state, typing: pruneTyping(state.typing, Date.now()) })), TYPING_MS);
      return;
    default:
      commit(reduceLiveEvent(state, ev));
  }
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
  idleTimer = setInterval(() => {
    const next = expireIdleWatching(state);
    if (next !== state) commit(next);
  }, IDLE_CHECK_MS);
}

/** Arrête le temps réel et vide l'état (déconnexion, changement de profil : rien ne doit fuir d'un profil à l'autre). */
export function stop(): void {
  epoch++;
  const l = live;
  live = null;
  l?.stop();
  if (idleTimer !== null) clearInterval(idleTimer);
  idleTimer = null;
  clearTimers();
  clearCinemaTimer();
  lastTypingSent.clear();
  commit(initialSocialState());
}
