import { randomUUID } from 'node:crypto';
import { drawNewHandleTag, revokeLegacyFriendship, syncProfileIdentity } from './social-handles.js';
import { MAX_FRIENDS, MAX_OUTGOING_REQUESTS, PRESENCE_TTL_MS } from './social-store.js';
import type { SqlDb } from './sql.js';

/**
 * Données sociales par profil (v2, messages et groupes v3) : identité (handle `Nom#TAG`, pid), amitiés entre profils,
 * présence, bibliothèque partagée, historique des amis, messages (DM, groupes, réactions, sondages) et notes. Même base
 * que UserStore (SQLite Node ou Durable Object) ; toutes les requêtes sont paramétrées. Les profils sont désignés par leur
 * `pid` public : l'id interne ne sort jamais de ce module.
 *
 * Foyer : les autres profils non enfants du même compte. Ils sont visibles sans demande, et voient toute la bibliothèque
 * et l'historique l'un de l'autre. Un ami n'accède qu'aux titres en visibilité « friends » et à l'historique.
 */

export type SocialStatus = 'online' | 'away' | 'dnd' | 'invisible';
export type SeenStatus = 'online' | 'away' | 'dnd' | 'offline';

export interface Handle {
  name: string;
  tag: string;
  /** `Nom#TAG`. */
  full: string;
}

/** Titre en cours (contrat `Watching`). `pos` et `at` (ms) permettent au client d'extrapoler la position. */
export interface Watching {
  type: 'movie' | 'series';
  tmdbId: number;
  imdbId?: string;
  title: string;
  season?: number;
  episode?: number;
  poster?: string;
  pos: number;
  duration?: number;
  paused: boolean;
  at: number;
}

/** Statut personnalisé (contrat S1) : emoji d'un graphème, texte ≤ 60, échéance facultative (ms). Expiré = absent. */
export interface CustomStatus {
  emoji?: string;
  text?: string;
  expiresAt?: number;
}

/**
 * Titre en cours vu par un autre profil. `pos` et `at` sont absents quand le profil ne partage pas sa position
 * (préférence `watchWith` = « never »).
 */
export type WatchingView = Omit<Watching, 'pos' | 'at'> & Partial<Pick<Watching, 'pos' | 'at'>>;

/** Vue d'un profil telle qu'un autre la voit, sans le drapeau « foyer » (posé par l'appelant). */
export interface SubjectView {
  pid: string;
  handle: Handle;
  avatarColor: string;
  /** Avatar illustré existant du profil (`dicebear:…`, `col:<colId>:<charId>`…). Absent : la lettre sur la couleur. */
  avatar?: string;
  /** Statut personnalisé en cours (non expiré). Identique pour tous les spectateurs. */
  customStatus?: CustomStatus;
  status: SeenStatus;
  watching?: WatchingView;
  /** Dernier battement (ms). Absent pour un profil invisible ou jamais vu, ou si l'activité est masquée. */
  lastSeen?: number;
}

/**
 * Vue d'un ami ou d'un membre du foyer, du point de vue du profil agissant. `favorite`, `nickname` et `muted` viennent de la
 * relation que le profil agissant a posée (PUT /friends/:pid/relation) ; faux et absents pour le foyer.
 */
export interface FriendView extends SubjectView {
  household: boolean;
  favorite: boolean;
  nickname?: string;
  muted: boolean;
}

/** Préférences d'un profil (contrat SocialPrefs, S2). */
export interface SocialPrefs {
  activityVisibility: 'friends' | 'favorites' | 'nobody';
  watchWith: 'open' | 'ask' | 'never';
  libraryVisibility: 'friends' | 'household' | 'private';
  messagesFrom: 'friends' | 'favorites' | 'household';
  historyVisible: boolean;
  antiSpoiler: boolean;
  playbackSocial: 'all' | 'messages' | 'cinema';
  notify: { messages: boolean; requests: boolean; parties: boolean; friendStarts: boolean; vibrate: boolean; sound: boolean };
}

/** Valeurs par défaut des préférences (contrat S2). */
export const DEFAULT_SOCIAL_PREFS: SocialPrefs = {
  activityVisibility: 'friends',
  watchWith: 'ask',
  libraryVisibility: 'friends',
  messagesFrom: 'friends',
  historyVisible: true,
  antiSpoiler: true,
  playbackSocial: 'all',
  notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
};

/** Mise à jour partielle des préférences. */
export type SocialPrefsPatch = Partial<Omit<SocialPrefs, 'notify'>> & { notify?: Partial<SocialPrefs['notify']> };

/** Relation d'un profil vers un ami (PUT /friends/:pid/relation). `nickname` : `null` efface le surnom. */
export interface RelationPatch {
  favorite?: boolean;
  nickname?: string | null;
  muted?: boolean;
  hideActivity?: boolean;
}

/** Changement de présence à remettre : une vue identique par groupe de destinataires (amis ou foyer, selon la vue). */
export interface PresenceDelivery {
  pids: string[];
  friend: FriendView;
}

export interface FriendRequestView {
  pid: string;
  handle: Handle;
  avatarColor: string;
  avatar?: string;
  createdAt: number;
}

/** Bannière du profil : un titre TMDB (`backdrop` = chemin « /xxx.jpg »). */
export interface BannerView {
  tmdbId: number;
  type: 'movie' | 'series';
  backdrop: string;
  title: string;
}

/** Favori du profil (≤ 4, ordonnés). */
export interface FavoriteView {
  tmdbId: number;
  type: 'movie' | 'series';
  title: string;
  poster?: string;
}

/** Chiffres du profil : heures regardées (une décimale), notes posées, amis acceptés. */
export interface ProfileStats {
  hoursWatched: number;
  notes: number;
  friends: number;
}

/**
 * Profil social étendu (contrat S1). `tagChangeableAt` n'existe que pour le profil lui-même ; `friendSince`, `commonTitles`
 * et `mutualFriends` que pour un autre profil.
 */
export interface SocialProfileView {
  pid: string;
  handle: Handle;
  avatarColor: string;
  avatar?: string;
  bio?: string;
  customStatus?: CustomStatus;
  banner?: BannerView;
  favorites: FavoriteView[];
  stats: ProfileStats;
  friendSince?: number;
  commonTitles?: number;
  mutualFriends?: number;
  tagChangeableAt?: number;
}

/** Modification partielle validée du profil social (`null` retire le champ). */
export interface ProfilePatch {
  name?: string;
  avatarColor?: string;
  bio?: string | null;
  customStatus?: CustomStatus | null;
  banner?: BannerView | null;
  favorites?: FavoriteView[];
}

/** Changement de tag : nouveau tag, ou refus avec le délai restant (cooldown). */
export type TagOutcome = { result: 'ok'; tag: string } | { result: 'cooldown'; retryAfterSec: number } | { result: 'unknown' };

/** Délai minimal entre deux changements volontaires de tag : 30 jours (ms). */
export const TAG_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Nombre maximal de favoris d'un profil. */
export const MAX_PROFILE_FAVORITES = 4;

export interface FriendsOverview {
  friends: FriendView[];
  household: FriendView[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export interface HistoryItem {
  type: 'movie' | 'series';
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

export interface SharedLibraryItem {
  type: 'movie' | 'series';
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
}

/** Changement de présence visible : une livraison par vue distincte (amis, puis foyer). */
export interface PresenceChange {
  deliveries: PresenceDelivery[];
}

export type BlockOutcome = { result: 'self' } | { result: 'not_found' } | { result: 'household' } | { result: 'ok'; unlinked: boolean };
export type ReportOutcome = { result: 'self' } | { result: 'not_found' } | { result: 'ok' };
export type JoinOutcome = { result: 'self' } | { result: 'not_found' } | { result: 'not_allowed' } | { result: 'ok'; from: FriendView };
export type HistoryOutcome = { result: 'unknown' } | { result: 'hidden' } | { result: 'ok'; items: HistoryItem[] };

export type RequestOutcome =
  | { result: 'not_found' }
  | { result: 'self' }
  | { result: 'already_friends' }
  | { result: 'already_requested' }
  | { result: 'limit_reached' }
  | { result: 'sent'; outgoing: FriendRequestView; incoming: FriendRequestView }
  | { result: 'accepted'; self: SubjectView; other: SubjectView };

export type AcceptOutcome = { result: 'not_found' } | { result: 'limit_reached' } | { result: 'ok'; self: SubjectView; other: SubjectView };

/** Carte publique d'un profil non enfant. */
export interface Card {
  pid: string;
  handle: Handle;
  avatarColor: string;
  avatar?: string;
}

/** Présence stockée d'un profil : statut choisi, titre en cours (JSON), dernier battement (ms ; 0 = jamais / déconnecté). */
export interface PresenceRow {
  status: string;
  watching: string | null;
  updated_at: number;
}

/** Ligne d'un profil avec sa présence (jointure LEFT : `status` nul sans présence). */
interface ViewRow {
  pid: string;
  handle_name: string;
  handle_tag: string;
  avatar_color: string;
  avatar: string | null;
  custom_status: string | null;
  status: string | null;
  watching: string | null;
  updated_at: number | null;
}

const VIEW_COLUMNS = `p.pid, p.handle_name, p.handle_tag, p.avatar_color, p.avatar, p.custom_status, pr.status, pr.watching, pr.updated_at`;

/** Colonnes du profil social étendu (lues par `buildProfile`). */
interface ProfileRow {
  id: string;
  handle_name: string | null;
  handle_tag: string | null;
  avatar_color: string;
  avatar: string | null;
  bio: string | null;
  custom_status: string | null;
  banner: string | null;
  favorites: string | null;
  tag_changed_at: number | null;
}

/** Pids des amis acceptés d'un profil (`other`). Trois paramètres : le pid, répété trois fois. */
const FRIENDS_OF_SQL = `SELECT CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END AS other FROM profile_friendships f WHERE f.status = 'accepted' AND (f.low_pid = ? OR f.high_pid = ?)`;

/** JSON stocké d'un champ de profil. Une valeur illisible est ignorée (le champ est absent), jamais une erreur. */
function parseStoredJson<T>(raw: string | null | undefined): T | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Statut personnalisé en cours : `undefined` s'il est absent ou si son échéance est passée. */
export function activeCustomStatus(raw: string | null | undefined, now: number): CustomStatus | undefined {
  const status = parseStoredJson<CustomStatus>(raw);
  if (status === undefined || status === null || typeof status !== 'object') return undefined;
  if (status.expiresAt !== undefined && status.expiresAt <= now) return undefined;
  return status;
}

export function handleOf(name: string, tag: string): Handle {
  return { name, tag, full: `${name}#${tag}` };
}

/**
 * Statut vu par les autres. Hors ligne si pas de battement depuis plus de PRESENCE_TTL_MS, si jamais vu (`updated_at`
 * à 0 après une déconnexion), ou en mode invisible. Sinon, le statut choisi.
 */
export function seenStatusOf(row: PresenceRow | undefined, now: number): SeenStatus {
  if (row === undefined || row.updated_at <= 0 || now - row.updated_at > PRESENCE_TTL_MS) return 'offline';
  if (row.status === 'invisible') return 'offline';
  return row.status as SeenStatus;
}

/**
 * Titre en cours tel qu'il est stocké : seuls les champs du contrat, dans un ordre fixe (comparaison par chaîne). Une
 * saison et un épisode n'ont de sens que pour une série.
 */
export function normalizeWatching(input: WatchingView): WatchingView {
  const series = input.type === 'series';
  const out: WatchingView = {
    type: input.type,
    tmdbId: input.tmdbId,
    title: input.title,
    ...(input.pos === undefined ? {} : { pos: input.pos }),
    paused: input.paused,
    ...(input.at === undefined ? {} : { at: input.at }),
  };
  if (input.imdbId !== undefined) out.imdbId = input.imdbId;
  if (input.poster !== undefined) out.poster = input.poster;
  if (series && input.season !== undefined) out.season = input.season;
  if (series && input.episode !== undefined) out.episode = input.episode;
  if (input.duration !== undefined) out.duration = input.duration;
  return out;
}

function parseStoredWatching(raw: string | null | undefined): Watching | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as Watching;
  } catch {
    return undefined;
  }
}

/** Relation stockée (profile_relations) : entiers 0/1, surnom nul si absent. */
interface RelationRow {
  favorite: number;
  nickname: string | null;
  muted: number;
  hide_activity: number;
}

function parseStoredPrefs(raw: string): Partial<SocialPrefs> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<SocialPrefs>) : undefined;
  } catch {
    return undefined;
  }
}

