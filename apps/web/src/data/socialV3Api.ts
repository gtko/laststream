import { SOCIAL, social, withQuery } from './socialHttp';
import { call, type MediaKind } from './userApi';
import type { Conversation, FriendView, Handle, Message, Note } from './socialV2Api';

/* Client typé de l'API sociale v3 (`/user/social/*`, contrat docs/social-v3-contract.md, sections S1 à S5) : profil étendu,
 * préférences, relations, blocages, signalements, demandes de rejoindre, messages riches par conversation (DM `dm:<pid>` et
 * groupes `g:<id>`), réactions, sondages, saisie, groupes, partage, liens publics, listes partagées, activité, heatmap et
 * résumé de fin de mode cinéma. Les en-têtes sont ceux de la v2 (X-Profile-Id, X-Profile-Token via `call`) ; la lecture
 * publique d'un lien partagé part sans session. Aucun texte n'est affiché ici. */

// ---- S1 : profil ----
export type CustomStatus = { emoji?: string; text?: string; expiresAt?: number };
export type ProfileBanner = { tmdbId: number; type: MediaKind; backdrop: string; title: string };
export type ProfileFavorite = { tmdbId: number; type: MediaKind; title: string; poster?: string };
export type ProfileStats = { hoursWatched: number; notes: number; friends: number };
/** Profil social étendu. `friendSince`, `commonTitles`, `mutualFriends` ne sont vus que par un autre profil ; `tagChangeableAt` que par moi. */
export type SocialProfile = {
  pid: string; handle: Handle; avatarColor: string; avatar?: string;
  bio?: string; customStatus?: CustomStatus; banner?: ProfileBanner; favorites: ProfileFavorite[];
  stats?: ProfileStats; friendSince?: number; commonTitles?: number; mutualFriends?: number; tagChangeableAt?: number;
};
/** `PUT /profile` : corps partiel ; `null` efface la bio, le statut ou la bannière. */
export type ProfilePatch = {
  name?: string; avatarColor?: string; bio?: string | null; customStatus?: CustomStatus | null;
  banner?: ProfileBanner | null; favorites?: ProfileFavorite[];
};
/** `POST /profile/tag` : le contrat ne décrit pas la réponse ; on lit `handle` et l'échéance facultative. */
export type TagResult = { handle: Handle; tagChangeableAt?: number };

// ---- S2 : préférences, relations, blocages, signalements, demandes de rejoindre ----
export type ActivityVisibility = 'friends' | 'favorites' | 'nobody';
export type WatchWith = 'open' | 'ask' | 'never';
export type LibraryVisibility = 'friends' | 'household' | 'private';
export type MessagesFrom = 'friends' | 'favorites' | 'household';
export type PlaybackSocial = 'all' | 'messages' | 'cinema';
export type NotifyPrefs = { messages: boolean; requests: boolean; parties: boolean; friendStarts: boolean; vibrate: boolean; sound: boolean };
export type SocialPrefs = {
  activityVisibility: ActivityVisibility; watchWith: WatchWith; libraryVisibility: LibraryVisibility; messagesFrom: MessagesFrom;
  historyVisible: boolean; antiSpoiler: boolean; playbackSocial: PlaybackSocial; notify: NotifyPrefs;
};
export type PrefsPatch = Partial<Omit<SocialPrefs, 'notify'>> & { notify?: Partial<NotifyPrefs> };
/** Défauts serveur (contrat S2), pour les écrans qui s'affichent avant la première réponse. */
export const DEFAULT_PREFS: SocialPrefs = {
  activityVisibility: 'friends', watchWith: 'ask', libraryVisibility: 'friends', messagesFrom: 'friends',
  historyVisible: true, antiSpoiler: true, playbackSocial: 'all',
  notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
};

/** Fiche ami v3 : `FriendView` plus les réglages de relation. Optionnels au type, car une réponse ou une fixture v2 ne les porte pas. */
export type FriendV3 = FriendView & { customStatus?: CustomStatus; favorite?: boolean; nickname?: string; muted?: boolean; hideActivity?: boolean; avatar?: string };
/** `PUT /friends/:pid/relation` : `nickname` ≤ 32 caractères, `null` pour l'effacer. */
export type RelationPatch = { favorite?: boolean; nickname?: string | null; muted?: boolean; hideActivity?: boolean };
export type BlockedPerson = { pid: string; handle: Handle };
export type ReportReason = 'spam' | 'harassment' | 'other';
export type ReportInput = { pid: string; reason: ReportReason; details?: string };
export type JoinAnswer = { accept: boolean; partyId?: string };

