import { social, withQuery } from './socialHttp';
import { UserApiError, type MediaKind } from './userApi';

/* Client typé de l'API sociale v2 (`/user/social/*`, contrat docs/social-v2-contract.md) : profils, amis et demandes,
 * présence, messages, notes, ticket du canal temps réel. Le profil agissant est le profil actif : son identifiant part en
 * X-Profile-Id (exigé par le serveur sur toutes les routes sociales) et son jeton de profil en X-Profile-Token, comme le
 * reste de /user. Aucun texte n'est affiché ici. */

export type Status = 'online' | 'away' | 'dnd' | 'invisible';
type SeenStatus = 'online' | 'away' | 'dnd' | 'offline';
export type Handle = { name: string; tag: string; full: string };
export type Watching = {
  type: 'movie' | 'series'; tmdbId: number; imdbId?: string; title: string;
  season?: number; episode?: number; poster?: string;
  pos: number; duration?: number; paused: boolean; at: number;
};
export type FriendView = {
  pid: string; handle: Handle; avatarColor: string; avatar?: string; household: boolean;
  status: SeenStatus; watching?: Watching; lastSeen?: number;
};
export type FriendRequest = { pid: string; handle: Handle; avatarColor: string; avatar?: string; createdAt: number };
export type MessageContext = { type: 'movie' | 'series'; tmdbId: number; season?: number; episode?: number; pos?: number };
export type Message = {
  id: string; from: string; to: string;
  body: string;
  context?: MessageContext;
  createdAt: number; readAt?: number;
};
export type Conversation = { pid: string; handle: Handle; avatarColor: string; avatar?: string; last?: Message; unread: number };
export type MediaRef = { type: 'movie' | 'series'; tmdbId: number; season?: number; episode?: number };
export type Note = {
  id: string;
  author: { pid: string; handle: Handle; avatarColor: string; avatar?: string };
  pos: number; kind: 'text' | 'emoji'; body: string;
  createdAt: number;
};
export type HistoryItem = {
  type: 'movie' | 'series'; tmdbId: number; title?: string; poster?: string;
  season?: number; episode?: number; pos: number; duration?: number; watched: boolean; updatedAt: number;
};

/** Profil connecté tel que le serveur le décrit (`GET /me`). */
export type SocialMe = { pid: string; handle: Handle; status: Status; avatarColor: string; avatar?: string };
export type FriendsResponse = { friends: FriendView[]; household: FriendView[]; incoming: FriendRequest[]; outgoing: FriendRequest[] };
/** `POST /requests` : 201 `{ request }`, ou 200 `{ friend }` si l'autre m'avait déjà demandé. */
export type RequestOutcome = { request: FriendRequest } | { friend: FriendView };
/** Élément de bibliothèque d'un ami : même forme que l'ancienne route `/user/friends/:username/library`. */
type LibraryItem = {
  type: MediaKind; tmdbId: number | null; imdbId: string | null;
  title: string; poster: string | null; addedAt: string;
};
export type FriendLibrary = { items: LibraryItem[]; total?: number; limit?: number; offset?: number };
export type NewNote = MediaRef & { pos: number; kind: 'text' | 'emoji'; body: string };

const enc = encodeURIComponent;

/** Chiffres et lettres sans équivoque (pas de 0, O, 1, I, L) : 31 symboles, 4 par tag. */
const TAG_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TAG_LENGTH = 4;
const NAME_MIN = 2;
const NAME_MAX = 20;
const NAME_RE = /^[\p{L}\p{N} _-]+$/u;

/**
 * Lit un handle `Nom#TAG` saisi librement : espaces autour du nom et du tag retirés, tag mis en majuscules.
 * Renvoie null si le nom (2–20 caractères : lettres Unicode, chiffres, espace, `_`, `-`) ou le tag (4 caractères de
 * l'alphabet TAG_ALPHABET) est invalide. Fonction pure, sans réseau.
 */
