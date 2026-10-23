/**
 * API sociale de lastaddon (`/user/social/*`) : formes des RÉPONSES, telles que le serveur les émet. Source de vérité :
 * lastaddon/src/user (social-v2-store.ts, social-v3-store.ts, social-v2-activity.ts, social-store.ts) et les routes qui les
 * sérialisent. Types seulement : aucune valeur à l'exécution, aucune dépendance. Les corps de requête ne sont pas décrits
 * ici. Un champ optionnel (`?`) est un champ que le serveur peut omettre ; tout autre champ est toujours présent.
 */
import type { RoomInfo } from './party.js';
/** Genre d'un titre. */
export type MediaKind = 'movie' | 'series';
/** Statut choisi par le profil (`GET /social/me`, `PUT /social/status`). */
export type Status = 'online' | 'away' | 'dnd' | 'invisible';
/** Statut tel qu'un autre profil le voit : `offline` remplace `invisible`. */
export type SeenStatus = 'online' | 'away' | 'dnd' | 'offline';
/** Handle `Nom#TAG`. */
export interface Handle {
    name: string;
    tag: string;
    /** `Nom#TAG`. */
    full: string;
}
/** Statut personnalisé : emoji, texte (60 caractères au plus), échéance en ms. Absent une fois expiré. */
export interface CustomStatus {
    emoji?: string;
    text?: string;
    expiresAt?: number;
}
/**
 * Titre en cours, tel qu'un autre profil le voit. `pos` et `at` (ms) sont absents quand le profil ne partage pas sa
 * position (préférence `watchWith` = « never »). `movedAt` : dernier instant (ms) où la lecture a avancé.
 */
export interface Watching {
    type: MediaKind;
    tmdbId: number;
    imdbId?: string;
    title: string;
    season?: number;
    episode?: number;
    poster?: string;
    pos?: number;
    duration?: number;
    paused: boolean;
    at?: number;
    movedAt?: number;
}
/** Ami ou membre du foyer, vu depuis le profil agissant (`FriendView` côté serveur). */
export interface FriendView {
    pid: string;
    handle: Handle;
    avatarColor: string;
    avatar?: string;
    customStatus?: CustomStatus;
    status: SeenStatus;
    watching?: Watching;
    /** Dernier battement (ms). Absent pour un profil invisible ou jamais vu, ou si l'activité est masquée. */
    lastSeen?: number;
    household: boolean;
    /** Favori et surnom viennent de la relation posée par le profil agissant ; `false` et sans surnom pour le foyer. */
    favorite: boolean;
    nickname?: string;
    muted: boolean;
}
/** Fiche ami (contrat v3) : même forme que `FriendView`, qui porte déjà les réglages de relation côté serveur. */
export type FriendV3 = FriendView;
/** Demande d'ami reçue (`incoming`) ou envoyée (`outgoing`). */
export interface FriendRequest {
    pid: string;
    handle: Handle;
    avatarColor: string;
    avatar?: string;
    createdAt: number;
}
/** `GET /social/friends`. */
export interface FriendsResponse {
    friends: FriendView[];
    household: FriendView[];
    incoming: FriendRequest[];
    outgoing: FriendRequest[];
}
/** `POST /social/requests` : 201 `{ request }` ; 200 `{ friend }` si l'autre avait déjà demandé (demande croisée). */
export type RequestOutcome = {
    request: FriendRequest;
} | {
    friend: FriendView;
};
/** `GET /social/me` : le profil agissant et son statut choisi. */
export interface SocialMe {
    pid: string;
    handle: Handle;
    status: Status;
    avatarColor: string;
    avatar?: string;
}
/** Élément de bibliothèque partagée d'un ami ou du foyer. */
export interface LibraryItem {
    type: MediaKind;
    tmdbId: number | null;
    imdbId: string | null;
    title: string;
    poster: string | null;
    addedAt: string;
}
/** `GET /social/friends/:pid/library` : la page demandée, avec sa pagination. */
export interface FriendLibrary {
    items: LibraryItem[];
    total: number;
    limit: number;
    offset: number;
}
/** Entrée d'historique d'un ami ou du foyer, du plus récent au plus ancien. */
export interface HistoryItem {
    type: MediaKind;
    tmdbId: number;
    title?: string;
    poster?: string;
    season?: number;
    episode?: number;
    pos: number;
    duration?: number;
    watched: boolean;
    updatedAt: number;
}
/** Référence à un titre. Saison et épisode ne servent qu'à une série. */
export interface MediaRef {
    type: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
}
/** Contexte d'un message : titre et position (s) de la lecture au moment de l'envoi. */
export interface MessageContext extends MediaRef {
    pos?: number;
}
export type MessageKind = 'text' | 'title' | 'moment' | 'party' | 'poll';
/** Titre partagé (`kind: 'title'`). `rating` : note de l'expéditeur sur 5. */
export interface TitleRef {
    type: MediaKind;
    tmdbId: number;
    title: string;
    poster?: string;
    year?: number;
    rating?: number;
}
/** Moment d'un titre (`kind: 'moment'`) ; `end` absent pour une position unique, `still` : image TMDB. */
export interface MomentRef {
    type: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
    title: string;
    pos: number;
    end?: number;
    still?: string;
}
/** Invitation à un salon de visionnage (`kind: 'party'`). */
export interface PartyRef {
    partyId: string;
    title: string;
}
/** Réaction agrégée sur un message ; `mine` : posée par le profil qui regarde. */
export interface Reaction {
    emoji: string;
    count: number;
    mine: boolean;
}
/** Option d'un sondage ; aucun votant n'est identifié. */
export interface PollOption {
    id: string;
    label: string;
    votes: number;
    mine: boolean;
}
/** Sondage (`kind: 'poll'`) ; `id` est celui de son message. */
export interface Poll {
    id: string;
    question: string;
    options: PollOption[];
    closed: boolean;
}
/**
 * Message vu par un profil. `conv` : conversation vue de ce profil (`dm:<pid de l'autre>` ou `g:<id>`). `from` : pid de
 * l'expéditeur. `to` : pid du destinataire, absent d'un message de groupe. Présent sur toutes les réponses qui le contiennent.
 */