// ---- S3 : messages riches, réactions, sondages, groupes, partage, listes ----
export type MessageKind = 'text' | 'title' | 'moment' | 'party' | 'poll';
export type TitleRef = { type: MediaKind; tmdbId: number; title: string; poster?: string; year?: number; rating?: number };
export type MomentRef = { type: MediaKind; tmdbId: number; season?: number; episode?: number; title: string; pos: number; still?: string };
export type PartyRef = { partyId: string; title: string };
export type PollOption = { id: string; label: string; votes: number; mine: boolean };
export type Poll = { id: string; question: string; options: PollOption[]; closed: boolean };
export type Reaction = { emoji: string; count: number; mine: boolean };
/** Message v3 : `conv` est `dm:<pid>` ou `g:<id>`. Le `Message` v2 reste valable comme sous-ensemble. */
export type MessageV3 = Message & {
  conv: string; kind: MessageKind;
  title?: TitleRef; moment?: MomentRef; party?: PartyRef; poll?: Poll;
  reactions: Reaction[]; replyTo?: string;
};
/** `ownerPid` : le propriétaire (seul à renommer et à changer les membres). Absent d'un serveur plus ancien : personne n'est alors propriétaire côté client. */
export type GroupInfo = { id: string; name: string; members: FriendV3[]; ownerPid?: string };
/** Conversation v3 : une conversation directe ou un groupe (`group` présent). */
export type ConversationV3 = Conversation & { conv: string; group?: GroupInfo };
/** Corps de `POST /conv/:conv/messages`. `party` n'est plus envoyable par là : l'invitation passe par `POST /party/:id/invite {pid}`. */
export type NewMessage = {
  kind: Exclude<MessageKind, 'party'>; body?: string;
  title?: TitleRef; moment?: MomentRef; party?: PartyRef;
  poll?: { question: string; options: string[] }; replyTo?: string;
};
export type ShareTarget = { pid: string } | { group: string };
export type ShareInput = { to: ShareTarget[]; kind: 'title' | 'moment'; title?: TitleRef; moment?: MomentRef; body?: string };
export type ShareLinkInput = { type: MediaKind; tmdbId: number; pos?: number; withInvite: boolean; note?: string };
export type ShareLinkCreated = { url: string; code: string; inviteCode?: string };
export type ShareLinkView = {
  type: MediaKind; tmdbId: number; title: string; poster: string; pos?: number;
  from: { handle: Handle; avatarColor: string }; note?: string; inviteCode?: string;
};
/** Un de mes liens publics (`GET /share-links`) ; `expired` vaut true après 30 jours. */
export type MyShareLink = {
  code: string; url: string; type: MediaKind; tmdbId: number; title: string; poster?: string; pos?: number; note?: string;
  inviteCode?: string; createdAt: number; expiresAt: number; expired: boolean;
};
export type ListSummary = { id: string; name: string; members: FriendV3[]; count: number };
export type ListItem = { type: MediaKind; tmdbId: number; title: string; poster?: string; addedBy: string; addedAt: number };
export type ListDetail = { id: string; name: string; members: FriendV3[]; items: ListItem[] };
export type ListItemInput = { type: MediaKind; tmdbId: number; title: string; poster?: string };

// ---- S5 : activité et agrégats ----
export type ActivityKind = 'started' | 'finished' | 'rated' | 'noted' | 'favorited' | 'listed';
export type ActivityMedia = { type: MediaKind; tmdbId: number; title: string; poster?: string; season?: number; episode?: number };
export type ActivityItem = {
  id: string; pid: string; handle: Handle; avatarColor: string; avatar?: string; kind: ActivityKind;
  media: ActivityMedia; rating?: number; at: number;
};
/** Média visé par une requête d'agrégat : un film, ou un épisode d'une série. */
export type MediaQuery = { type: MediaKind; tmdbId: number; season?: number; episode?: number };
export type MissedSummary = { messages: number; byFriend: Array<{ pid: string; handle: Handle; count: number }>; notes: Note[] };

// ---- Appels ----
const enc = encodeURIComponent;

const mediaParams = (q: MediaQuery) => ({ type: q.type, tmdbId: q.tmdbId, season: q.season, episode: q.episode });

// ---- S1 : profil ----
export const getProfile = () => social<SocialProfile>('GET', '/profile');
export const updateProfile = (patch: ProfilePatch) => social<SocialProfile>('PUT', '/profile', patch);
/** Tire un nouveau tag ; 429 `tag_cooldown` si le dernier date de moins de 30 jours. */
export const rerollTag = () => social<TagResult>('POST', '/profile/tag');
export const getFriendProfile = (pid: string) => social<SocialProfile>('GET', `/friends/${enc(pid)}/profile`);

// ---- S2 : préférences, relations, blocages, signalements, demandes de rejoindre ----
export const getPrefs = () => social<SocialPrefs>('GET', '/prefs');
export const updatePrefs = (patch: PrefsPatch) => social<SocialPrefs>('PUT', '/prefs', patch);
export const updateRelation = (pid: string, patch: RelationPatch) => social<FriendV3>('PUT', `/friends/${enc(pid)}/relation`, patch);
export const getBlocks = () => social<{ blocked: BlockedPerson[] }>('GET', '/blocks');
export const blockUser = (pid: string) => social<void>('POST', `/blocks/${enc(pid)}`);
export const unblockUser = (pid: string) => social<void>('DELETE', `/blocks/${enc(pid)}`);
/** Signalement : 201 sans corps. */
export const reportUser = (input: ReportInput) => social<void>('POST', '/reports', input);
/** Demande de rejoindre le salon d'un ami ; refusée (403) si son `watchWith` vaut `never`. */
export const requestJoin = (pid: string) => social<void>('POST', `/friends/${enc(pid)}/join-request`);
export const answerJoin = (pid: string, answer: JoinAnswer) => social<void>('POST', `/join-requests/${enc(pid)}`, answer);

