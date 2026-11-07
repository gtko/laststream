import type { Fingerprint, PartyMedia, Participant, RoomInfo } from '@laststream/protocol/party';
import type {
  GuestEntry, HiddenPageDto, InviteDto, InvitePick, InvitesDto, JoinTicket, PartyInvite, PartyListItem,
} from '@laststream/protocol/social';
import { call, type MediaKind, type Visibility } from './userApi';

/* Ce qui reste de l'API sociale « v1 » de lastAddon (docs/social.md) et n'a pas d'équivalent dans /user/social (v2/v3) :
 * parrainage (liens d'invitation), visibilité des titres de la bibliothèque, titres masqués et salons de visionnage (REST).
 * Les amis, la présence et la bibliothèque d'un ami passent par socialV2Api.ts (par pid) ; ne rien rajouter ici de ce côté.
 * Les formes de réponse viennent de @laststream/protocol/social (source unique) ; restent ici les corps de requête et
 * les types dérivés côté app (PartyRoom). */

export type {
  GuestEntry, HiddenItemDto, HiddenPageDto, InviteDto, InvitesDto, JoinTicket, PartyInvite, PartyListItem,
} from '@laststream/protocol/social';

// ---- Parrainage ----
/** Corps de `PUT /user/invites/:id` : seuls les champs envoyés sont modifiés. */
export interface InviteUpdate {
  message?: string;
  picks?: InvitePick[];
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
export const setInviteQuota = (username: string, quota: number) =>
  call<{ username: string; quota: number }>('/accounts/' + enc(username) + '/invite-quota', { method: 'PUT', body: { quota } });

// ---- Visibilité des titres de la bibliothèque ----
const PF = (id: string) => '/profiles/' + enc(id);
export const setItemVisibility = (profileId: string, type: MediaKind, itemId: number | string, visibility: Visibility) =>
  call<void>(`${PF(profileId)}/library/${type}/${enc(String(itemId))}/visibility`, { method: 'PUT', body: { visibility }, profileId });
export const setAllVisibility = (profileId: string, visibility: Visibility, type?: MediaKind) =>
  call<{ updated: number }>(PF(profileId) + '/library/visibility', { method: 'PUT', body: { visibility, ...(type ? { type } : {}) }, profileId });

// ---- Titres masqués (par profil) ----
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
/** Formes du salon : source unique dans @laststream/protocol (le serveur en est la référence). */
export type { Fingerprint, PartyMedia } from '@laststream/protocol/party';
export type PartyParticipant = Participant;
/** Salon : `participants` (effectif) est absent de la copie du `welcome` (la liste y est envoyée à part). */
export type PartyRoom = Omit<RoomInfo, 'participants'> & Partial<Pick<RoomInfo, 'participants'>>;
/** Média du corps de création : les champs inconnus sont omis (le serveur refuse `null` sur imdbId, season et episode). */
export type CreatePartyMedia = Pick<PartyMedia, 'type'> & { tmdbId?: number; imdbId?: string; season?: number; episode?: number };
export interface CreatePartyBody {
  profileId: string;
  visibility: PartyVisibility;
  title: string;
  poster?: string | null;
  language?: string;
  media: CreatePartyMedia;
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
export const joinParty = (id: string, profileId: string) => call<JoinTicket>('/' + enc(id) + '/join', { ...party, method: 'POST', body: { profileId }, profileId });
export const endParty = (id: string) => call<void>('/' + enc(id), { ...party, method: 'DELETE' });
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
/** Entrée d'un invité (sans compte) : jeton du lien + pseudo souhaité. */
export const enterPartyAsGuest = (id: string, token: string, name: string, avatar?: string) =>
  call<GuestEntry>('/' + enc(id) + '/guest', { ...party, method: 'POST', body: { token, name, ...(avatar ? { avatar } : {}) }, anonymous: true });