/** Préférences complètes à partir d'une écriture partielle : ce qui manque prend la valeur par défaut. */
function prefsFrom(input: Partial<SocialPrefs> | undefined): SocialPrefs {
  const notify = { ...DEFAULT_SOCIAL_PREFS.notify, ...(input?.notify ?? {}) };
  return { ...DEFAULT_SOCIAL_PREFS, ...(input ?? {}), notify };
}

function viewOf(row: ViewRow, now: number): SubjectView {
  const presence: PresenceRow | undefined =
    row.status === null ? undefined : { status: row.status, watching: row.watching, updated_at: Number(row.updated_at ?? 0) };
  const seen = seenStatusOf(presence, now);
  const view: SubjectView = { pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color, status: seen };
  if (row.avatar !== null && row.avatar !== '') view.avatar = row.avatar;
  const customStatus = activeCustomStatus(row.custom_status, now);
  if (customStatus !== undefined) view.customStatus = customStatus;
  if (seen !== 'offline') {
    const watching = parseStoredWatching(presence?.watching);
    if (watching !== undefined) view.watching = watching;
  }
  if (presence !== undefined && presence.status !== 'invisible' && presence.updated_at > 0) view.lastSeen = presence.updated_at;
  return view;
}

function pairOf(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

// Messages, groupes et notes

/** Quotas d'écriture par profil auteur, sur une fenêtre glissante d'une minute (comptée en SQL sur created_at). */
export const MESSAGES_PER_MINUTE = 30;
export const NOTES_PER_MINUTE = 20;
const WRITE_WINDOW_MS = 60_000;
/** Messages renvoyés au plus par page, et notes renvoyées au plus pour un titre. */
export const MAX_MESSAGE_PAGE = 50;
export const MAX_NOTES_PER_MEDIA = 500;
/** Membres d'un groupe, créateur compris, au plus. */
export const MAX_GROUP_MEMBERS = 20;

/** Référence à un titre (contrat `MediaRef`). Saison et épisode ignorés pour un film. */
export interface MediaRef {
  type: 'movie' | 'series';
  tmdbId: number;
  season?: number;
  episode?: number;
}

/** Contexte d'un message : titre et position (secondes) de la lecture au moment de l'envoi. */
export interface MessageContext extends MediaRef {
  pos?: number;
}

export type MessageKind = 'text' | 'title' | 'moment' | 'party' | 'poll';

/** Titre partagé (kind title). `rating` : note de l'expéditeur sur 5. */
export interface TitleRef {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  poster?: string;
  year?: number;
  rating?: number;
}

/** Moment d'un titre (kind moment). Saison et épisode ignorés pour un film. `still` : image TMDB. */
export interface MomentRef {
  type: 'movie' | 'series';
  tmdbId: number;
  season?: number;
  episode?: number;
  title: string;
  pos: number;
  still?: string;
}

/** Invitation à un salon de visionnage (kind party). */
export interface PartyRef {
  partyId: string;
  title: string;
}

export interface ReactionView {
  emoji: string;
  count: number;
  /** Posée par le profil qui regarde. */
  mine: boolean;
}

export interface PollOptionView {
  id: string;
  label: string;
  votes: number;
  mine: boolean;
}

export interface PollView {
  /** Identifiant du sondage : celui de son message. */
  id: string;
  question: string;
  options: PollOptionView[];
  closed: boolean;
}

/** Message vu par un profil. `conv` : conversation vue de ce profil (« dm:<pid de l'autre> » ou « g:<id> »). */
export interface MessageView {
  id: string;
  conv: string;
  /** Pid de l'expéditeur. */
  from: string;
  /** Pid du destinataire ; absent pour un message de groupe. */
  to?: string;
  kind: MessageKind;
  body: string;
  context?: MessageContext;
  title?: TitleRef;
  moment?: MomentRef;
  party?: PartyRef;
  poll?: PollView;
  reactions: ReactionView[];
  replyTo?: string;
  createdAt: number;
  readAt?: number;
}

/** Groupe vu par un profil membre : membres = les autres membres (le profil qui regarde n'y figure pas). */
export interface GroupView {
  id: string;
  name: string;
  members: FriendView[];
}

interface ConversationBase {
  conv: string;
  last?: MessageView;
  unread: number;
}

export interface DirectConversationView extends ConversationBase {
  pid: string;
  handle: Handle;
  avatarColor: string;
}

export interface GroupConversationView extends ConversationBase {
  group: GroupView;
}

export type ConversationView = DirectConversationView | GroupConversationView;

/** Conversation côté serveur : un échange avec un profil, ou un groupe. */
export type ConvScope = { kind: 'dm'; peer: string } | { kind: 'group'; id: string };

/** Refus d'accès à une conversation : soi-même (400), inconnu ou groupe non visible (404), ni ami ni foyer (403). */
export type ConvError = 'self' | 'unknown' | 'not_friend';
type ConvAccess = 'ok' | ConvError;

/** Identifiant de conversation tel qu'un profil le voit : « dm:<pid de l'autre> » ou « g:<id> ». */
export function convKey(scope: ConvScope): string {
  return scope.kind === 'dm' ? `dm:${scope.peer}` : `g:${scope.id}`;
}

/** Conversation vue par un destinataire : un DM se voit depuis l'expéditeur (« dm:<expéditeur> »), un groupe ne change pas. */
function recipientScope(sender: string, scope: ConvScope): ConvScope {
  return scope.kind === 'dm' ? { kind: 'dm', peer: sender } : scope;
}

/** Contenu d'un message à écrire (validé en amont). `context` : message texte d'un DM (v2) seulement. */
export interface NewMessage {
  kind: MessageKind;
  body: string;
  context?: MessageContext;
  title?: TitleRef;
  moment?: MomentRef;
  party?: PartyRef;
  poll?: { question: string; options: string[] };
  replyTo?: string;
}

export interface Notice<T> {
  /** Destinataire (pid). */
  pid: string;
  /** Conversation vue du destinataire. */
  conv: string;
  payload: T;
}

export type MessagesOutcome = { result: ConvError } | { result: 'ok'; messages: MessageView[] };
export type SendOutcome =
  | { result: ConvError | 'reply_unknown' | 'not_allowed' }
  | { result: 'limit_reached'; retryAfterSec: number }
  | { result: 'sent'; message: MessageView; notices: Notice<MessageView>[] };
/** `count` : messages (DM) ou nombre de non-lus (groupe) qui viennent d'être lus. `peer` : l'expéditeur des messages lus, en DM. */
export type ReadOutcome = { result: ConvError } | { result: 'ok'; count: number; at: number; peer?: string };
export type ReactionOutcome =
  | { result: ConvError | 'message_not_found' }
  | { result: 'ok'; reactions: ReactionView[]; notices: Notice<ReactionView[]>[] };
export type VoteOutcome =
  | { result: ConvError | 'poll_not_found' | 'option_unknown' | 'poll_closed' | 'already_voted' }
  | { result: 'ok'; poll: PollView; notices: Notice<PollView>[] };
export type TypingOutcome = { result: ConvError } | { result: 'ok'; notices: Notice<null>[] };
export type CreateGroupOutcome = { result: 'self' | 'not_friend' } | { result: 'ok'; conversation: GroupConversationView };
export type UpdateGroupOutcome =
  | { result: 'self' | 'not_friend' | 'unknown' | 'full' }
  | { result: 'ok'; conversation: GroupConversationView };

export type AddNoteOutcome =
  | { result: 'unknown' }
  | { result: 'limit_reached'; retryAfterSec: number }
  | { result: 'ok'; note: NoteView; audience: string[] };

export interface NoteView {
  id: string;
  author: { pid: string; handle: Handle; avatarColor: string; avatar?: string };
  pos: number;
  kind: 'text' | 'emoji';
  body: string;
  createdAt: number;
}

/** Référence normalisée : saison et épisode gardés seulement pour une série. */
export function normalizeMedia(input: MediaRef): MediaRef {
  const out: MediaRef = { type: input.type, tmdbId: input.tmdbId };
  if (input.type === 'series') {
    if (input.season !== undefined) out.season = input.season;
    if (input.episode !== undefined) out.episode = input.episode;
  }
  return out;
}

/** Clés stockées d'un titre : saison et épisode à 0 pour un film (comme la progression) ou une série sans précision. */
function mediaKey(media: MediaRef): { type: 'movie' | 'series'; tmdbId: number; season: number; episode: number } {
  const series = media.type === 'series';
  return { type: media.type, tmdbId: media.tmdbId, season: series ? (media.season ?? 0) : 0, episode: series ? (media.episode ?? 0) : 0 };
}

function contextOf(input: MessageContext): MessageContext {
  const out: MessageContext = normalizeMedia(input);
  if (input.pos !== undefined) out.pos = input.pos;
  return out;
}

/** Charge hors texte d'un message (titre, moment ou invitation), telle qu'elle est stockée ; un film n'a ni saison ni épisode. */
function payloadOf(input: NewMessage): string | null {
  if (input.kind === 'title' && input.title !== undefined) return JSON.stringify(input.title);
  if (input.kind === 'moment' && input.moment !== undefined) {
    const moment: MomentRef = { ...input.moment };
    if (moment.type === 'movie') {
      delete moment.season;
      delete moment.episode;
    }
    return JSON.stringify(moment);
  }
  if (input.kind === 'party' && input.party !== undefined) return JSON.stringify(input.party);
  return null;
}

interface MessageRow {
  id: string;
  from_pid: string;
  to_pid: string | null;
  group_id: string | null;
  kind: MessageKind;
  body: string;
  context: string | null;
  payload: string | null;
  reply_to: string | null;
  created_at: number;
  read_at: number | null;
}

const MESSAGE_COLUMNS = 'id, from_pid, to_pid, group_id, kind, body, context, payload, reply_to, created_at, read_at';

const SENT_MESSAGES_SQL = 'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM messages WHERE from_pid = ? AND created_at > ?';
/** Notes comptées par le journal des créations : une suppression ne libère pas de place dans le quota. */
const SENT_NOTES_SQL = 'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM note_creations WHERE author_pid = ? AND created_at > ?';

/** Clause des messages d'une conversation (alias `m`) et ses paramètres. */
function scopeSql(scope: ConvScope, viewer: string): { sql: string; params: string[] } {
  if (scope.kind === 'group') return { sql: 'm.group_id = ?', params: [scope.id] };
  return {
    sql: '((m.from_pid = ? AND m.to_pid = ?) OR (m.from_pid = ? AND m.to_pid = ?))',
    params: [viewer, scope.peer, scope.peer, viewer],
  };
}

/** `?, ?, …` pour une liste de paramètres. */
function marks(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

function parseJson<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Contenu illisible : le message reste lisible sans cette charge.
    return undefined;
  }
}