export interface Message {
    id: string;
    conv: string;
    from: string;
    to?: string;
    kind: MessageKind;
    body: string;
    context?: MessageContext;
    title?: TitleRef;
    moment?: MomentRef;
    party?: PartyRef;
    poll?: Poll;
    reactions: Reaction[];
    replyTo?: string;
    createdAt: number;
    readAt?: number;
}
/** Message de la conversation par conversation (contrat v3) : même forme que `Message`. */
export type MessageV3 = Message;
/** Groupe vu par un de ses membres. `members` : les autres membres (le profil qui regarde n'y figure pas). */
export interface GroupInfo {
    id: string;
    name: string;
    /** Propriétaire (pid) : seul à renommer le groupe et à changer ses membres. */
    ownerPid: string;
    members: FriendView[];
}
interface ConversationBase {
    conv: string;
    last?: Message;
    unread: number;
}
/** Conversation directe (`dm:<pid>`). */
export interface Conversation extends ConversationBase {
    pid: string;
    handle: Handle;
    avatarColor: string;
}
/** Conversation de groupe (`g:<id>`) : pas de `pid` ni de `handle`, le groupe porte les membres. */
export interface GroupConversation extends ConversationBase {
    group: GroupInfo;
}
/** Entrée de `GET /social/conversations` : directe ou de groupe. Discriminer avec `'group' in c`. */
export type ConversationV3 = Conversation | GroupConversation;
/** Auteur d'une note. */
export interface NoteAuthor {
    pid: string;
    handle: Handle;
    avatarColor: string;
    avatar?: string;
}
/** Note posée sur un titre, à un instant du film. */
export interface Note {
    id: string;
    author: NoteAuthor;
    pos: number;
    kind: 'text' | 'emoji';
    body: string;
    createdAt: number;
}
/** Note d'un ami avec son titre ; `hidden` : corps vide, masqué par l'anti-spoiler du lecteur. */
export interface FriendNote extends Note {
    media: MediaRef;
    hidden?: true;
}
/** Bannière du profil : un titre TMDB, cadré par `posY` (% vertical, absent = centré). */
export interface ProfileBanner {
    tmdbId: number;
    type: MediaKind;
    backdrop: string;
    title: string;
    posY?: number;
}
/** Favori du profil (4 au plus, ordonnés). */
export interface ProfileFavorite {
    tmdbId: number;
    type: MediaKind;
    title: string;
    poster?: string;
}
/** Chiffres du profil. `hoursWatched` et `notes` sont absents quand l'historique du profil est masqué à un ami. */
export interface ProfileStats {
    hoursWatched?: number;
    notes?: number;
    friends: number;
}
/**
 * Profil social étendu (`GET /social/profile`, `GET /social/friends/:pid/profile`). `tagChangeableAt` n'est vu que par le
 * profil lui-même ; `friendSince`, `commonTitles` et `mutualFriends` que par un autre profil.
 */