export function validateHandle(input: string): Handle | null {
  if (typeof input !== 'string') return null;
  const parts = input.split('#');
  if (parts.length !== 2) return null;
  const name = parts[0].trim().normalize('NFC');
  const tag = parts[1].trim().toUpperCase();
  const nameLength = Array.from(name).length;
  if (nameLength < NAME_MIN || nameLength > NAME_MAX || !NAME_RE.test(name)) return null;
  if (tag.length !== TAG_LENGTH || !Array.from(tag).every((c) => TAG_ALPHABET.includes(c))) return null;
  return { name, tag, full: `${name}#${tag}` };
}

// ---- Profil et statut ----
export const getMe = () => social<SocialMe>('GET', '/me');
export const putStatus = (status: Status) => social<{ status: Status }>('PUT', '/status', { status });

// ---- Amis et demandes ----
export const getFriends = () => social<FriendsResponse>('GET', '/friends');
/** Envoie une demande à `Nom#TAG` ; un handle invalide est refusé avant tout appel réseau (`invalid_handle`). */
export async function sendFriendRequest(handle: string): Promise<RequestOutcome> {
  const h = validateHandle(handle);
  if (!h) throw new UserApiError(400, 'invalid_handle');
  return social<RequestOutcome>('POST', '/requests', { handle: h.full });
}
export const acceptFriendRequest = (pid: string) => social<{ friend: FriendView }>('POST', `/requests/${enc(pid)}/accept`);
/** Refuse une demande reçue ou annule une demande envoyée. */
export const declineFriendRequest = (pid: string) => social<void>('DELETE', `/requests/${enc(pid)}`);
export const removeFriend = (pid: string) => social<void>('DELETE', `/friends/${enc(pid)}`);
/** Bibliothèque partagée d'un ami (ou du foyer) ; `type`, `limit` et `offset` sont facultatifs (pagination serveur). */
export const getFriendLibrary = (pid: string, o: { type?: 'movie' | 'series'; limit?: number; offset?: number } = {}) =>
  social<FriendLibrary>('GET', withQuery(`/friends/${enc(pid)}/library`, { type: o.type, limit: o.limit, offset: o.offset }));
/** Historique récent d'un ami ; `limit` borné entre 1 et 50 (défaut 20). */
export const getFriendHistory = (pid: string, limit = 20) => {
  const n = Math.min(50, Math.max(1, Math.floor(limit)));
  return social<{ items: HistoryItem[] }>('GET', withQuery(`/friends/${enc(pid)}/history`, { limit: n }));
};

// ---- Présence ----
/** Heartbeat (≤ 30 s) et changements de lecture. Sans `watching` dans l'appel, le corps est vide. */
export const putPresence = (watching?: Watching | null) =>
  social<void>('PUT', '/presence', watching === undefined ? {} : { watching });
export const deletePresence = () => social<void>('DELETE', '/presence');

// ---- Messages ----
export const getConversations = () => social<{ conversations: Conversation[] }>('GET', '/conversations');
export const getMessages = (pid: string, o: { before?: number; limit?: number } = {}) =>
  social<{ messages: Message[] }>('GET', withQuery(`/messages/${enc(pid)}`, { before: o.before, limit: o.limit }));
export const sendMessage = (pid: string, body: string, context?: MessageContext) =>
  social<{ message: Message }>('POST', `/messages/${enc(pid)}`, { body, ...(context ? { context } : {}) });
export const markMessagesRead = (pid: string) => social<void>('PUT', `/messages/${enc(pid)}/read`);

// ---- Notes de la timeline ----
export const getNotes = (media: MediaRef) =>
  social<{ notes: Note[] }>('GET', withQuery('/notes', {
    type: media.type, tmdbId: media.tmdbId, season: media.season, episode: media.episode,
  }));
export const postNote = (n: NewNote) =>
  social<{ note: Note }>('POST', '/notes', {
    type: n.type, tmdbId: n.tmdbId, season: n.season, episode: n.episode, pos: n.pos, kind: n.kind, body: n.body,
  });
export const deleteNote = (id: string) => social<void>('DELETE', `/notes/${enc(id)}`);

// ---- Canal temps réel ----
/** Ticket HMAC valable 60 s : à redemander à chaque tentative de connexion. */
export const createLiveTicket = () => social<{ wsPath: string }>('POST', '/live-ticket');
