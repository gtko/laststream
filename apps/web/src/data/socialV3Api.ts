import { SOCIAL, social, withQuery } from './socialHttp';
import { call, type MediaKind } from './userApi';
import type {
  ActivityItem, ConversationV3, CustomStatus, FriendView, GroupConversation, Handle, ListDetail, ListSummary, MessageKind,
  MessageV3, MissedSummary, MomentRef, MyShareLink, NotifyPrefs, Poll, PartyRef, ProfileBanner, ProfileFavorite,
  Reaction, ShareLinkCreated, ShareLinkView, SocialPrefs, SocialProfile, TitleRef,
  HomeProgressResponse, HomeRecommendationsResponse, HomeWatchingResponse, RecommendationInput,
} from '@laststream/protocol/social';

/* Client typé de l'API sociale v3 (`/user/social/*`, contrat docs/social-v3-contract.md, sections S1 à S6) : profil étendu,
 * préférences, relations, blocages, signalements, demandes de rejoindre, messages riches par conversation (DM `dm:<pid>` et
 * groupes `g:<id>`), réactions, sondages, saisie, groupes, partage, liens publics, listes partagées, activité, heatmap,
 * résumé de fin de mode cinéma et accueil social (watching, progression par titre, coups de cœur). Les en-têtes sont ceux de la v2
 * (X-Profile-Id, X-Profile-Token via `call`) ; la lecture publique d'un lien partagé part sans session. Aucun texte n'est affiché ici. Les formes de réponse viennent de
 * @laststream/protocol/social ; seuls les corps de requête, les helpers et les champs que le protocole ne décrit pas
 * restent ici. */

export type {
  ActivityItem, ConversationV3, GroupConversation, ListDetail, ListSummary, MessageV3, MissedSummary, MyShareLink, Poll, PlaybackSocial, Reaction,
  ShareLinkCreated, ShareLinkView, SocialPrefs, SocialProfile,
  HomeProgressResponse, HomeRecommendationsResponse, HomeWatchingResponse, RecommendationInput,
} from '@laststream/protocol/social';

// ---- S1 : profil ----
/** `PUT /profile` : corps partiel ; `null` efface la bio, le statut ou la bannière. */
export type ProfilePatch = {
  name?: string; avatarColor?: string; bio?: string | null; customStatus?: CustomStatus | null;
  banner?: ProfileBanner | null; favorites?: ProfileFavorite[];
};
/** Ce que l'app lit de la réponse de `POST /profile/tag` (un `SocialProfile`) : le handle et l'échéance de changement de tag. */
export type TagResult = { handle: Handle; tagChangeableAt?: number };

// ---- S2 : préférences, relations, blocages, signalements, demandes de rejoindre ----
export type PrefsPatch = Partial<Omit<SocialPrefs, 'notify'>> & { notify?: Partial<NotifyPrefs> };
/** Défauts serveur (contrat S2), pour les écrans qui s'affichent avant la première réponse. */
export const DEFAULT_PREFS: SocialPrefs = {
  activityVisibility: 'friends', watchWith: 'ask', libraryVisibility: 'friends', messagesFrom: 'friends',
  historyVisible: true, antiSpoiler: true, playbackSocial: 'all',
  notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
};

/** Fiche ami v3 : `FriendView` plus `hideActivity`, lu par l'interface et absent du protocole (voir la note de la réponse). */
export type FriendV3 = FriendView & { hideActivity?: boolean };
/** `PUT /friends/:pid/relation` : `nickname` ≤ 32 caractères, `null` pour l'effacer. */
export type RelationPatch = { favorite?: boolean; nickname?: string | null; muted?: boolean; hideActivity?: boolean };
export type BlockedPerson = { pid: string; handle: Handle };
type ReportReason = 'spam' | 'harassment' | 'other';
export type ReportInput = { pid: string; reason: ReportReason; details?: string };
export type JoinAnswer = { accept: boolean; partyId?: string };

// ---- S3 : messages riches, réactions, sondages, groupes, partage, listes ----
/** Corps de `POST /conv/:conv/messages`. `party` n'est plus envoyable par là : l'invitation passe par `POST /party/:id/invite {pid}`. */
export type NewMessage = {
  kind: Exclude<MessageKind, 'party'>; body?: string;
  title?: TitleRef; moment?: MomentRef; party?: PartyRef;
  poll?: { question: string; options: string[] }; replyTo?: string;
};
type ShareTarget = { pid: string } | { group: string };
export type ShareInput = { to: ShareTarget[]; kind: 'title' | 'moment'; title?: TitleRef; moment?: MomentRef; body?: string };
export type ShareLinkInput = { type: MediaKind; tmdbId: number; pos?: number; end?: number; withInvite: boolean; note?: string };
export type ListItemInput = { type: MediaKind; tmdbId: number; title: string; poster?: string };

// ---- S5 : activité et agrégats ----
/** Média visé par une requête d'agrégat : un film, ou un épisode d'une série. */
export type MediaQuery = { type: MediaKind; tmdbId: number; season?: number; episode?: number };

