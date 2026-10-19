import { randomUUID } from 'node:crypto';
import { drawNewHandleTag, revokeLegacyFriendship, syncProfileIdentity } from './social-handles.js';
import { MAX_FRIENDS, MAX_OUTGOING_REQUESTS, PRESENCE_TTL_MS } from './social-store.js';
import type { SqlDb } from './sql.js';

/**
 * Données sociales par profil (v2) : identité (handle `Nom#TAG`, pid), amitiés entre profils, présence, bibliothèque
 * partagée et historique des amis. Même base que UserStore (SQLite Node ou Durable Object) ; toutes les requêtes sont
 * paramétrées. Les profils sont désignés par leur `pid` public : l'id interne ne sort jamais de ce module.
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
  watching?: Watching;
  /** Dernier battement (ms). Absent pour un profil invisible ou jamais vu. */
  lastSeen?: number;
}

export interface FriendView extends SubjectView {
  household: boolean;
  /** Réglages que le profil agissant applique à cet ami (table profile_relations ; défauts false / absent). */
  favorite: boolean;
  muted: boolean;
  nickname?: string;
}

/** Ami tel qu'il est diffusé en temps réel : sans les réglages propres au profil destinataire. */
export type FriendLiveView = SubjectView & { household: boolean };

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

/** Changement de présence visible : vue du profil et destinataires (amis, puis foyer). */
export interface PresenceChange {
  subject: SubjectView;
  friends: string[];
  household: string[];
}

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

