import { call, type MediaKind, type Visibility } from './userApi';

/* Client des fonctions sociales de lastAddon (docs/social.md) : parrainage, amis, présence, partage de bibliothèque,
 * titres masqués et salons de visionnage. Seuls le pseudo et la couleur d'avatar sont exposés aux autres comptes. */

// ---- Parrainage ----
export type InviteState = 'free' | 'sent' | 'used';
export interface InviteDto {
  id: string;
  code: string;
  state: InviteState;
  createdAt: string;
  sentAt: string | null;
  usedAt: string | null;
  /** Pseudo du filleul (null : lien libre, ou compte supprimé). */
  invitee: string | null;
}
export interface InvitesDto {
  quota: number;
  invites: InviteDto[];
}
const enc = encodeURIComponent;

export const getInvites = () => call<InvitesDto>('/invites');
export const markInviteSent = (id: string, sent: boolean) => call<void>('/invites/' + enc(id) + '/sent', { method: 'PUT', body: { sent } });
export const revokeInvite = (id: string) => call<{ invite: InviteDto }>('/invites/' + enc(id), { method: 'DELETE' });
export const checkInvite = (code: string) =>
  call<{ valid: boolean; inviter: string | null }>('/invites/check?code=' + enc(code), { anonymous: true });
export const setInviteQuota = (username: string, quota: number) =>
  call<{ username: string; quota: number }>('/accounts/' + enc(username) + '/invite-quota', { method: 'PUT', body: { quota } });

// ---- Amis ----
export type FriendStatus = 'online' | 'watching' | 'offline';
export interface Watching {
  type: MediaKind;
  tmdbId?: number | null;
  imdbId?: string | null;
  title: string;
  season?: number | null;
  episode?: number | null;
}
export interface FriendDto {
  username: string;
  avatarColor: string;
  status: FriendStatus;
  since: string;
  watching?: Watching | null;
}
export interface FriendRequestDto {
  username: string;
  avatarColor: string;
  requestedAt: string;
}
export interface FriendsDto {
  friends: FriendDto[];
  incoming: FriendRequestDto[];
  outgoing: FriendRequestDto[];
}

export const getFriends = () => call<FriendsDto>('/friends');
export const requestFriend = (username: string) =>
  call<{ status: 'sent' | 'accepted' }>('/friends/requests', { method: 'POST', body: { username } });
export const acceptFriend = (username: string) => call<void>('/friends/requests/' + enc(username) + '/accept', { method: 'POST' });
/** Refuse une demande reçue ou annule une demande envoyée. */
export const dropFriendRequest = (username: string) => call<void>('/friends/requests/' + enc(username), { method: 'DELETE' });
export const removeFriend = (username: string) => call<void>('/friends/' + enc(username), { method: 'DELETE' });

// ---- Présence ----
export interface PresenceBody {
  profileId: string;
  watching?: { type: MediaKind; tmdbId: number; title: string; season?: number; episode?: number } | null;
  invisible?: boolean;
}
export const putPresence = (body: PresenceBody) => call<unknown>('/presence', { method: 'PUT', body, timeoutMs: 6000 });
export const deletePresence = () => call<void>('/presence', { method: 'DELETE', timeoutMs: 4000 });

// ---- Bibliothèques partagées ----
const PF = (id: string) => '/profiles/' + enc(id);
export const setItemVisibility = (profileId: string, type: MediaKind, itemId: number | string, visibility: Visibility) =>
  call<void>(`${PF(profileId)}/library/${type}/${enc(String(itemId))}/visibility`, { method: 'PUT', body: { visibility }, profileId });
export const setAllVisibility = (profileId: string, visibility: Visibility, type?: MediaKind) =>
  call<{ updated: number }>(PF(profileId) + '/library/visibility', { method: 'PUT', body: { visibility, ...(type ? { type } : {}) }, profileId });

