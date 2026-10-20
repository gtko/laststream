import { call, type MediaKind, type Visibility } from './userApi';
import type { InviteCheck } from './invite';

/* Ce qui reste de l'API sociale « v1 » de lastAddon (docs/social.md) et n'a pas d'équivalent dans /user/social (v2/v3) :
 * parrainage (liens d'invitation), visibilité des titres de la bibliothèque, titres masqués et salons de visionnage (REST).
 * Les amis, la présence et la bibliothèque d'un ami passent par socialV2Api.ts (par pid) ; ne rien rajouter ici de ce côté. */

// ---- Parrainage ----
export type InviteState = 'free' | 'sent' | 'used' | 'revoked';
/**
 * Coup de cœur d'un billet : un titre de la bibliothèque du parrain (3 au plus). L'identifiant est une chaîne (le serveur refuse
 * un nombre). Affiche et fond : URL https, ou chaîne vide (jamais null).
 */
export interface InvitePick {
  id: string;
  type: MediaKind;
  name: string;
  poster: string;
  background: string;
}
/** Billet tel que renvoyé par `GET /user/invites` et `PUT`/`DELETE /user/invites/:id` (enveloppé dans `invite` pour ces deux-ci). */
export interface InviteDto {
  id: string;
  code: string;
  state: InviteState;
  createdAt: string;
  sentAt: string | null;
  usedAt: string | null;
  /** Date de révocation par l'administrateur (ISO), ou null : le lien ne fonctionne plus et n'est plus partageable. */
  revokedAt?: string | null;
  /** Mot du parrain (≤ 280 caractères), affiché sur la page d'arrivée du filleul. Absent des serveurs antérieurs. */
  message?: string | null;
  /** Coups de cœur (≤ 3). Absent des serveurs antérieurs : tenu pour une liste vide. */
  picks?: InvitePick[];
  /** Fin de validité du billet envoyé (ISO) : envoi + 14 jours. Null tant que le billet est libre. */
  expiresAt?: string | null;
  /** Numéro de billet (entier de 1000 à 9999, stable pour un lien). Absent des serveurs antérieurs. */
  number?: number | null;
  /** Pseudo du filleul (null : lien libre, ou compte supprimé). */
  invitee: string | null;
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
/** Mot et coups de cœur d'un billet (`PUT /user/invites/:id`, réponse `{ invite }`). Sans réponse (204), renvoie null. */
export const updateInvite = async (id: string, body: InviteUpdate): Promise<InviteDto | null> => {
  const res = await call<{ invite: InviteDto } | undefined>('/invites/' + enc(id), { method: 'PUT', body });
  return res?.invite ?? null;
};
/** Vérification publique d'un lien (`GET /user/invites/check`) : valide avec le billet, ou `{ valid: false, reason }`. */
export const checkInvite = (code: string) =>
  call<InviteCheck>('/invites/check?code=' + enc(code), { anonymous: true });
export const setInviteQuota = (username: string, quota: number) =>
  call<{ username: string; quota: number }>('/accounts/' + enc(username) + '/invite-quota', { method: 'PUT', body: { quota } });

// ---- Visibilité des titres de la bibliothèque ----
const PF = (id: string) => '/profiles/' + enc(id);
export const setItemVisibility = (profileId: string, type: MediaKind, itemId: number | string, visibility: Visibility) =>
  call<void>(`${PF(profileId)}/library/${type}/${enc(String(itemId))}/visibility`, { method: 'PUT', body: { visibility }, profileId });
export const setAllVisibility = (profileId: string, visibility: Visibility, type?: MediaKind) =>
  call<{ updated: number }>(PF(profileId) + '/library/visibility', { method: 'PUT', body: { visibility, ...(type ? { type } : {}) }, profileId });

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
export const createParty = (body: CreatePartyBody) => call<{ room: PartyRoom }>('', { ...party, method: 'POST', body, profileId: body.profileId });
export const listParties = (profileId: string, o: { language?: string; limit?: number; cursor?: string | null } = {}) => {
  const q = new URLSearchParams({ profileId });
  if (o.language) q.set('language', o.language);
  if (o.limit) q.set('limit', String(o.limit));
  if (o.cursor) q.set('cursor', o.cursor);
  return call<{ rooms: PartyListItem[]; nextCursor: string | null }>('?' + q.toString(), { ...party, profileId });
};
export const getParty = (id: string) => call<{ room: PartyRoom }>('/' + enc(id), party);
export interface JoinTicket {
  ticket: string;
  expiresAt: string;
  wsPath: string;
  room: PartyRoom;
}
export const joinParty = (id: string, profileId: string) => call<JoinTicket>('/' + enc(id) + '/join', { ...party, method: 'POST', body: { profileId }, profileId });
export const endParty = (id: string) => call<void>('/' + enc(id), { ...party, method: 'DELETE' });
/** Invitation d'un invité (sans compte) : jeton à placer dans le lien `#/party/join/<id>?t=<jeton>`. Réservé à l'hôte. */
export interface PartyInvite {
  token: string;
  expiresAt: string;
}
export const createPartyInvite = (id: string, profileId: string) => call<PartyInvite>('/' + enc(id) + '/invite', { ...party, method: 'POST', body: { profileId }, profileId });
/**
 * Lien d'invitation partagé du salon (hôte seulement) : un seul jeton multi-usage, non lié à un pseudo, valable jusqu'à la fin
 * du salon. `rotate` (« Nouveau lien ») invalide les liens précédents ; sans lui, le lien rendu est toujours le même.
 */
export const createPartyInviteLink = (id: string, profileId: string, rotate = false) =>
  call<PartyInvite>('/' + enc(id) + '/invite-link', { ...party, method: 'POST', body: { profileId, rotate }, profileId });
/**
 * Invitation ciblée d'un ami dans le salon (Social v3) : crée un message « invitation » dans la discussion directe et
 * notifie l'ami en temps réel. Réservé à un membre connecté au salon (compte, pas invité). `actorPid` : profil social agissant
 * (X-Profile-Id).
 */
export const inviteFriendToParty = (id: string, pid: string, actorPid: string) =>
  call<{ message: unknown }>('/' + enc(id) + '/invite', { ...party, method: 'POST', body: { pid }, profileId: actorPid, headers: { 'x-profile-id': actorPid } });
/** Séance d'un invité entré par le lien partagé : jeton individuel (à présenter à la WebSocket) et pseudo attribué (unique). */
export interface GuestEntry {
  sessionToken: string;
  expiresAt: string;
  name: string;
  /** Avatar retenu par le serveur (absent : lettre sur la couleur des invités). */
  avatar?: string;
}
/** Entrée d'un invité (sans compte) : jeton du lien + pseudo souhaité. */
export const enterPartyAsGuest = (id: string, token: string, name: string, avatar?: string) =>
  call<GuestEntry>('/' + enc(id) + '/guest', { ...party, method: 'POST', body: { token, name, ...(avatar ? { avatar } : {}) }, anonymous: true });