/** Vue d'un message pour `viewer`. Les réactions et le sondage sont déjà calculés pour lui. */
function toMessageView(viewer: string, row: MessageRow, reactions: ReactionView[], poll: PollView | undefined): MessageView {
  const conv = row.group_id !== null ? `g:${row.group_id}` : `dm:${row.from_pid === viewer ? String(row.to_pid) : row.from_pid}`;
  const view: MessageView = { id: row.id, conv, from: row.from_pid, kind: row.kind, body: row.body, reactions, createdAt: Number(row.created_at) };
  if (row.to_pid !== null) view.to = row.to_pid;
  const context = parseJson<MessageContext>(row.context);
  if (context !== undefined) view.context = context;
  if (row.kind === 'title') {
    const title = parseJson<TitleRef>(row.payload);
    if (title !== undefined) view.title = title;
  } else if (row.kind === 'moment') {
    const moment = parseJson<MomentRef>(row.payload);
    if (moment !== undefined) view.moment = moment;
  } else if (row.kind === 'party') {
    const party = parseJson<PartyRef>(row.payload);
    if (party !== undefined) view.party = party;
  } else if (row.kind === 'poll' && poll !== undefined) {
    view.poll = poll;
  }
  if (row.reply_to !== null) view.replyTo = row.reply_to;
  if (row.read_at !== null) view.readAt = Number(row.read_at);
  return view;
}

interface NoteRow {
  id: string;
  pos: number;
  kind: 'text' | 'emoji';
  body: string;
  created_at: number;
  pid: string;
  handle_name: string;
  handle_tag: string;
  avatar_color: string;
  avatar: string | null;
}

function noteOf(row: NoteRow): NoteView {
  const author: NoteView['author'] = { pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color };
  if (row.avatar !== null && row.avatar !== '') author.avatar = row.avatar;
  return {
    id: row.id,
    author,
    pos: Number(row.pos),
    kind: row.kind,
    body: row.body,
    createdAt: Number(row.created_at),
  };
}

export class SocialV2Store {
  constructor(private readonly db: SqlDb) {}

  // Identité

  /**
   * Identité sociale d'un profil du compte. `undefined` si le profil n'est pas à ce compte. Un profil enfant n'a ni pid
   * ni handle (`pid` et `handle` nuls).
   */
  identityOf(accountId: string, profileId: string): { pid: string | null; handle: Handle | null; isKid: boolean } | undefined {
    const row = this.db
      .prepare('SELECT pid, handle_name, handle_tag, is_kid FROM profiles WHERE id = ? AND account_id = ?')
      .get(profileId, accountId) as { pid: string | null; handle_name: string | null; handle_tag: string | null; is_kid: number } | undefined;
    if (row === undefined) return undefined;
    const handle = row.pid !== null && row.handle_name !== null && row.handle_tag !== null ? handleOf(row.handle_name, row.handle_tag) : null;
    return { pid: row.pid, handle, isKid: Number(row.is_kid) === 1 };
  }

  /** Carte d'un profil non enfant par son pid ; `undefined` si inconnu ou enfant. */
  card(pid: string): Card | undefined {
    const row = this.db
      .prepare('SELECT pid, handle_name, handle_tag, avatar_color, avatar FROM profiles WHERE pid = ? AND is_kid = 0')
      .get(pid) as { pid: string | null; handle_name: string | null; handle_tag: string | null; avatar_color: string; avatar: string | null } | undefined;
    if (row === undefined || row.pid === null || row.handle_name === null || row.handle_tag === null) return undefined;
    const card: Card = { pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color };
    if (row.avatar !== null && row.avatar !== '') card.avatar = row.avatar;
    return card;
  }

  /** Statut choisi du profil (« online » par défaut). */
  statusOf(pid: string): SocialStatus {
    const row = this.presenceRow(pid);
    return row === undefined ? 'online' : (row.status as SocialStatus);
  }

  /** Vue d'un profil non enfant telle qu'un autre la voit (sans le drapeau « foyer »). */
  subjectView(pid: string, now: number): SubjectView | undefined {
    const row = this.db
      .prepare(`SELECT ${VIEW_COLUMNS} FROM profiles p LEFT JOIN profile_presence pr ON pr.profile_pid = p.pid WHERE p.pid = ? AND p.is_kid = 0`)
      .get(pid) as unknown as ViewRow | undefined;
    return row === undefined || row.handle_name === null ? undefined : viewOf(row, now);
  }

  // Profil social étendu (S1)

  /** Profil social du profil lui-même : `tagChangeableAt` s'il est encore bloqué. `undefined` si le profil est inconnu ou enfant. */
  profileOf(pid: string, now: number): SocialProfileView | undefined {
    return this.buildProfile(pid, pid, now, false);
  }

  /**
   * Profil social d'un ami ou d'un membre du foyer, vu par `viewerPid`. `undefined` sans lien (même réponse que pour un
   * profil inconnu ou enfant).
   */
  friendProfileOf(viewerPid: string, targetPid: string, now: number): SocialProfileView | undefined {
    const relation = this.relationOf(viewerPid, targetPid);
    if (relation === undefined) return undefined;
    return this.buildProfile(targetPid, viewerPid, now, relation === 'household');
  }

