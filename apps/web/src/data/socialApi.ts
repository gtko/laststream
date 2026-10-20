import { call, type MediaKind, type Visibility } from './userApi';

/* Client des fonctions sociales de lastAddon (docs/social.md) : parrainage, amis, présence, partage de bibliothèque,
 * titres masqués et salons de visionnage. Seuls le pseudo et la couleur d'avatar sont exposés aux autres comptes. */

// ---- Parrainage ----
export type InviteState = 'free' | 'sent' | 'used' | 'revoked';
/** Coup de cœur d'un billet : un titre de la bibliothèque du parrain (3 au plus). Images : https seulement. */
export interface InvitePick {
  id: number | string;
  type: MediaKind;
  name: string;
  poster: string | null;
  background: string | null;
}
export interface InviteDto {
  id: string;
  code: string;
  state: InviteState;
  createdAt: string;
  sentAt: string | null;
  usedAt: string | null;
  /** Pseudo du filleul (null : lien libre, ou compte supprimé). */
  invitee: string | null;
  /** Date de révocation par l'administrateur (ISO), ou null : le lien ne fonctionne plus et n'est plus partageable. */
  revokedAt?: string | null;
  /** Mot du parrain (≤ 280 caractères), affiché sur la page d'arrivée du filleul. Absent des serveurs antérieurs. */
  message?: string | null;
  /** Coups de cœur (≤ 3). Absent des serveurs antérieurs : tenu pour une liste vide. */
  picks?: InvitePick[];
  /** Fin de validité du billet envoyé (ISO) : envoi + 14 jours. Null tant que le billet est libre. */
  expiresAt?: string | null;
  /** Numéro de billet affichable (4 chiffres, stable). Absent des serveurs antérieurs. */
  number?: string | number | null;
}
/** Corps de `PUT /user/invites/:id` : seuls les champs envoyés sont modifiés. */
export interface InviteUpdate {
  message?: string;
  picks?: InvitePick[];
}
export interface InvitesDto {
  quota: number;
  invites: InviteDto[];
}
const enc = encodeURIComponent;

export const getInvites = () => call<InvitesDto>('/invites');
export const markInviteSent = (id: string, sent: boolean) => call<void>('/invites/' + enc(id) + '/sent', { method: 'PUT', body: { sent } });
export const revokeInvite = (id: string) => call<{ invite: InviteDto }>('/invites/' + enc(id), { method: 'DELETE' });
/** Mot et coups de cœur d'un billet (`PUT /user/invites/:id`). Accepte une invite nue ou enveloppée dans `invite`. */
export const updateInvite = async (id: string, body: InviteUpdate): Promise<InviteDto | null> => {
  const res = await call<InviteDto | { invite: InviteDto } | undefined>('/invites/' + enc(id), { method: 'PUT', body });
  if (!res) return null;
  return 'invite' in res ? res.invite : res;
};
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
  avatar?: string;
  status: FriendStatus;
  since: string;
  watching?: Watching | null;
}
export interface FriendRequestDto {
  username: string;
  avatarColor: string;
  avatar?: string;
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
  avatar?: string;
  host?: boolean;
  muted?: boolean;
  joinedAt?: string;
  /** Identifiant de pair pour la signalisation WebRTC du partage de lecture. */
  peerId?: string;
  /** Invité (lien d'invitation, sans compte). */
  guest?: boolean;
  /** Préparation avant le départ (Social v3) : prêt, qualité choisie, état. Absents des serveurs antérieurs. */
  ready?: boolean;
  quality?: string | null;
  status?: 'searching' | 'ready' | 'buffering';
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
/** Invitation d'un invité (sans compte) : jeton à placer dans le lien `#/party/join/<id>?t=<jeton>`. Réservé à l'hôte. */
export interface PartyInvite {
  token: string;
  expiresAt: string;
}
export const createPartyInvite = (id: string, profileId: string) => call<PartyInvite>('/' + enc(id) + '/invite', { ...party, method: 'POST', body: { profileId } });
/**
 * Lien d'invitation partagé du salon (hôte seulement) : un seul jeton multi-usage, non lié à un pseudo, valable jusqu'à la fin
 * du salon. `rotate` (« Nouveau lien ») invalide les liens précédents ; sans lui, le lien rendu est toujours le même.
 */
export const createPartyInviteLink = (id: string, profileId: string, rotate = false) =>
  call<PartyInvite>('/' + enc(id) + '/invite-link', { ...party, method: 'POST', body: { profileId, rotate } });
/**
 * Invitation ciblée d'un ami dans le salon (Social v3) : crée un message « invitation » dans la discussion directe et
 * notifie l'ami en temps réel. Réservé à un membre connecté au salon (compte, pas invité). `actorPid` : profil social agissant
 * (X-Profile-Id).
 */
export const inviteFriendToParty = (id: string, pid: string, actorPid: string) =>
  call<{ message: unknown }>('/' + enc(id) + '/invite', { ...party, method: 'POST', body: { pid }, headers: { 'x-profile-id': actorPid } });
/** Séance d'un invité entré par le lien partagé : jeton individuel (à présenter à la WebSocket) et pseudo attribué (unique). */
export interface GuestEntry {
  sessionToken: string;
  expiresAt: string;
  name: string;
}
/** Entrée d'un invité (sans compte) : jeton du lien + pseudo souhaité. */
export const enterPartyAsGuest = (id: string, token: string, name: string) =>
  call<GuestEntry>('/' + enc(id) + '/guest', { ...party, method: 'POST', body: { token, name }, anonymous: true });