// ---- S3 : conversations, messages, réactions, sondages, saisie ----
/** Conversations v3 (directes et groupes), même route que la v2. */
export const listConversations = () => social<{ conversations: ConversationV3[] }>('GET', '/conversations');
export const getConvMessages = (conv: string, o: { before?: number; limit?: number } = {}) =>
  social<{ messages: MessageV3[] }>('GET', withQuery(`/conv/${enc(conv)}/messages`, { before: o.before, limit: o.limit }));
export const sendConvMessage = (conv: string, m: NewMessage) => social<{ message: MessageV3 }>('POST', `/conv/${enc(conv)}/messages`, m);
export const markConvRead = (conv: string) => social<void>('PUT', `/conv/${enc(conv)}/read`);
/** Bascule une réaction ; renvoie les réactions du message. */
export const toggleReaction = (conv: string, id: string, emoji: string) =>
  social<{ reactions: Reaction[] }>('POST', `/conv/${enc(conv)}/messages/${enc(id)}/reactions`, { emoji });
export const votePoll = (conv: string, pollId: string, optionId: string) =>
  social<{ poll: Poll }>('POST', `/conv/${enc(conv)}/polls/${enc(pollId)}/vote`, { optionId });
/** Saisie : au plus une fois toutes les 3 s côté serveur. */
export const sendTyping = (conv: string) => social<void>('POST', `/conv/${enc(conv)}/typing`);

// ---- S3 : groupes ----
export const createGroup = (input: { name: string; members: string[] }) => social<ConversationV3>('POST', '/groups', input);
export const updateGroup = (id: string, patch: { name?: string; add?: string[]; remove?: string[] }) =>
  social<void>('PUT', `/groups/${enc(id)}`, patch);
/** Quitter un groupe. */
export const leaveGroup = (id: string) => social<void>('DELETE', `/groups/${enc(id)}/me`);

// ---- S3 : partage ----
export const shareTo = (input: ShareInput) => social<{ messages: MessageV3[] }>('POST', '/share', input);
export const createShareLink = (input: ShareLinkInput) => social<ShareLinkCreated>('POST', '/share-links', input);
/** Lecture publique d'un lien : sans session ni profil. */
export const getShareLink = (code: string) => call<ShareLinkView>(`${SOCIAL}/share-links/${enc(code)}`, { anonymous: true });
/** Mes liens publics, les plus récents d'abord, expirés compris. */
export const getMyShareLinks = () => social<{ links: MyShareLink[] }>('GET', '/share-links');
/** Révoque un de mes liens (204) ; 404 `share_not_found` s'il n'existe plus. */
export const revokeShareLink = (code: string) => social<void>('DELETE', `/share-links/${enc(code)}`);

// ---- S3 : listes partagées ----
export const getLists = () => social<{ lists: ListSummary[] }>('GET', '/lists');
export const createList = (input: { name: string; members: string[] }) => social<ListSummary>('POST', '/lists', input);
export const getList = (id: string) => social<ListDetail>('GET', `/lists/${enc(id)}`);
export const addListItem = (id: string, item: ListItemInput) => social<void>('POST', `/lists/${enc(id)}/items`, item);
export const removeListItem = (id: string, type: MediaKind, tmdbId: number) =>
  social<void>('DELETE', `/lists/${enc(id)}/items/${type}/${tmdbId}`);
export const updateList = (id: string, patch: { name?: string; add?: string[]; remove?: string[] }) =>
  social<void>('PUT', `/lists/${enc(id)}`, patch);

// ---- S5 : activité, heatmap, résumé ----
export const getActivity = (o: { before?: number; limit?: number } = {}) =>
  social<{ items: ActivityItem[] }>('GET', withQuery('/activity', { before: o.before, limit: o.limit }));
/** Comptes de notes (amis, foyer, moi) par tranche ; 60 tranches par défaut. */
export const getHeatmap = (q: MediaQuery & { buckets?: number }) =>
  social<{ buckets: number[] }>('GET', withQuery('/notes/heatmap', { ...mediaParams(q), buckets: q.buckets ?? 60 }));
/** Résumé de ce qui a été manqué depuis `since` (epoch ms), pour la fin du mode cinéma. */
export const getMissed = (q: MediaQuery & { since: number }) =>
  social<MissedSummary>('GET', withQuery('/missed', { since: q.since, ...mediaParams(q) }));