  /**
   * Modifie le profil social (PUT /profile). Les champs absents restent inchangés ; `null` retire bio, statut ou
   * bannière. Un nouveau nom renomme aussi le handle (tag gardé sauf collision). Renvoie `false` si le profil est inconnu.
   */
  updateSocialProfile(pid: string, patch: ProfilePatch): boolean {
    return this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT id, account_id FROM profiles WHERE pid = ? AND is_kid = 0').get(pid) as
        | { id: string; account_id: string }
        | undefined;
      if (row === undefined) return false;
      if (patch.name !== undefined) {
        this.db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(patch.name, row.id);
        syncProfileIdentity(this.db, row.account_id, row.id, patch.name, false);
      }
      if (patch.avatarColor !== undefined) this.db.prepare('UPDATE profiles SET avatar_color = ? WHERE id = ?').run(patch.avatarColor, row.id);
      if (patch.bio !== undefined) this.db.prepare('UPDATE profiles SET bio = ? WHERE id = ?').run(patch.bio, row.id);
      if (patch.customStatus !== undefined) {
        this.db
          .prepare('UPDATE profiles SET custom_status = ? WHERE id = ?')
          .run(patch.customStatus === null ? null : JSON.stringify(patch.customStatus), row.id);
      }
      if (patch.banner !== undefined) {
        this.db.prepare('UPDATE profiles SET banner = ? WHERE id = ?').run(patch.banner === null ? null : JSON.stringify(patch.banner), row.id);
      }
      if (patch.favorites !== undefined) this.db.prepare('UPDATE profiles SET favorites = ? WHERE id = ?').run(JSON.stringify(patch.favorites), row.id);
      return true;
    });
  }

  /**
   * Nouveau tag tiré au hasard pour le profil (POST /profile/tag). Refusé tant que `TAG_COOLDOWN_MS` ne s'est pas écoulé
   * depuis le dernier changement volontaire. Le premier changement n'est jamais bloqué.
   */
  changeTag(pid: string, now: number): TagOutcome {
    return this.db.transaction((): TagOutcome => {
      const row = this.db.prepare('SELECT id, handle_key, handle_tag, tag_changed_at FROM profiles WHERE pid = ? AND is_kid = 0').get(pid) as
        | { id: string; handle_key: string | null; handle_tag: string | null; tag_changed_at: number | null }
        | undefined;
      if (row === undefined || row.handle_key === null || row.handle_tag === null) return { result: 'unknown' };
      if (row.tag_changed_at !== null) {
        const waitMs = Number(row.tag_changed_at) + TAG_COOLDOWN_MS - now;
        if (waitMs > 0) return { result: 'cooldown', retryAfterSec: Math.ceil(waitMs / 1000) };
      }
      const tag = drawNewHandleTag(this.db, row.id, row.handle_key, row.handle_tag);
      this.db.prepare('UPDATE profiles SET handle_tag = ?, tag_changed_at = ? WHERE id = ?').run(tag, now, row.id);
      return { result: 'ok', tag };
    });
  }

  /** Vue complète d'un profil ; `household` = autre profil du même compte (pas d'amitié, pas de « depuis »). */
  private buildProfile(pid: string, viewerPid: string, now: number, household: boolean): SocialProfileView | undefined {
    const row = this.db
      .prepare(
        `SELECT id, handle_name, handle_tag, avatar_color, avatar, bio, custom_status, banner, favorites, tag_changed_at
           FROM profiles WHERE pid = ? AND is_kid = 0`,
      )
      .get(pid) as unknown as ProfileRow | undefined;
    if (row === undefined || row.handle_name === null || row.handle_tag === null) return undefined;
    const view: SocialProfileView = {
      pid,
      handle: handleOf(row.handle_name, row.handle_tag),
      avatarColor: row.avatar_color,
      favorites: parseStoredJson<FavoriteView[]>(row.favorites) ?? [],
      stats: this.statsOf(row.id, pid),
    };
    if (row.avatar !== null && row.avatar !== '') view.avatar = row.avatar;
    if (row.bio !== null && row.bio !== '') view.bio = row.bio;
    const customStatus = activeCustomStatus(row.custom_status, now);
    if (customStatus !== undefined) view.customStatus = customStatus;
    const banner = parseStoredJson<BannerView>(row.banner);
    if (banner) view.banner = banner;
    if (pid === viewerPid) {
      const changeableAt = row.tag_changed_at === null ? undefined : Number(row.tag_changed_at) + TAG_COOLDOWN_MS;
      if (changeableAt !== undefined && changeableAt > now) view.tagChangeableAt = changeableAt;
      return view;
    }
    const { low, high } = pairOf(viewerPid, pid);
    const friendship = this.db
      .prepare("SELECT accepted_at FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'")
      .get(low, high) as { accepted_at: number | null } | undefined;
    if (friendship !== undefined && friendship.accepted_at !== null) view.friendSince = Number(friendship.accepted_at);
    view.commonTitles = this.commonTitlesOf(viewerPid, pid, household);
    view.mutualFriends = this.mutualFriendsOf(viewerPid, pid);
    return view;
  }

  /** Chiffres d'un profil : heures regardées (une décimale), notes posées, amis acceptés. */
  private statsOf(profileId: string, pid: string): ProfileStats {
    const watched = this.db
      .prepare(
        'SELECT COALESCE(SUM(CASE WHEN finished = 1 AND duration_sec > 0 THEN duration_sec ELSE position_sec END), 0) AS sec FROM progress WHERE profile_id = ?',
      )
      .get(profileId) as { sec: number } | undefined;
    const notes = this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE author_pid = ?').get(pid) as { n: number } | undefined;
    return {
      hoursWatched: Math.round((Number(watched?.sec ?? 0) / 3600) * 10) / 10,
      notes: Number(notes?.n ?? 0),
      friends: this.countFriends(pid),
    };
  }

  /** Titres présents dans la bibliothèque des deux profils (visibles pour `viewerPid` : seuls les titres « friends » pour un ami). */
  private commonTitlesOf(viewerPid: string, targetPid: string, household: boolean): number {
    const visibility = household ? '' : "AND them.visibility = 'friends'";
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT me.type || ':' || me.title_ref) AS n
           FROM library_items me
           JOIN profiles mp ON mp.id = me.profile_id
           JOIN library_items them ON them.type = me.type AND them.title_ref = me.title_ref AND them.removed = 0 ${visibility}
           JOIN profiles tp ON tp.id = them.profile_id
          WHERE mp.pid = ? AND me.removed = 0 AND tp.pid = ? AND tp.is_kid = 0`,
      )
      .get(viewerPid, targetPid) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Amis acceptés en commun de deux profils. */
  private mutualFriendsOf(viewerPid: string, targetPid: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM (${FRIENDS_OF_SQL}) a WHERE a.other IN (${FRIENDS_OF_SQL})`)
      .get(viewerPid, viewerPid, viewerPid, targetPid, targetPid, targetPid) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  // Présence

  /** Statut choisi (PUT /status). Un profil jamais vu reçoit une ligne « jamais vu » : il n'apparaît en ligne qu'après un battement. */
  setStatus(pid: string, status: SocialStatus, now: number): PresenceChange | undefined {
    return this.db.transaction(() => {
      const before = this.presenceRow(pid);
      if (before === undefined) {
        this.db.prepare('INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES (?, ?, NULL, 0)').run(pid, status);
      } else {
        this.db.prepare('UPDATE profile_presence SET status = ? WHERE profile_pid = ?').run(status, pid);
      }
      return this.changeSince(pid, before, now);
    });
  }

  /**
   * Battement de cœur (PUT /presence) : `watching` null = en ligne sans titre. Le statut choisi reste celui d'avant
   * (« online » à la première fois). Renvoie le changement visible, ou `undefined` si rien n'a changé pour les autres.
   */
  heartbeat(pid: string, watching: Watching | null, now: number): PresenceChange | undefined {
    return this.db.transaction(() => {
      const before = this.presenceRow(pid);
      const stored = watching === null ? null : JSON.stringify(normalizeWatching(watching));
      this.db
        .prepare(
          `INSERT INTO profile_presence (profile_pid, status, watching, updated_at) VALUES (?, 'online', ?, ?)
           ON CONFLICT(profile_pid) DO UPDATE SET watching = excluded.watching, updated_at = excluded.updated_at`,
        )
        .run(pid, stored, now);
      return this.changeSince(pid, before, now);
    });
  }

  /** Déconnexion (DELETE /presence) : hors ligne immédiat, statut choisi conservé. */
  clearPresence(pid: string, now: number): PresenceChange | undefined {
    return this.db.transaction(() => {
      const before = this.presenceRow(pid);
      if (before === undefined) return undefined;
      this.db.prepare('UPDATE profile_presence SET watching = NULL, updated_at = 0 WHERE profile_pid = ?').run(pid);
      return this.changeSince(pid, before, now);
    });
  }

  private presenceRow(pid: string): PresenceRow | undefined {
    const row = this.db.prepare('SELECT status, watching, updated_at FROM profile_presence WHERE profile_pid = ?').get(pid) as
      | { status: string; watching: string | null; updated_at: number }
      | undefined;
    return row === undefined ? undefined : { status: row.status, watching: row.watching, updated_at: Number(row.updated_at) };
  }

  /**
   * Compare la présence avant écriture à l'état courant : rien si les autres voient la même chose (même statut vu, même titre).
   * Sinon, la vue de chaque destinataire (préférences du profil appliquées), regroupée par vue identique.
   */
  private changeSince(pid: string, before: PresenceRow | undefined, now: number): PresenceChange | undefined {
    const after = this.presenceRow(pid);
    const seenChanged = seenStatusOf(before, now) !== seenStatusOf(after, now);
    const watchingChanged = (before?.watching ?? null) !== (after?.watching ?? null);
    if (!seenChanged && !watchingChanged) return undefined;
    const row = this.viewRow(pid);
    if (row === undefined || row.handle_name === null) return undefined;
    const { friends, household } = this.audience(pid);
    const groups = new Map<string, PresenceDelivery>();
    const addFor = (recipient: string, isHousehold: boolean): void => {
      const friend = this.presentView(recipient, row, isHousehold, now);
      const key = JSON.stringify(friend);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { pids: [recipient], friend });
      else group.pids.push(recipient);
    };
    for (const recipient of friends) addFor(recipient, false);
    for (const recipient of household) addFor(recipient, true);
    return { deliveries: [...groups.values()] };
  }

  /** Ligne d'un profil non enfant avec sa présence (jointure), `undefined` si inconnu ou enfant. */
  private viewRow(pid: string): ViewRow | undefined {
    return this.db
      .prepare(`SELECT ${VIEW_COLUMNS} FROM profiles p LEFT JOIN profile_presence pr ON pr.profile_pid = p.pid WHERE p.pid = ? AND p.is_kid = 0`)
      .get(pid) as unknown as ViewRow | undefined;
  }

  /**
   * Vue d'un profil pour `viewerPid`. Foyer : vue complète. Ami : `watching` et `lastSeen` retirés si l'activité n'est pas
   * visible pour lui (activityVisibility « nobody », ou « favorites » sans être favori chez le profil vu) ; `pos` et `at`
   * retirés si `watchWith` = « never ». Relation (favori, surnom, sourdine) : celle que `viewerPid` a posée.
   */
  private presentView(viewerPid: string, row: ViewRow, household: boolean, now: number): FriendView {
    const view = viewOf(row, now);
    if (household) return { ...view, household: true, favorite: false, muted: false };
    const prefs = this.prefsOf(row.pid);
    const relation = this.relationRow(viewerPid, row.pid);
    const out: FriendView = {
      ...view,
      household: false,
      favorite: relation !== undefined && Number(relation.favorite) === 1,
      muted: relation !== undefined && Number(relation.muted) === 1,
    };
    if (relation?.nickname) out.nickname = relation.nickname;
    const activityVisible = prefs.activityVisibility === 'friends' || (prefs.activityVisibility === 'favorites' && this.isFavoriteOf(row.pid, viewerPid));
    if (!activityVisible) {
      delete out.watching;
      delete out.lastSeen;
    } else if (out.watching !== undefined && prefs.watchWith === 'never') {
      const shared = { ...out.watching };
      delete shared.pos;
      delete shared.at;
      out.watching = shared;
    }
    return out;
  }

  /** Vue d'un ami ou d'un membre du foyer telle que `viewerPid` la reçoit. `undefined` s'il n'y a pas de lien (ou blocage). */
  friendViewOf(viewerPid: string, subjectPid: string, now: number): FriendView | undefined {
    const relation = this.relationOf(viewerPid, subjectPid);
    if (relation === undefined) return undefined;
    const row = this.viewRow(subjectPid);
    return row === undefined || row.handle_name === null ? undefined : this.presentView(viewerPid, row, relation === 'household', now);
  }

  // Préférences et relations

  /** Préférences d'un profil, défauts compris. */
  prefsOf(pid: string): SocialPrefs {
    const row = this.db.prepare('SELECT prefs FROM social_prefs WHERE profile_pid = ?').get(pid) as { prefs: string } | undefined;
    return prefsFrom(row === undefined ? undefined : parseStoredPrefs(row.prefs));
  }

  /** Mise à jour partielle des préférences (PUT /prefs). Renvoie les préférences complètes. */
  updatePrefs(pid: string, patch: SocialPrefsPatch): SocialPrefs {
    return this.db.transaction((): SocialPrefs => {
      const current = this.prefsOf(pid);
      const next = prefsFrom({ ...current, ...patch, notify: { ...current.notify, ...(patch.notify ?? {}) } });
      this.db
        .prepare('INSERT INTO social_prefs (profile_pid, prefs) VALUES (?, ?) ON CONFLICT(profile_pid) DO UPDATE SET prefs = excluded.prefs')
        .run(pid, JSON.stringify(next));
      return next;
    });
  }

  private relationRow(ownerPid: string, targetPid: string): RelationRow | undefined {
    return this.db
      .prepare('SELECT favorite, nickname, muted, hide_activity FROM profile_relations WHERE owner_pid = ? AND target_pid = ?')
      .get(ownerPid, targetPid) as RelationRow | undefined;
  }

  /** Le profil `ownerPid` a-t-il mis `targetPid` parmi ses favoris ? */
  private isFavoriteOf(ownerPid: string, targetPid: string): boolean {
    const row = this.relationRow(ownerPid, targetPid);
    return row !== undefined && Number(row.favorite) === 1;
  }

  /**
   * Relation du profil `ownerPid` vers un ami accepté (PUT /friends/:pid/relation). Renvoie la vue de l'ami pour
   * `ownerPid`, ou `undefined` si `targetPid` n'est pas un ami (foyer compris : pas de relation à poser).
   */
  updateRelation(ownerPid: string, targetPid: string, patch: RelationPatch, now: number): FriendView | undefined {
    return this.db.transaction((): FriendView | undefined => {
      const { low, high } = pairOf(ownerPid, targetPid);
      const friendship = this.db.prepare("SELECT 1 AS x FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").get(low, high);
      if (friendship === undefined || this.isBlockedEither(ownerPid, targetPid)) return undefined;
      const current = this.relationRow(ownerPid, targetPid);
      const favorite = patch.favorite ?? (current !== undefined && Number(current.favorite) === 1);
      const muted = patch.muted ?? (current !== undefined && Number(current.muted) === 1);
      const hideActivity = patch.hideActivity ?? (current !== undefined && Number(current.hide_activity) === 1);
      const nickname = patch.nickname === undefined ? (current?.nickname ?? null) : patch.nickname;
      this.db
        .prepare(
          `INSERT INTO profile_relations (owner_pid, target_pid, favorite, nickname, muted, hide_activity) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_pid, target_pid) DO UPDATE SET favorite = excluded.favorite, nickname = excluded.nickname,
             muted = excluded.muted, hide_activity = excluded.hide_activity`,
        )
        .run(ownerPid, targetPid, favorite ? 1 : 0, nickname, muted ? 1 : 0, hideActivity ? 1 : 0);
      return this.friendViewOf(ownerPid, targetPid, now);
    });
  }

  /** Vrai si `recipientPid` accepte les messages de `senderPid` (préférence messagesFrom ; le foyer passe toujours). */
  private acceptsMessagesFrom(recipientPid: string, senderPid: string): boolean {
    if (this.relationOf(senderPid, recipientPid) === 'household') return true;
    const { messagesFrom } = this.prefsOf(recipientPid);
    if (messagesFrom === 'household') return false;
    if (messagesFrom === 'favorites') return this.isFavoriteOf(recipientPid, senderPid);
    return true;
  }

  // Blocages et signalements

  /** Vrai si l'un des deux profils a bloqué l'autre. */
  isBlockedEither(a: string, b: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM blocks WHERE (blocker_pid = ? AND blocked_pid = ?) OR (blocker_pid = ? AND blocked_pid = ?) LIMIT 1').get(a, b, b, a) !== undefined;
  }

  /**
   * Bloque `targetPid` (POST /blocks/:pid). Retire l'amitié, acceptée ou en attente, et les demandes de rejoindre, dans les deux
   * sens. Le foyer ne se bloque pas. `unlinked` : une amitié vient de tomber (à prévenir par WS).
   */
  blockProfile(blockerPid: string, targetPid: string, now: number): BlockOutcome {
    return this.db.transaction((): BlockOutcome => {
      if (blockerPid === targetPid) return { result: 'self' };
      if (this.card(targetPid) === undefined) return { result: 'not_found' };
      if (this.relationOf(blockerPid, targetPid) === 'household') return { result: 'household' };
      this.db.prepare('INSERT OR IGNORE INTO blocks (blocker_pid, blocked_pid, created_at) VALUES (?, ?, ?)').run(blockerPid, targetPid, now);
      const { low, high } = pairOf(blockerPid, targetPid);
      const link = this.db.prepare('SELECT status FROM profile_friendships WHERE low_pid = ? AND high_pid = ?').get(low, high) as { status: string } | undefined;
      if (link !== undefined) {
        this.db.prepare('DELETE FROM profile_friendships WHERE low_pid = ? AND high_pid = ?').run(low, high);
        // Comme removeFriend : l'amitié legacy compte↔compte ne doit pas survivre au blocage.
        if (link.status === 'accepted') revokeLegacyFriendship(this.db, blockerPid, targetPid);
      }
      this.db
        .prepare('DELETE FROM join_requests WHERE (requester_pid = ? AND host_pid = ?) OR (requester_pid = ? AND host_pid = ?)')
        .run(blockerPid, targetPid, targetPid, blockerPid);
      return { result: 'ok', unlinked: link !== undefined };
    });
  }

  /** Débloque (DELETE /blocks/:pid). `false` si ce profil n'était pas bloqué. L'amitié n'est pas rétablie. */
  unblockProfile(blockerPid: string, targetPid: string): boolean {
    return Number(this.db.prepare('DELETE FROM blocks WHERE blocker_pid = ? AND blocked_pid = ?').run(blockerPid, targetPid).changes) === 1;
  }

  /** Profils bloqués par `pid` (GET /blocks), du plus récent au plus ancien blocage. */
  blockedOf(pid: string): { pid: string; handle: Handle }[] {
    const rows = this.db
      .prepare(
        `SELECT p.pid, p.handle_name, p.handle_tag FROM blocks b JOIN profiles p ON p.pid = b.blocked_pid
          WHERE b.blocker_pid = ? AND p.is_kid = 0 AND p.handle_name IS NOT NULL AND p.handle_tag IS NOT NULL
          ORDER BY b.created_at DESC`,
      )
      .all(pid) as unknown as { pid: string; handle_name: string; handle_tag: string }[];
    return rows.map((row) => ({ pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag) }));
  }

  /** Signalement (POST /reports). Ni amitié ni lien requis : tout profil non enfant peut être signalé. */
  addReport(reporterPid: string, targetPid: string, reason: 'spam' | 'harassment' | 'other', details: string | undefined, now: number): ReportOutcome {
    return this.db.transaction((): ReportOutcome => {
      if (reporterPid === targetPid) return { result: 'self' };
      if (this.card(targetPid) === undefined) return { result: 'not_found' };
      this.db
        .prepare('INSERT INTO reports (id, reporter_pid, target_pid, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), reporterPid, targetPid, reason, details ?? null, now);
      return { result: 'ok' };
    });
  }

  // Demandes de rejoindre

  /**
   * Demande de rejoindre le titre en cours de `hostPid` (POST /friends/:pid/join-request). Refusée si `hostPid` règle
   * `watchWith` sur « never ». `from` : la vue de l'ami demandeur, telle que l'hôte la reçoit.
   */
  requestJoin(requesterPid: string, hostPid: string, now: number): JoinOutcome {
    return this.db.transaction((): JoinOutcome => {
      if (requesterPid === hostPid) return { result: 'self' };
      if (this.relationOf(requesterPid, hostPid) === undefined) return { result: 'not_found' };
      if (this.prefsOf(hostPid).watchWith === 'never') return { result: 'not_allowed' };
      const from = this.friendViewOf(hostPid, requesterPid, now);
      if (from === undefined) return { result: 'not_found' };
      this.db
        .prepare(
          `INSERT INTO join_requests (requester_pid, host_pid, created_at) VALUES (?, ?, ?)
           ON CONFLICT(requester_pid, host_pid) DO UPDATE SET created_at = excluded.created_at`,
        )
        .run(requesterPid, hostPid, now);
      return { result: 'ok', from };
    });
  }

  /**
   * Réponse de l'hôte à une demande reçue de `requesterPid` (POST /join-requests/:pid). Consomme la demande. `false` si elle
   * n'existe pas, ou si le lien entre les deux profils a disparu.
   */
  answerJoin(hostPid: string, requesterPid: string): boolean {
    return this.db.transaction((): boolean => {
      if (this.relationOf(hostPid, requesterPid) === undefined) return false;
      return Number(this.db.prepare('DELETE FROM join_requests WHERE requester_pid = ? AND host_pid = ?').run(requesterPid, hostPid).changes) === 1;
    });
  }

  /** Destinataires d'un changement de présence : amis acceptés, et autres profils du foyer (non enfants). */
  audience(pid: string): { friends: string[]; household: string[] } {
    const friends = this.db
      .prepare(
        `SELECT CASE WHEN low_pid = ? THEN high_pid ELSE low_pid END AS pid FROM profile_friendships
         WHERE status = 'accepted' AND (low_pid = ? OR high_pid = ?)`,
      )
      .all(pid, pid, pid)
      .map((row) => String(row.pid));
    const household = this.db
      .prepare(
        `SELECT p.pid FROM profiles p
         WHERE p.account_id = (SELECT account_id FROM profiles WHERE pid = ?) AND p.pid <> ? AND p.is_kid = 0 AND p.pid IS NOT NULL
         ORDER BY p.created_at, p.id`,
      )
      .all(pid, pid)
      .map((row) => String(row.pid));
    return { friends, household };
  }

  // Amis, foyer et demandes

  /** `{ friends, household, incoming, outgoing }` vus depuis le profil `pid`. */
  listFriends(pid: string, now: number): FriendsOverview {
    const friends = this.db
      .prepare(
        `SELECT ${VIEW_COLUMNS} FROM profile_friendships f
         JOIN profiles p ON p.pid = CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END
         LEFT JOIN profile_presence pr ON pr.profile_pid = p.pid
         WHERE f.status = 'accepted' AND (f.low_pid = ? OR f.high_pid = ?) AND p.is_kid = 0
         ORDER BY p.handle_name COLLATE NOCASE, p.handle_tag`,
      )
      .all(pid, pid, pid) as unknown as ViewRow[];
    const household = this.db
      .prepare(
        `SELECT ${VIEW_COLUMNS} FROM profiles p LEFT JOIN profile_presence pr ON pr.profile_pid = p.pid
         WHERE p.account_id = (SELECT account_id FROM profiles WHERE pid = ?) AND p.pid <> ? AND p.is_kid = 0 AND p.pid IS NOT NULL
         ORDER BY p.created_at, p.id`,
      )
      .all(pid, pid) as unknown as ViewRow[];
    const pending = this.db
      .prepare(
        `SELECT p.pid, p.handle_name, p.handle_tag, p.avatar_color, p.avatar, f.requested_by, f.created_at FROM profile_friendships f
         JOIN profiles p ON p.pid = CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END
         WHERE f.status = 'pending' AND (f.low_pid = ? OR f.high_pid = ?) AND p.is_kid = 0
         ORDER BY f.created_at DESC`,
      )
      .all(pid, pid, pid) as unknown as {
      pid: string;
      handle_name: string;
      handle_tag: string;
      avatar_color: string;
      avatar: string | null;
      requested_by: string;
      created_at: number;
    }[];
    const requestView = (row: (typeof pending)[number]): FriendRequestView => {
      const view: FriendRequestView = {
        pid: row.pid,
        handle: handleOf(row.handle_name, row.handle_tag),
        avatarColor: row.avatar_color,
        createdAt: Number(row.created_at),
      };
      if (row.avatar !== null && row.avatar !== '') view.avatar = row.avatar;
      return view;
    };
    return {
      friends: friends.map((row) => this.presentView(pid, row, false, now)),
      household: household.map((row) => this.presentView(pid, row, true, now)),
      incoming: pending.filter((row) => row.requested_by !== pid).map(requestView),
      outgoing: pending.filter((row) => row.requested_by === pid).map(requestView),
    };
  }

  /**
   * Demande d'ami par handle (clé normalisée + tag). Un profil du même compte est déjà dans le foyer : `already_friends`.
   * Si l'autre avait déjà demandé, la demande croisée vaut acceptation.
   */
  requestFriend(pid: string, handleKey: string, handleTag: string, now: number): RequestOutcome {
    return this.db.transaction((): RequestOutcome => {
      const target = this.db
        .prepare('SELECT pid, account_id, handle_name, handle_tag, avatar_color, avatar FROM profiles WHERE handle_key = ? AND handle_tag = ? AND is_kid = 0')
        .get(handleKey, handleTag) as
        | { pid: string | null; account_id: string; handle_name: string; handle_tag: string; avatar_color: string; avatar: string | null }
        | undefined;
      if (target === undefined || target.pid === null) return { result: 'not_found' };
      if (target.pid === pid) return { result: 'self' };
      if (this.isBlockedEither(pid, target.pid)) return { result: 'not_found' };
      const requester = this.db.prepare('SELECT account_id FROM profiles WHERE pid = ?').get(pid) as { account_id: string } | undefined;
      if (requester === undefined) return { result: 'not_found' };
      if (target.account_id === requester.account_id) return { result: 'already_friends' };
      const { low, high } = pairOf(pid, target.pid);
      const existing = this.db.prepare('SELECT status, requested_by FROM profile_friendships WHERE low_pid = ? AND high_pid = ?').get(low, high) as
        | { status: 'pending' | 'accepted'; requested_by: string }
        | undefined;
      if (existing?.status === 'accepted') return { result: 'already_friends' };
      if (existing !== undefined) {
        if (existing.requested_by === pid) return { result: 'already_requested' };
        if (this.countFriends(pid) >= MAX_FRIENDS) return { result: 'limit_reached' };
        this.db.prepare("UPDATE profile_friendships SET status = 'accepted', accepted_at = ? WHERE low_pid = ? AND high_pid = ?").run(now, low, high);
        const selfView = this.subjectView(pid, now);
        const otherView = this.subjectView(target.pid, now);
        return selfView === undefined || otherView === undefined ? { result: 'not_found' } : { result: 'accepted', self: selfView, other: otherView };
      }
      if (this.countOutgoing(pid) >= MAX_OUTGOING_REQUESTS || this.countFriends(pid) >= MAX_FRIENDS) return { result: 'limit_reached' };
      this.db
        .prepare("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
        .run(low, high, pid, now);
      const mine = this.card(pid);
      if (mine === undefined) return { result: 'not_found' };
      const outgoing: FriendRequestView = {
        pid: target.pid,
        handle: handleOf(target.handle_name, target.handle_tag),
        avatarColor: target.avatar_color,
        createdAt: now,
      };
      if (target.avatar !== null && target.avatar !== '') outgoing.avatar = target.avatar;
      const incoming: FriendRequestView = { pid: mine.pid, handle: mine.handle, avatarColor: mine.avatarColor, createdAt: now };
      if (mine.avatar !== undefined) incoming.avatar = mine.avatar;
      return { result: 'sent', outgoing, incoming };
    });
  }

  /** Accepte une demande reçue du profil `otherPid`. */
  acceptRequest(pid: string, otherPid: string, now: number): AcceptOutcome {
    return this.db.transaction((): AcceptOutcome => {
      const { low, high } = pairOf(pid, otherPid);
      const row = this.db
        .prepare("SELECT requested_by FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'pending'")
        .get(low, high) as { requested_by: string } | undefined;
      if (row === undefined || row.requested_by === pid) return { result: 'not_found' };
      if (this.countFriends(pid) >= MAX_FRIENDS) return { result: 'limit_reached' };
      this.db.prepare("UPDATE profile_friendships SET status = 'accepted', accepted_at = ? WHERE low_pid = ? AND high_pid = ?").run(now, low, high);
      const self = this.subjectView(pid, now);
      const other = this.subjectView(otherPid, now);
      return self === undefined || other === undefined ? { result: 'not_found' } : { result: 'ok', self, other };
    });
  }

  /** Refuse une demande reçue, ou annule une demande envoyée, avec le profil `otherPid`. */
  declineRequest(pid: string, otherPid: string): boolean {
    const { low, high } = pairOf(pid, otherPid);
    return Number(this.db.prepare("DELETE FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'pending'").run(low, high).changes) === 1;
  }

  /** Supprime une amitié acceptée. Le foyer n'est pas une amitié : rien à supprimer. */
  removeFriend(pid: string, otherPid: string): boolean {
    const { low, high } = pairOf(pid, otherPid);
    return this.db.transaction(() => {
      const removed = Number(this.db.prepare("DELETE FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").run(low, high).changes) === 1;
      // L'amitié legacy compte↔compte (profils principaux) tombe avec elle : sinon l'ex-ami garde l'accès legacy.
      if (removed) revokeLegacyFriendship(this.db, pid, otherPid);
      // Favori, surnom et sourdine ne survivent pas à l'amitié : une nouvelle amitié repart des défauts.
      if (removed) this.db.prepare('DELETE FROM profile_relations WHERE (owner_pid = ? AND target_pid = ?) OR (owner_pid = ? AND target_pid = ?)').run(pid, otherPid, otherPid, pid);
      return removed;
    });
  }

  private countFriends(pid: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM profile_friendships WHERE status = 'accepted' AND (low_pid = ? OR high_pid = ?)").get(pid, pid);
    return Number(row?.n ?? 0);
  }

  private countOutgoing(pid: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM profile_friendships WHERE status = 'pending' AND requested_by = ?").get(pid);
    return Number(row?.n ?? 0);
  }

  /**
   * Lien entre le profil `viewerPid` et `targetPid` : `household` (même compte), `friend` (amitié acceptée), ou
   * `undefined`. Un profil enfant n'a pas de pid et n'est donc jamais visible.
   */
  private relationOf(viewerPid: string, targetPid: string): 'household' | 'friend' | undefined {
    const target = this.db.prepare('SELECT account_id FROM profiles WHERE pid = ? AND is_kid = 0').get(targetPid) as { account_id: string } | undefined;
    if (target === undefined) return undefined;
    const viewer = this.db.prepare('SELECT account_id FROM profiles WHERE pid = ?').get(viewerPid) as { account_id: string } | undefined;
    if (viewer === undefined) return undefined;
    if (viewer.account_id === target.account_id) return 'household';
    if (this.isBlockedEither(viewerPid, targetPid)) return undefined;
    const { low, high } = pairOf(viewerPid, targetPid);
    const friend = this.db.prepare("SELECT 1 AS x FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").get(low, high);
    return friend === undefined ? undefined : 'friend';
  }

  // Bibliothèque et historique (contrôle ami / foyer)

  /**
   * Bibliothèque d'un profil visible par `viewerPid` : le foyer voit tous les titres, un ami seulement les titres en
   * visibilité « friends ». `undefined` si le lien n'existe pas (même réponse que pour un profil inconnu).
   */
  friendLibrary(
    viewerPid: string,
    targetPid: string,
    type: 'movie' | 'series' | undefined,
    limit: number,
    offset: number,
  ): { items: SharedLibraryItem[]; total: number } | undefined {
    const relation = this.relationOf(viewerPid, targetPid);
    if (relation === undefined) return undefined;
    // Préférence libraryVisibility du profil vu : hors « friends », un ami ne voit aucun titre (liste vide, lien maintenu).
    if (relation === 'friend' && this.prefsOf(targetPid).libraryVisibility !== 'friends') return { items: [], total: 0 };
    const visibility = relation === 'household' ? '' : "AND li.visibility = 'friends'";
    const typeClause = type === undefined ? '' : 'AND li.type = ?';
    const base = `FROM library_items li JOIN profiles p ON p.id = li.profile_id
      WHERE p.pid = ? AND p.is_kid = 0 AND li.removed = 0 ${visibility} ${typeClause}`;
    const params: (string | number)[] = type === undefined ? [targetPid] : [targetPid, type];
    const total = this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params);
    const rows = this.db
      .prepare(`SELECT li.type, li.tmdb_id, li.imdb_id, li.title, li.poster, li.added_at ${base} ORDER BY li.added_at DESC, li.title_ref LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as {
      type: 'movie' | 'series';
      tmdb_id: number | null;
      imdb_id: string | null;
      title: string;
      poster: string | null;
      added_at: string;
    }[];
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((row) => ({
        type: row.type,
        tmdbId: row.tmdb_id,
        imdbId: row.imdb_id,
        title: row.title,
        poster: row.poster,
        addedAt: row.added_at,
      })),
    };
  }

  /**
   * Historique de lecture d'un profil, du plus récent au plus ancien, un élément par épisode ou film. Seuls les titres
   * avec un identifiant TMDB sont listés (le contrat l'exige). Titre et affiche viennent de la bibliothèque si le titre
   * y figure. `undefined` si le lien n'existe pas.
   */
  friendHistory(viewerPid: string, targetPid: string, limit: number): HistoryOutcome {
    const relation = this.relationOf(viewerPid, targetPid);
    if (relation === undefined) return { result: 'unknown' };
    if (relation === 'friend' && !this.prefsOf(targetPid).historyVisible) return { result: 'hidden' };
    const rows = this.db
      .prepare(
        `SELECT pg.type, pg.tmdb_id, pg.season, pg.episode, pg.position_sec, pg.duration_sec, pg.updated_at, pg.finished, li.title, li.poster
         FROM progress pg
         JOIN profiles p ON p.id = pg.profile_id
         LEFT JOIN library_items li ON li.profile_id = pg.profile_id AND li.type = pg.type AND li.title_ref = pg.title_ref
         WHERE p.pid = ? AND p.is_kid = 0 AND pg.tmdb_id IS NOT NULL
         ORDER BY pg.updated_at DESC, pg.season DESC, pg.episode DESC
         LIMIT ?`,
      )
      .all(targetPid, limit) as unknown as {
      type: 'movie' | 'series';
      tmdb_id: number;
      season: number;
      episode: number;
      position_sec: number;
      duration_sec: number;
      updated_at: string;
      finished: number;
      title: string | null;
      poster: string | null;
    }[];
    const items = rows.map((row): HistoryItem => {
      const item: HistoryItem = {
        type: row.type,
        tmdbId: Number(row.tmdb_id),
        pos: Number(row.position_sec),
        watched: Number(row.finished) === 1,
        updatedAt: Number.isFinite(Date.parse(row.updated_at)) ? Date.parse(row.updated_at) : 0,
      };
      if (row.title !== null) item.title = row.title;
      if (row.poster !== null && row.poster !== '') item.poster = row.poster;
      if (row.type === 'series') {
        item.season = Number(row.season);
        item.episode = Number(row.episode);
      }
      if (Number(row.duration_sec) > 0) item.duration = Number(row.duration_sec);
      return item;
    });
    return { result: 'ok', items };
  }

  // Conversations : accès, lecture des messages et des réactions

  /** Amis acceptés et autres profils du foyer, joignables en message. */
  private peersOf(pid: string): Card[] {
    const rows = this.db
      .prepare(
        `SELECT p.pid, p.handle_name, p.handle_tag, p.avatar_color FROM profile_friendships f
           JOIN profiles p ON p.pid = CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END
          WHERE f.status = 'accepted' AND (f.low_pid = ? OR f.high_pid = ?) AND p.is_kid = 0
         UNION
         SELECT p.pid, p.handle_name, p.handle_tag, p.avatar_color FROM profiles p
          WHERE p.account_id = (SELECT account_id FROM profiles WHERE pid = ?) AND p.pid <> ? AND p.is_kid = 0 AND p.pid IS NOT NULL`,
      )
      .all(pid, pid, pid, pid, pid) as unknown as { pid: string; handle_name: string; handle_tag: string; avatar_color: string }[];
    return rows.map((row) => ({ pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color }));
  }

  /** Accès de `viewer` à une conversation : `ok`, ou la raison du refus. Un groupe n'est visible que de ses membres. */
  private accessOf(viewer: string, scope: ConvScope): ConvAccess {
    if (scope.kind === 'group') return this.isMember(viewer, scope.id) ? 'ok' : 'unknown';
    if (scope.peer === viewer) return 'self';
    if (this.card(scope.peer) === undefined) return 'unknown';
    // Un blocage, dans un sens ou dans l'autre, rend le profil invisible : même réponse qu'un profil inconnu.
    if (this.isBlockedEither(viewer, scope.peer)) return 'unknown';
    return this.relationOf(viewer, scope.peer) === undefined ? 'not_friend' : 'ok';
  }

  private isMember(pid: string, groupId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM social_group_members WHERE group_id = ? AND pid = ?').get(groupId, pid) !== undefined;
  }

  private memberCount(groupId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM social_group_members WHERE group_id = ?').get(groupId);
    return Number(row?.n ?? 0);
  }

  /** Destinataires d'un événement de conversation, hors auteur : le pair (DM), ou les membres non enfants (groupe). */
  private recipientsOf(viewer: string, scope: ConvScope): string[] {
    if (scope.kind === 'dm') return [scope.peer];
    return this.db
      .prepare(
        `SELECT m.pid FROM social_group_members m JOIN profiles p ON p.pid = m.pid
          WHERE m.group_id = ? AND m.pid <> ? AND p.is_kid = 0 ORDER BY m.joined_at, m.pid`,
      )
      .all(scope.id, viewer)
      .map((row) => String(row.pid));
  }

  /** Vrai si le message `messageId` existe dans la conversation `scope`. */
  private inScope(messageId: string, viewer: string, scope: ConvScope): boolean {
    const s = scopeSql(scope, viewer);
    return this.db.prepare(`SELECT 1 AS x FROM messages m WHERE m.id = ? AND ${s.sql}`).get(messageId, ...s.params) !== undefined;
  }

  /** Réactions de chaque message de `ids`, vues par `viewer`. Une entrée par emoji, dans l'ordre de première pose. */
  private reactionsFor(viewer: string, ids: string[]): Map<string, ReactionView[]> {
    const out = new Map<string, ReactionView[]>();
    if (ids.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT message_id, emoji, COUNT(*) AS n, MAX(CASE WHEN pid = ? THEN 1 ELSE 0 END) AS mine
           FROM message_reactions WHERE message_id IN (${marks(ids)})
          GROUP BY message_id, emoji ORDER BY message_id, MIN(created_at), emoji`,
      )
      .all(viewer, ...ids);
    for (const row of rows) {
      const id = String(row.message_id);
      const list = out.get(id) ?? [];
      list.push({ emoji: String(row.emoji), count: Number(row.n), mine: Number(row.mine) === 1 });
      out.set(id, list);
    }
    return out;
  }

  /** Sondages de `ids`, vus par `viewer` : votes par option, option choisie par lui. */
  private pollsFor(viewer: string, ids: string[]): Map<string, PollView> {
    const out = new Map<string, PollView>();
    if (ids.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT p.message_id, p.question, p.closed, o.id, o.label,
                (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes,
                (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id AND v.pid = ?) AS mine
           FROM polls p JOIN poll_options o ON o.poll_id = p.message_id
          WHERE p.message_id IN (${marks(ids)})
          ORDER BY o.position`,
      )
      .all(viewer, ...ids);
    for (const row of rows) {
      const id = String(row.message_id);
      let poll = out.get(id);
      if (poll === undefined) {
        poll = { id, question: String(row.question), options: [], closed: Number(row.closed) === 1 };
        out.set(id, poll);
      }
      poll.options.push({ id: String(row.id), label: String(row.label), votes: Number(row.votes), mine: Number(row.mine) === 1 });
    }
    return out;
  }

  /** Vue d'un message pour `viewer` (réactions et sondage compris). */
  private messageViewOf(viewer: string, row: MessageRow): MessageView {
    const reactions = this.reactionsFor(viewer, [row.id]).get(row.id) ?? [];
    return toMessageView(viewer, row, reactions, this.pollsFor(viewer, [row.id]).get(row.id));
  }

  /** Vues de plusieurs messages (une seule requête par type de donnée), dans l'ordre reçu. */
  private messageViewsOf(viewer: string, rows: MessageRow[]): MessageView[] {
    const ids = rows.map((row) => row.id);
    const reactions = this.reactionsFor(viewer, ids);
    const polls = this.pollsFor(viewer, ids);
    return rows.map((row) => toMessageView(viewer, row, reactions.get(row.id) ?? [], polls.get(row.id)));
  }

  private rowOf(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id) as unknown as MessageRow | undefined;
  }

  private lastOf(viewer: string, scope: ConvScope): MessageView | undefined {
    const s = scopeSql(scope, viewer);
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE ${s.sql} ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`)
      .get(...s.params) as unknown as MessageRow | undefined;
    return row === undefined ? undefined : this.messageViewOf(viewer, row);
  }

  /** Non-lus de `viewer` dans la conversation : messages reçus non lus (DM), ou messages postés depuis sa dernière lecture (groupe). */
  private unreadOf(viewer: string, scope: ConvScope): number {
    if (scope.kind === 'dm') {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_pid = ? AND to_pid = ? AND read_at IS NULL').get(scope.peer, viewer);
      return Number(row?.n ?? 0);
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m JOIN social_group_members g ON g.group_id = m.group_id AND g.pid = ?
          WHERE m.group_id = ? AND m.from_pid <> ? AND m.created_at > g.read_at`,
      )
      .get(viewer, scope.id, viewer);
    return Number(row?.n ?? 0);
  }

  /** Vue d'un groupe pour un de ses membres : membres (sans lui), dernier message et non-lus. */
  private groupConversation(viewer: string, groupId: string, name: string, now: number): GroupConversationView {
    const memberRows = this.db
      .prepare(
        `SELECT m.pid FROM social_group_members m JOIN profiles p ON p.pid = m.pid
          WHERE m.group_id = ? AND m.pid <> ? AND p.is_kid = 0 ORDER BY m.joined_at, m.pid`,
      )
      .all(groupId, viewer);
    const members: FriendView[] = [];
    for (const row of memberRows) {
      const pid = String(row.pid);
      const memberRow = this.db
        .prepare(`SELECT ${VIEW_COLUMNS} FROM profiles p LEFT JOIN profile_presence pr ON pr.profile_pid = p.pid WHERE p.pid = ? AND p.is_kid = 0`)
        .get(pid) as unknown as ViewRow | undefined;
      if (memberRow !== undefined && memberRow.handle_name !== null) members.push(this.presentView(viewer, memberRow, this.relationOf(viewer, pid) === 'household', now));
    }
    const scope: ConvScope = { kind: 'group', id: groupId };
    const view: GroupConversationView = { conv: convKey(scope), group: { id: groupId, name, members }, unread: this.unreadOf(viewer, scope) };
    const last = this.lastOf(viewer, scope);
    if (last !== undefined) view.last = last;
    return view;
  }

  /**
   * Conversations : amis et foyer, puis groupes dont on est membre, avec le dernier message et le nombre de non-lus. Les
   * plus récentes d'abord, puis par nom.
   */
  conversations(pid: string, now: number): ConversationView[] {
    const items: { view: ConversationView; name: string; tag: string; at: number }[] = [];
    for (const peer of this.peersOf(pid)) {
      const scope: ConvScope = { kind: 'dm', peer: peer.pid };
      const view: DirectConversationView = {
        conv: convKey(scope),
        pid: peer.pid,
        handle: peer.handle,
        avatarColor: peer.avatarColor,
        unread: this.unreadOf(pid, scope),
      };
      const last = this.lastOf(pid, scope);
      if (last !== undefined) view.last = last;
      items.push({ view, name: peer.handle.name, tag: peer.handle.tag, at: last?.createdAt ?? 0 });
    }
    const groups = this.db
      .prepare('SELECT g.id, g.name FROM social_group_members m JOIN social_groups g ON g.id = m.group_id WHERE m.pid = ?')
      .all(pid);
    for (const row of groups) {
      const view = this.groupConversation(pid, String(row.id), String(row.name), now);
      items.push({ view, name: view.group.name, tag: '', at: view.last?.createdAt ?? 0 });
    }
    return items
      .sort((a, b) => b.at - a.at || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.tag.localeCompare(b.tag))
      .map((item) => item.view);
  }

  /**
   * Messages d'une conversation, du plus ancien au plus récent : `limit` au plus, antérieurs à `before` (ms) s'il est donné.
   */
  convMessages(viewer: string, scope: ConvScope, before: number | undefined, limit: number): MessagesOutcome {
    const access = this.accessOf(viewer, scope);
    if (access !== 'ok') return { result: access };
    const s = scopeSql(scope, viewer);
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m
          WHERE ${s.sql} AND m.created_at < ?
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(...s.params, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageRow[];
    return { result: 'ok', messages: this.messageViewsOf(viewer, rows).reverse() };
  }

  /**
   * Envoi d'un message dans la conversation. Refusé (sans rien écrire) si la cible n'est pas accessible, si l'expéditeur
   * a déjà envoyé 30 messages dans la dernière minute, ou si la réponse vise un message hors de la conversation.
   * `notices` : une vue par destinataire (le pair, ou les membres sauf l'expéditeur).
   */
  sendConvMessage(viewer: string, scope: ConvScope, input: NewMessage, now: number): SendOutcome {
    return this.db.transaction((): SendOutcome => {
      const access = this.accessOf(viewer, scope);
      if (access !== 'ok') return { result: access };
      if (scope.kind === 'dm' && !this.acceptsMessagesFrom(scope.peer, viewer)) return { result: 'not_allowed' };
      const retryAfterSec = this.retryAfter(SENT_MESSAGES_SQL, viewer, MESSAGES_PER_MINUTE, now);
      if (retryAfterSec !== undefined) return { result: 'limit_reached', retryAfterSec };
      if (input.replyTo !== undefined && !this.inScope(input.replyTo, viewer, scope)) return { result: 'reply_unknown' };
      const dm = scope.kind === 'dm';
      const row: MessageRow = {
        id: randomUUID(),
        from_pid: viewer,
        to_pid: dm ? scope.peer : null,
        group_id: dm ? null : scope.id,
        kind: input.kind,
        body: input.body,
        context: input.context === undefined ? null : JSON.stringify(contextOf(input.context)),
        payload: payloadOf(input),
        reply_to: input.replyTo ?? null,
        created_at: now,
        read_at: null,
      };
      this.db
        .prepare(
          `INSERT INTO messages (id, from_pid, to_pid, group_id, kind, body, context, payload, reply_to, created_at, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(row.id, row.from_pid, row.to_pid, row.group_id, row.kind, row.body, row.context, row.payload, row.reply_to, row.created_at);
      if (input.kind === 'poll' && input.poll !== undefined) {
        this.db.prepare('INSERT INTO polls (message_id, question, closed) VALUES (?, ?, 0)').run(row.id, input.poll.question);
        input.poll.options.forEach((label, position) => {
          this.db
            .prepare('INSERT INTO poll_options (id, poll_id, position, label) VALUES (?, ?, ?, ?)')
            .run(randomUUID(), row.id, position, label);
        });
      }
      const notices = this.recipientsOf(viewer, scope).map(
        (pid): Notice<MessageView> => ({ pid, conv: convKey(recipientScope(viewer, scope)), payload: this.messageViewOf(pid, row) }),
      );
      return { result: 'sent', message: this.messageViewOf(viewer, row), notices };
    });
  }

  /**
   * Marque lu. DM : les messages reçus de l'autre profil (`count`, `peer`). Groupe : le moment de lecture du membre ;
   * `count` = messages postés depuis sa lecture précédente.
   */
  readConv(viewer: string, scope: ConvScope, now: number): ReadOutcome {
    return this.db.transaction((): ReadOutcome => {
      const access = this.accessOf(viewer, scope);
      if (access !== 'ok') return { result: access };
      if (scope.kind === 'dm') {
        const changes = this.db
          .prepare('UPDATE messages SET read_at = ? WHERE from_pid = ? AND to_pid = ? AND read_at IS NULL')
          .run(now, scope.peer, viewer).changes;
        return { result: 'ok', count: Number(changes), at: now, peer: scope.peer };
      }
      const count = this.unreadOf(viewer, scope);
      this.db.prepare('UPDATE social_group_members SET read_at = ? WHERE group_id = ? AND pid = ?').run(now, scope.id, viewer);
      return { result: 'ok', count, at: now };
    });
  }

  /** Bascule une réaction (pose si absente, retire si présente) sur un message de la conversation. */
  toggleReaction(viewer: string, scope: ConvScope, messageId: string, emoji: string, now: number): ReactionOutcome {
    return this.db.transaction((): ReactionOutcome => {
      const access = this.accessOf(viewer, scope);
      if (access !== 'ok') return { result: access };
      if (!this.inScope(messageId, viewer, scope)) return { result: 'message_not_found' };
      const existing = this.db
        .prepare('SELECT 1 AS x FROM message_reactions WHERE message_id = ? AND pid = ? AND emoji = ?')
        .get(messageId, viewer, emoji);
      if (existing !== undefined) {
        this.db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND pid = ? AND emoji = ?').run(messageId, viewer, emoji);
      } else {
        this.db
          .prepare('INSERT INTO message_reactions (message_id, pid, emoji, created_at) VALUES (?, ?, ?, ?)')
          .run(messageId, viewer, emoji, now);
      }
      const notices = this.recipientsOf(viewer, scope).map(
        (pid): Notice<ReactionView[]> => ({
          pid,
          conv: convKey(recipientScope(viewer, scope)),
          payload: this.reactionsFor(pid, [messageId]).get(messageId) ?? [],
        }),
      );
      return { result: 'ok', reactions: this.reactionsFor(viewer, [messageId]).get(messageId) ?? [], notices };
    });
  }

  /** Vote d'un profil pour une option d'un sondage : un seul vote par profil et par sondage. */
  votePoll(viewer: string, scope: ConvScope, pollId: string, optionId: string, now: number): VoteOutcome {
    return this.db.transaction((): VoteOutcome => {
      const access = this.accessOf(viewer, scope);
      if (access !== 'ok') return { result: access };
      const s = scopeSql(scope, viewer);
      const poll = this.db
        .prepare(`SELECT p.closed FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = ? AND ${s.sql}`)
        .get(pollId, ...s.params) as { closed: number } | undefined;
      if (poll === undefined) return { result: 'poll_not_found' };
      if (this.db.prepare('SELECT 1 AS x FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId) === undefined) {
        return { result: 'option_unknown' };
      }
      if (Number(poll.closed) === 1) return { result: 'poll_closed' };
      if (this.db.prepare('SELECT 1 AS x FROM poll_votes WHERE poll_id = ? AND pid = ?').get(pollId, viewer) !== undefined) {
        return { result: 'already_voted' };
      }
      this.db
        .prepare('INSERT INTO poll_votes (poll_id, pid, option_id, created_at) VALUES (?, ?, ?, ?)')
        .run(pollId, viewer, optionId, now);
      const own = this.pollsFor(viewer, [pollId]).get(pollId);
      if (own === undefined) return { result: 'poll_not_found' };
      const notices: Notice<PollView>[] = [];
      for (const pid of this.recipientsOf(viewer, scope)) {
        const view = this.pollsFor(pid, [pollId]).get(pollId);
        if (view !== undefined) notices.push({ pid, conv: convKey(recipientScope(viewer, scope)), payload: view });
      }
      return { result: 'ok', poll: own, notices };
    });
  }

  /** Frappe « en train d'écrire » : destinataires de la conversation (sans lui-même). */
  typingNotices(viewer: string, scope: ConvScope): TypingOutcome {
    const access = this.accessOf(viewer, scope);
    if (access !== 'ok') return { result: access };
    const conv = convKey(recipientScope(viewer, scope));
    return { result: 'ok', notices: this.recipientsOf(viewer, scope).map((pid) => ({ pid, conv, payload: null })) };
  }

  // Groupes

  /**
   * Crée un groupe. Membres = amis acceptés du créateur (pas le foyer), distincts, sans lui-même. Le créateur est membre
   * et lit le groupe dès maintenant.
   */
  createGroup(viewer: string, name: string, memberPids: string[], now: number): CreateGroupOutcome {
    return this.db.transaction((): CreateGroupOutcome => {
      if (memberPids.includes(viewer)) return { result: 'self' };
      for (const pid of memberPids) {
        if (this.relationOf(viewer, pid) !== 'friend') return { result: 'not_friend' };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO social_groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, name, viewer, now);
      for (const pid of [viewer, ...memberPids]) {
        this.db.prepare('INSERT INTO social_group_members (group_id, pid, joined_at, read_at) VALUES (?, ?, ?, ?)').run(id, pid, now, now);
      }
      return { result: 'ok', conversation: this.groupConversation(viewer, id, name, now) };
    });
  }

  /**
   * Modifie un groupe (nom, ajouts d'amis, retraits de membres). Réservé aux membres. Un ajout qui dépasse 20 membres est
   * refusé (`full`). Retirer soi-même passe par `leaveGroup`.
   */
  updateGroup(viewer: string, groupId: string, patch: { name?: string; add?: string[]; remove?: string[] }, now: number): UpdateGroupOutcome {
    return this.db.transaction((): UpdateGroupOutcome => {
      if (!this.isMember(viewer, groupId)) return { result: 'unknown' };
      if (patch.add?.includes(viewer) || patch.remove?.includes(viewer)) return { result: 'self' };
      const toAdd = (patch.add ?? []).filter((pid) => !this.isMember(pid, groupId));
      for (const pid of toAdd) {
        if (this.relationOf(viewer, pid) !== 'friend') return { result: 'not_friend' };
      }
      const toRemove = (patch.remove ?? []).filter((pid) => this.isMember(pid, groupId));
      if (this.memberCount(groupId) + toAdd.length - toRemove.length > MAX_GROUP_MEMBERS) return { result: 'full' };
      if (patch.name !== undefined) this.db.prepare('UPDATE social_groups SET name = ? WHERE id = ?').run(patch.name, groupId);
      for (const pid of toRemove) this.db.prepare('DELETE FROM social_group_members WHERE group_id = ? AND pid = ?').run(groupId, pid);
      for (const pid of toAdd) {
        this.db.prepare('INSERT INTO social_group_members (group_id, pid, joined_at, read_at) VALUES (?, ?, ?, ?)').run(groupId, pid, now, now);
      }
      const row = this.db.prepare('SELECT name FROM social_groups WHERE id = ?').get(groupId);
      return { result: 'ok', conversation: this.groupConversation(viewer, groupId, String(row?.name ?? ''), now) };
    });
  }

  /** Quitte un groupe. Le dernier membre qui part supprime le groupe. `false` si l'on n'en est pas membre. */
  leaveGroup(viewer: string, groupId: string): boolean {
    return this.db.transaction(() => {
      if (!this.isMember(viewer, groupId)) return false;
      this.db.prepare('DELETE FROM social_group_members WHERE group_id = ? AND pid = ?').run(groupId, viewer);
      if (this.memberCount(groupId) === 0) this.db.prepare('DELETE FROM social_groups WHERE id = ?').run(groupId);
      return true;
    });
  }

  /** Secondes avant le prochain envoi permis, ou `undefined` si le quota de la minute n'est pas atteint. `sql` compte les
   * envois de la fenêtre (paramètres : pid, début de fenêtre) et donne le plus ancien, qui libère une place à son expiration.
   */
  private retryAfter(sql: string, pid: string, limit: number, now: number): number | undefined {
    const row = this.db.prepare(sql).get(pid, now - WRITE_WINDOW_MS);
    if (Number(row?.n ?? 0) < limit) return undefined;
    const oldest = Number(row?.oldest ?? now);
    return Math.max(1, Math.ceil((oldest + WRITE_WINDOW_MS - now) / 1000));
  }

  // Notes : sur un titre, à une position

  /**
   * Notes d'un titre visibles par `viewerPid` : les siennes, celles de ses amis et celles de son foyer. Triées par position
   * (puis ancienneté), 500 au plus.
   */
  notesOf(viewerPid: string, media: MediaRef): NoteView[] {
    const key = mediaKey(media);
    const rows = this.db
      .prepare(
        `SELECT n.id, n.pos, n.kind, n.body, n.created_at, p.pid, p.handle_name, p.handle_tag, p.avatar_color, p.avatar
           FROM notes n JOIN profiles p ON p.pid = n.author_pid
          WHERE n.type = ? AND n.tmdb_id = ? AND n.season = ? AND n.episode = ?
            AND (n.author_pid = ?
              OR n.author_pid IN (SELECT CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END
                                    FROM profile_friendships f
                                   WHERE f.status = 'accepted' AND (f.low_pid = ? OR f.high_pid = ?))
              OR n.author_pid IN (SELECT h.pid FROM profiles h
                                   WHERE h.account_id = (SELECT a.account_id FROM profiles a WHERE a.pid = ?) AND h.is_kid = 0 AND h.pid IS NOT NULL))
          ORDER BY n.pos, n.created_at, n.rowid
          LIMIT ?`,
      )
      .all(key.type, key.tmdbId, key.season, key.episode, viewerPid, viewerPid, viewerPid, viewerPid, viewerPid, MAX_NOTES_PER_MEDIA) as unknown as NoteRow[];
    return rows.map((row) => noteOf(row));
  }

  /**
   * Pose une note. Refusée (sans rien écrire) si l'auteur a déjà créé 20 notes dans la dernière minute, supprimées ou non
   * (le quota compte les créations, voir note_creations). `audience` : amis puis foyer de l'auteur, destinataires de
   * l'événement.
   */
  addNote(authorPid: string, media: MediaRef, pos: number, kind: 'text' | 'emoji', body: string, now: number): AddNoteOutcome {
    return this.db.transaction((): AddNoteOutcome => {
      const author = this.card(authorPid);
      if (author === undefined) return { result: 'unknown' };
      this.db.prepare('DELETE FROM note_creations WHERE created_at <= ?').run(now - WRITE_WINDOW_MS);
      const retryAfterSec = this.retryAfter(SENT_NOTES_SQL, authorPid, NOTES_PER_MINUTE, now);
      if (retryAfterSec !== undefined) return { result: 'limit_reached', retryAfterSec };
      const id = randomUUID();
      const key = mediaKey(media);
      this.db.prepare('INSERT INTO note_creations (author_pid, created_at) VALUES (?, ?)').run(authorPid, now);
      this.db
        .prepare(
          'INSERT INTO notes (id, author_pid, type, tmdb_id, season, episode, pos, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, authorPid, key.type, key.tmdbId, key.season, key.episode, pos, kind, body, now);
      const { friends, household } = this.audience(authorPid);
      const note: NoteView = {
        id,
        author: { pid: author.pid, handle: author.handle, avatarColor: author.avatarColor, ...(author.avatar === undefined ? {} : { avatar: author.avatar }) },
        pos,
        kind,
        body,
        createdAt: now,
      };
      return { result: 'ok', note, audience: [...friends, ...household] };
    });
  }

  /** Supprime une note de son auteur. `false` si la note n'existe pas ou n'est pas à ce profil. */
  deleteNote(authorPid: string, noteId: string): boolean {
    return Number(this.db.prepare('DELETE FROM notes WHERE id = ? AND author_pid = ?').run(noteId, authorPid).changes) === 1;
  }
}