/** Réglages qu'un profil applique à un ami (ligne de profile_relations ; absente = défauts). */
interface RelationRow {
  target_pid: string;
  favorite: number;
  nickname: string | null;
  muted: number;
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
export function normalizeWatching(input: Watching): Watching {
  const series = input.type === 'series';
  const out: Watching = { type: input.type, tmdbId: input.tmdbId, title: input.title, pos: input.pos, paused: input.paused, at: input.at };
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

// Messages et notes

/** Quotas d'écriture par profil auteur, sur une fenêtre glissante d'une minute (comptée en SQL sur created_at). */
export const MESSAGES_PER_MINUTE = 30;
export const NOTES_PER_MINUTE = 20;
const WRITE_WINDOW_MS = 60_000;
/** Messages renvoyés au plus par page, et notes renvoyées au plus pour un titre. */
export const MAX_MESSAGE_PAGE = 50;
export const MAX_NOTES_PER_MEDIA = 500;

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

export interface MessageView {
  id: string;
  /** Pid de l'expéditeur. */
  from: string;
  /** Pid du destinataire. */
  to: string;
  body: string;
  context?: MessageContext;
  createdAt: number;
  readAt?: number;
}

export interface ConversationView {
  pid: string;
  handle: Handle;
  avatarColor: string;
  last?: MessageView;
  unread: number;
}

export interface NoteView {
  id: string;
  author: { pid: string; handle: Handle; avatarColor: string; avatar?: string };
  pos: number;
  kind: 'text' | 'emoji';
  body: string;
  createdAt: number;
}

/** Cible d'un message refusée : soi-même (400), profil inconnu ou enfant (404), profil ni ami ni du foyer (403). */
export type TargetError = 'self' | 'unknown' | 'not_friend';

export type SendOutcome = { result: TargetError } | { result: 'limit_reached'; retryAfterSec: number } | { result: 'sent'; message: MessageView };
export type MessagesOutcome = { result: TargetError } | { result: 'ok'; messages: MessageView[] };
/** `count` : messages reçus qui viennent d'être marqués lus (0 : rien à faire, rien à notifier). */
export type ReadOutcome = { result: TargetError } | { result: 'ok'; count: number; at: number };
export type AddNoteOutcome =
  | { result: 'unknown' }
  | { result: 'limit_reached'; retryAfterSec: number }
  | { result: 'ok'; note: NoteView; audience: string[] };

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

interface MessageRow {
  id: string;
  from_pid: string;
  to_pid: string;
  body: string;
  context: string | null;
  created_at: number;
  read_at: number | null;
}

const MESSAGE_COLUMNS = 'id, from_pid, to_pid, body, context, created_at, read_at';

function messageOf(row: MessageRow): MessageView {
  const view: MessageView = { id: row.id, from: row.from_pid, to: row.to_pid, body: row.body, createdAt: Number(row.created_at) };
  if (row.context !== null) {
    try {
      view.context = JSON.parse(row.context) as MessageContext;
    } catch {
      // Contexte illisible : le message reste lisible sans lui.
    }
  }
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

const SENT_MESSAGES_SQL = 'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM messages WHERE from_pid = ? AND created_at > ?';
/** Notes comptées par le journal des créations : une suppression ne libère pas de place dans le quota. */
const SENT_NOTES_SQL = 'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM note_creations WHERE author_pid = ? AND created_at > ?';

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

  /** Réglages par profil (table profile_relations) : une entrée par ami ayant une ligne. */
  private relationsOf(ownerPid: string): Map<string, RelationRow> {
    const rows = this.db
      .prepare('SELECT target_pid, favorite, nickname, muted FROM profile_relations WHERE owner_pid = ?')
      .all(ownerPid) as unknown as RelationRow[];
    return new Map(rows.map((row): [string, RelationRow] => [String(row.target_pid), row]));
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

  /** Compare la présence avant écriture à l'état courant : rien si les autres voient la même chose (même statut vu, même titre). */
  private changeSince(pid: string, before: PresenceRow | undefined, now: number): PresenceChange | undefined {
    const after = this.presenceRow(pid);
    const seenChanged = seenStatusOf(before, now) !== seenStatusOf(after, now);
    const watchingChanged = (before?.watching ?? null) !== (after?.watching ?? null);
    if (!seenChanged && !watchingChanged) return undefined;
    const subject = this.subjectView(pid, now);
    if (subject === undefined) return undefined;
    return { subject, ...this.audience(pid) };
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
    // Réglages par ami (profile_relations) : défauts quand il n'y a pas de ligne.
    const relations = this.relationsOf(pid);
    const friendView = (row: ViewRow, household: boolean): FriendView => {
      const relation = relations.get(row.pid);
      const view: FriendView = { ...viewOf(row, now), household, favorite: Number(relation?.favorite ?? 0) === 1, muted: Number(relation?.muted ?? 0) === 1 };
      if (relation?.nickname) view.nickname = relation.nickname;
      return view;
    };
    return {
      friends: friends.map((row) => friendView(row, false)),
      household: household.map((row) => friendView(row, true)),
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
  friendHistory(viewerPid: string, targetPid: string, limit: number): HistoryItem[] | undefined {
    if (this.relationOf(viewerPid, targetPid) === undefined) return undefined;
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
    return rows.map((row) => {
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
  }

  // Messages : conversations entre amis et foyer

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

  /** Cible d'un message : `undefined` si `targetPid` est joignable (ami ou foyer), sinon la raison du refus. */
  private targetError(viewerPid: string, targetPid: string): TargetError | undefined {
    if (targetPid === viewerPid) return 'self';
    if (this.card(targetPid) === undefined) return 'unknown';
    return this.relationOf(viewerPid, targetPid) === undefined ? 'not_friend' : undefined;
  }

  /**
   * Secondes avant le prochain envoi permis, ou `undefined` si le quota de la minute n'est pas atteint. `sql` compte les
   * envois de la fenêtre (paramètres : pid, début de fenêtre) et donne le plus ancien, qui libère une place à son expiration.
   */
  private retryAfter(sql: string, pid: string, limit: number, now: number): number | undefined {
    const row = this.db.prepare(sql).get(pid, now - WRITE_WINDOW_MS);
    if (Number(row?.n ?? 0) < limit) return undefined;
    const oldest = Number(row?.oldest ?? now);
    return Math.max(1, Math.ceil((oldest + WRITE_WINDOW_MS - now) / 1000));
  }

  /** Conversations : amis et foyer, avec le dernier message et le nombre de non-lus. Les plus récentes d'abord, puis par nom. */
  conversations(pid: string): ConversationView[] {
    const views = this.peersOf(pid).map((peer): ConversationView => {
      const last = this.db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE (from_pid = ? AND to_pid = ?) OR (from_pid = ? AND to_pid = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(pid, peer.pid, peer.pid, pid);
      const unread = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE from_pid = ? AND to_pid = ? AND read_at IS NULL').get(peer.pid, pid);
      const view: ConversationView = { pid: peer.pid, handle: peer.handle, avatarColor: peer.avatarColor, unread: Number(unread?.n ?? 0) };
      if (last !== undefined) view.last = messageOf(last as unknown as MessageRow);
      return view;
    });
    return views.sort((a, b) => {
      const byRecency = (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0);
      if (byRecency !== 0) return byRecency;
      return a.handle.name.toLowerCase().localeCompare(b.handle.name.toLowerCase()) || a.handle.tag.localeCompare(b.handle.tag);
    });
  }

  /**
   * Messages échangés avec `targetPid` (dans les deux sens), du plus ancien au plus récent : `limit` au plus, antérieurs à
   * `before` (ms) s'il est donné.
   */
  messagesWith(viewerPid: string, targetPid: string, before: number | undefined, limit: number): MessagesOutcome {
    const failure = this.targetError(viewerPid, targetPid);
    if (failure !== undefined) return { result: failure };
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          WHERE ((from_pid = ? AND to_pid = ?) OR (from_pid = ? AND to_pid = ?)) AND created_at < ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(viewerPid, targetPid, targetPid, viewerPid, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageRow[];
    return { result: 'ok', messages: rows.reverse().map((row) => messageOf(row)) };
  }

  /**
   * Envoi d'un message au profil `toPid`. Refusé (sans rien écrire) si la cible n'est pas joignable ou si l'expéditeur a
   * déjà envoyé 30 messages dans la dernière minute.
   */
  sendMessage(fromPid: string, toPid: string, body: string, context: MessageContext | undefined, now: number): SendOutcome {
    return this.db.transaction((): SendOutcome => {
      const failure = this.targetError(fromPid, toPid);
      if (failure !== undefined) return { result: failure };
      const retryAfterSec = this.retryAfter(SENT_MESSAGES_SQL, fromPid, MESSAGES_PER_MINUTE, now);
      if (retryAfterSec !== undefined) return { result: 'limit_reached', retryAfterSec };
      const id = randomUUID();
      const stored = context === undefined ? null : JSON.stringify(contextOf(context));
      this.db
        .prepare('INSERT INTO messages (id, from_pid, to_pid, body, context, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(id, fromPid, toPid, body, stored, now);
      return { result: 'sent', message: messageOf({ id, from_pid: fromPid, to_pid: toPid, body, context: stored, created_at: now, read_at: null }) };
    });
  }

  /** Marque lus les messages reçus de `fromPid`. `count` : ceux qui viennent de l'être. */
  readFrom(viewerPid: string, fromPid: string, now: number): ReadOutcome {
    return this.db.transaction((): ReadOutcome => {
      const failure = this.targetError(viewerPid, fromPid);
      if (failure !== undefined) return { result: failure };
      const changes = this.db
        .prepare('UPDATE messages SET read_at = ? WHERE from_pid = ? AND to_pid = ? AND read_at IS NULL')
        .run(now, fromPid, viewerPid).changes;
      return { result: 'ok', count: Number(changes), at: now };
    });
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