// ---- Appels ----
const enc = encodeURIComponent;

const mediaParams = (q: MediaQuery) => ({ type: q.type, tmdbId: q.tmdbId, season: q.season, episode: q.episode });

// ---- S1 : profil ----
export const getProfile = () => social<SocialProfile>('GET', '/profile');
export const updateProfile = (patch: ProfilePatch) => social<SocialProfile>('PUT', '/profile', patch);
/** Tire un nouveau tag ; 429 `tag_cooldown` si le dernier date de moins de 30 jours. */
export const rerollTag = () => social<SocialProfile>('POST', '/profile/tag');
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
  social<GroupConversation>('PUT', `/groups/${enc(id)}`, patch);
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
  social<ListDetail>('PUT', `/lists/${enc(id)}`, patch);

// ---- S5 : activité, heatmap, résumé ----
export const getActivity = (o: { before?: number; limit?: number } = {}) =>
  social<{ items: ActivityItem[] }>('GET', withQuery('/activity', { before: o.before, limit: o.limit }));
/** Comptes de notes (amis, foyer, moi) par tranche ; 60 tranches par défaut. */
export const getHeatmap = (q: MediaQuery & { buckets?: number }) =>
  social<{ buckets: number[] }>('GET', withQuery('/notes/heatmap', { ...mediaParams(q), buckets: q.buckets ?? 60 }));
/** Résumé de ce qui a été manqué depuis `since` (epoch ms), pour la fin du mode cinéma. */
export const getMissed = (q: MediaQuery & { since: number }) =>
  social<MissedSummary>('GET', withQuery('/missed', { since: q.since, ...mediaParams(q) }));

// ---- S6 : accueil social (`/user/social/home/*` et `/user/social/recommendations`) ----
/** Taille maximale d'une requête `/home/progress` : au-delà, le client envoie plusieurs requêtes. */
const HOME_PROGRESS_BATCH = 20;
/** Requêtes `/home/progress` simultanées au plus. */
const HOME_PROGRESS_CONCURRENCY = 3;
/** Borne haute d'un `tmdbId` accepté par `/home/progress` (la borne basse est 1) ; un id hors bornes est écarté côté client. */
const TMDB_ID_MAX = 999_999_999;
/** Titre interrogé par `/home/progress`. */
export type HomeTitleRef = { type: MediaKind; tmdbId: number };

/** Applique `fn` à chaque élément avec au plus `limit` appels en cours ; le résultat garde l'ordre des éléments. Un échec cesse les lancements. */
const mapPool = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** `GET /home/watching` : une entrée par ami, sa dernière progression des 30 derniers jours. */
export const homeWatching = (limit?: number) => social<HomeWatchingResponse>('GET', withQuery('/home/watching', { limit }));

/**
 * `GET /home/progress?titles=series:123,movie:456` : progression la plus avancée de chaque ami par titre. Les titres sont filtrés
 * (id non entier ou hors 1..999999999 écarté), dédoublonnés sur `type:tmdbId`, puis envoyés par lots de 20 (au plus 3 requêtes
 * simultanées) ; les items sont fusionnés dans l'ordre des lots. Aucun titre valide, aucune requête.
 */
export const homeProgress = async (titles: HomeTitleRef[]): Promise<HomeProgressResponse> => {
  const seen = new Set<string>();
  const valid: HomeTitleRef[] = [];
  for (const t of titles) {
    if (!Number.isInteger(t.tmdbId) || t.tmdbId < 1 || t.tmdbId > TMDB_ID_MAX) continue;
    const key = `${t.type}:${t.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(t);
  }
  const batches: HomeTitleRef[][] = [];
  for (let i = 0; i < valid.length; i += HOME_PROGRESS_BATCH) batches.push(valid.slice(i, i + HOME_PROGRESS_BATCH));
  const pages = await mapPool(batches, HOME_PROGRESS_CONCURRENCY, (b) =>
    social<HomeProgressResponse>('GET', withQuery('/home/progress', { titles: b.map((t) => `${t.type}:${t.tmdbId}`).join(',') })));
  return { items: pages.flatMap((p) => p.items) };
};

/** `GET /home/recommendations` : coups de cœur d'amis, par pages ; `next` est la valeur de `before` de la page suivante. */
export const homeRecommendations = (o: { before?: number; limit?: number } = {}) =>
  social<HomeRecommendationsResponse>('GET', withQuery('/home/recommendations', { before: o.before, limit: o.limit }));
/** `PUT /recommendations` : mon coup de cœur sur un titre (un par titre ; `word` de 1 à 140 caractères). */
export const recommend = (input: RecommendationInput) => social<void>('PUT', '/recommendations', input);
/** `DELETE /recommendations/:type/:tmdbId` : retire mon coup de cœur sur ce titre. */
export const unrecommend = (type: MediaKind, tmdbId: number) => social<void>('DELETE', `/recommendations/${type}/${tmdbId}`);