export interface FriendLibraryItem {
  type: MediaKind;
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
}
export interface FriendLibraryDto {
  items: FriendLibraryItem[];
  total: number;
  limit: number;
  offset: number;
}
export const getFriendLibrary = (username: string, o: { type?: MediaKind; limit?: number; offset?: number } = {}) => {
  const q = new URLSearchParams();
  if (o.type) q.set('type', o.type);
  if (o.limit) q.set('limit', String(o.limit));
  if (o.offset) q.set('offset', String(o.offset));
  const qs = q.toString();
  return call<FriendLibraryDto>('/friends/' + enc(username) + '/library' + (qs ? '?' + qs : ''));
};

// ---- Titres masqués (par profil) ----
export interface HiddenItemDto {
  key: string;
  title: string;
  poster: string | null;
  addedAt: number | string;
}
export interface HiddenPageDto {
  items: HiddenItemDto[];
  total: number;
  nextCursor: string | null;
}
export const HIDDEN_PAGE = 500;
export const listHidden = (profileId: string, o: { q?: string; limit?: number; cursor?: string | null } = {}) => {
  const q = new URLSearchParams();
  if (o.q) q.set('q', o.q);
  q.set('limit', String(o.limit ?? HIDDEN_PAGE));
  if (o.cursor) q.set('cursor', o.cursor);
  return call<HiddenPageDto>(PF(profileId) + '/hidden?' + q.toString(), { profileId, timeoutMs: 15_000 });
};
export interface HiddenEntryWire {
  key: string;
  title: string;
  poster?: string;
  addedAt?: number;
}
export const putHidden = (profileId: string, entries: HiddenEntryWire[]) =>
  call<{ total: number }>(PF(profileId) + '/hidden', { method: 'PUT', body: { entries }, profileId });
export const removeHidden = (profileId: string, keys: string[]) =>
  call<{ removed: number }>(PF(profileId) + '/hidden/remove', { method: 'POST', body: { keys }, profileId });

// ---- Watch party (REST) ----
export type PartyVisibility = 'private' | 'public';
export interface PartyMedia {
  type: MediaKind;
  tmdbId?: number | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
}
export interface Fingerprint {
  fileName?: string;
  size?: number;
  hash?: string;
}
export interface PartyParticipant {
  username: string;
  avatarColor?: string;
  host?: boolean;
  muted?: boolean;
  joinedAt?: string;
}
export interface PartyRoom {
  id: string;
  visibility: PartyVisibility;
  title: string;
  poster: string | null;
  language: string | null;
  media: PartyMedia;
  fingerprint: Fingerprint | null;
  host: string;
  participants: number | PartyParticipant[];
  maxParticipants: number;
  createdAt: string;
}
export interface PartyListItem {
  id: string;
  title: string;
  poster: string | null;
  language: string | null;
  mediaType: MediaKind;
  host: string;
  participants: number;
  maxParticipants: number;
  createdAt: string;
}
export interface CreatePartyBody {
  profileId: string;
  visibility: PartyVisibility;
  title: string;
  poster?: string | null;
  language?: string;
  media: PartyMedia;
  fingerprint?: Fingerprint;
  maxParticipants?: number;
}
const party = { prefix: '/party' } as const;
export const createParty = (body: CreatePartyBody) => call<{ room: PartyRoom }>('', { ...party, method: 'POST', body });
export const listParties = (profileId: string, o: { language?: string; limit?: number; cursor?: string | null } = {}) => {
  const q = new URLSearchParams({ profileId });
  if (o.language) q.set('language', o.language);
  if (o.limit) q.set('limit', String(o.limit));
  if (o.cursor) q.set('cursor', o.cursor);
  return call<{ rooms: PartyListItem[]; nextCursor: string | null }>('?' + q.toString(), party);
};
export const getParty = (id: string) => call<{ room: PartyRoom }>('/' + enc(id), party);
export interface JoinTicket {
  ticket: string;
  expiresAt: string;
  wsPath: string;
  room: PartyRoom;
}
export const joinParty = (id: string, profileId: string) => call<JoinTicket>('/' + enc(id) + '/join', { ...party, method: 'POST', body: { profileId } });
export const endParty = (id: string) => call<void>('/' + enc(id), { ...party, method: 'DELETE' });