export interface SocialProfile {
    pid: string;
    handle: Handle;
    avatarColor: string;
    avatar?: string;
    bio?: string;
    customStatus?: CustomStatus;
    banner?: ProfileBanner;
    favorites: ProfileFavorite[];
    stats: ProfileStats;
    friendSince?: number;
    commonTitles?: number;
    mutualFriends?: number;
    tagChangeableAt?: number;
}
/** Mode de lecture partagée. */
export type PlaybackSocial = 'all' | 'messages' | 'cinema';
/** Notifications d'un profil. */
export interface NotifyPrefs {
    messages: boolean;
    requests: boolean;
    parties: boolean;
    friendStarts: boolean;
    vibrate: boolean;
    sound: boolean;
}
/** Préférences d'un profil (`GET /social/prefs`, `PUT /social/prefs`). */
export interface SocialPrefs {
    activityVisibility: 'friends' | 'favorites' | 'nobody';
    watchWith: 'open' | 'ask' | 'never';
    libraryVisibility: 'friends' | 'household' | 'private';
    messagesFrom: 'friends' | 'favorites' | 'household';
    historyVisible: boolean;
    antiSpoiler: boolean;
    playbackSocial: PlaybackSocial;
    notify: NotifyPrefs;
}
/** Lien public créé (`POST /social/share-links`). `inviteCode` : invitation réservée, si demandée. */
export interface ShareLinkCreated {
    url: string;
    code: string;
    inviteCode?: string;
}
/** Lecture publique d'un lien (`GET /social/share-links/:code`, sans session). Aucun pid ni bibliothèque. */
export interface ShareLinkView {
    type: MediaKind;
    tmdbId: number;
    title: string;
    poster?: string;
    pos?: number;
    end?: number;
    from: {
        handle: Handle;
        avatarColor: string;
    };
    note?: string;
    inviteCode?: string;
}
/** Un de mes liens publics (`GET /social/share-links`), expirés compris ; `expired` vaut vrai après 30 jours. */
export interface MyShareLink {
    code: string;
    url: string;
    type: MediaKind;
    tmdbId: number;
    title: string;
    poster?: string;
    pos?: number;
    end?: number;
    note?: string;
    inviteCode?: string;
    createdAt: number;
    expiresAt: number;
    expired: boolean;
}
/** Titre d'une liste partagée. */
export interface ListItem {
    type: MediaKind;
    tmdbId: number;
    title: string;
    poster?: string;
    addedBy: string;
    addedAt: number;
}
/** Liste partagée, sans son contenu (`GET /social/lists`). */
export interface ListSummary {
    id: string;
    name: string;
    members: FriendView[];
    count: number;
}
/** Liste partagée avec son contenu (`GET /social/lists/:id`, et la réponse à sa création ou à sa modification). */
export interface ListDetail {
    id: string;
    name: string;
    members: FriendView[];
    items: ListItem[];
}
/** Genre d'événement d'activité : débuts et fins de lecture, notes posées, notes sur 5, favoris et listes. */
export type ActivityKind = 'started' | 'finished' | 'rated' | 'noted' | 'favorited' | 'listed';
/** Titre d'un événement d'activité, figé à l'écriture. Saison et épisode absents pour un film. */
export interface ActivityMedia {
    type: MediaKind;
    tmdbId: number;
    title: string;
    poster?: string;
    season?: number;
    episode?: number;
}
/** Événement d'activité (`GET /social/activity`). Aucun identifiant interne au-delà de `id`. */
export interface ActivityItem {
    id: string;
    pid: string;
    handle: Handle;
    avatarColor: string;
    avatar?: string;
    kind: ActivityKind;
    media: ActivityMedia;
    /** Note sur 5, par demi-étoiles. */
    rating?: number;
    /** Instant de l'événement (ms). */
    at: number;
}
/** Résumé de ce qui a été manqué depuis un instant (`GET /social/missed`), pour la fin du mode cinéma. */
export interface MissedSummary {
    messages: number;
    byFriend: Array<{
        pid: string;
        handle: Handle;
        count: number;
    }>;
    notes: Note[];
}
/** État d'un billet : libre, envoyé, utilisé, ou révoqué par l'administration. */
export type InviteState = 'free' | 'sent' | 'used' | 'revoked';
/** Coup de cœur joint à un billet ; `type` est une chaîne libre (20 caractères au plus) côté serveur. */
export interface InvitePick {
    id: string;
    type: string;
    name: string;
    poster: string;
    background: string;
}
/** Billet de parrainage du compte, tel que renvoyé par `GET /user/invites` et `PUT`/`DELETE /user/invites/:id`. */
export interface InviteDto {
    id: string;
    code: string;
    state: InviteState;
    createdAt: string;
    sentAt: string | null;
    usedAt: string | null;
    /** Date de révocation par l'administration (ISO), ou null. */
    revokedAt: string | null;
    /** Message du billet, ou null. */
    message: string | null;
    /** Coups de cœur du billet (3 au plus ; tableau vide si aucun). */
    picks: InvitePick[];
    /** Échéance du billet envoyé (ISO), ou null tant qu'il n'est pas envoyé. */
    expiresAt: string | null;
    /** Numéro de billet à 4 chiffres (1000 à 9999), stable pour un lien. */
    number: number;
    /** Pseudo du filleul, ou null. */
    invitee: string | null;
}
/** `GET /user/invites` : quota du compte et ses billets. */
export interface InvitesDto {
    quota: number;
    invites: InviteDto[];
}
/** Titre masqué d'un profil. */
export interface HiddenItemDto {
    key: string;
    title: string;
    poster: string;
    /** Instant où le titre a été masqué (ms). */
    addedAt: number;
}
/** Page de titres masqués, du plus récent au plus ancien. */
export interface HiddenPageDto {
    items: HiddenItemDto[];
    total: number;
    nextCursor: string | null;
}
/** Salon public, ligne de l'annuaire (`GET /party`). */
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
/** Ticket de connexion au salon (`POST /party/:id/join`) : à présenter à la WebSocket avant son expiration. */
export interface JoinTicket {
    ticket: string;
    expiresAt: string;
    wsPath: string;
    room: RoomInfo;
}
/** Lien d'invitation partagé du salon (`POST /party/:id/invite-link`, hôte seul). */
export interface PartyInvite {
    token: string;
    expiresAt: string;
}
/** Séance d'un invité sans compte entré par le lien partagé (`POST /party/:id/guest`). */
export interface GuestEntry {
    sessionToken: string;
    expiresAt: string;
    /** Pseudo attribué par le serveur (unique dans le salon). */
    name: string;
    /** Avatar retenu par le serveur ; absent : la lettre sur la couleur des invités. */
    avatar?: string;
}
export {};
