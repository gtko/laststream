import { randomUUID } from 'node:crypto';
import { revokeLegacyFriendship } from './social-handles.js';
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
  createdAt: number;
}

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
  status: string | null;
  watching: string | null;
  updated_at: number | null;
}

const VIEW_COLUMNS = `p.pid, p.handle_name, p.handle_tag, p.avatar_color, pr.status, pr.watching, pr.updated_at`;

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
  author: { pid: string; handle: Handle; avatarColor: string };
  pos: number;
  kind: 'text' | 'emoji';
  body: string;
  createdAt: number;
}

/** Cible d'un message refusée : soi-même (400), profil inconnu ou enfant (404), profil ni ami ni du foyer (403). */
export type TargetError = 'self' | 'unknown' | 'not_friend';

export type SendOutcome = { result: TargetError | 'not_allowed' } | { result: 'limit_reached'; retryAfterSec: number } | { result: 'sent'; message: MessageView };
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
}

function noteOf(row: NoteRow): NoteView {
  return {
    id: row.id,
    author: { pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color },
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
      .prepare('SELECT pid, handle_name, handle_tag, avatar_color FROM profiles WHERE pid = ? AND is_kid = 0')
      .get(pid) as { pid: string | null; handle_name: string | null; handle_tag: string | null; avatar_color: string } | undefined;
    if (row === undefined || row.pid === null || row.handle_name === null || row.handle_tag === null) return undefined;
    return { pid: row.pid, handle: handleOf(row.handle_name, row.handle_tag), avatarColor: row.avatar_color };
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
        `SELECT p.pid, p.handle_name, p.handle_tag, p.avatar_color, f.requested_by, f.created_at FROM profile_friendships f
         JOIN profiles p ON p.pid = CASE WHEN f.low_pid = ? THEN f.high_pid ELSE f.low_pid END
         WHERE f.status = 'pending' AND (f.low_pid = ? OR f.high_pid = ?) AND p.is_kid = 0
         ORDER BY f.created_at DESC`,
      )
      .all(pid, pid, pid) as unknown as {
      pid: string;
      handle_name: string;
      handle_tag: string;
      avatar_color: string;
      requested_by: string;
      created_at: number;
    }[];
    const requestView = (row: (typeof pending)[number]): FriendRequestView => ({
      pid: row.pid,
      handle: handleOf(row.handle_name, row.handle_tag),
      avatarColor: row.avatar_color,
      createdAt: Number(row.created_at),
    });
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
        .prepare('SELECT pid, account_id, handle_name, handle_tag, avatar_color FROM profiles WHERE handle_key = ? AND handle_tag = ? AND is_kid = 0')
        .get(handleKey, handleTag) as
        | { pid: string | null; account_id: string; handle_name: string; handle_tag: string; avatar_color: string }
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
        this.db.prepare("UPDATE profile_friendships SET status = 'accepted' WHERE low_pid = ? AND high_pid = ?").run(low, high);
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
      return {
        result: 'sent',
        outgoing: { pid: target.pid, handle: handleOf(target.handle_name, target.handle_tag), avatarColor: target.avatar_color, createdAt: now },
        incoming: { pid: mine.pid, handle: mine.handle, avatarColor: mine.avatarColor, createdAt: now },
      };
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
      this.db.prepare("UPDATE profile_friendships SET status = 'accepted' WHERE low_pid = ? AND high_pid = ?").run(low, high);
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
    // Un blocage, dans un sens ou dans l'autre, rend le profil invisible : même réponse qu'un profil inconnu.
    if (this.isBlockedEither(viewerPid, targetPid)) return 'unknown';
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
      if (!this.acceptsMessagesFrom(toPid, fromPid)) return { result: 'not_allowed' };
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
        `SELECT n.id, n.pos, n.kind, n.body, n.created_at, p.pid, p.handle_name, p.handle_tag, p.avatar_color
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
        author: { pid: author.pid, handle: author.handle, avatarColor: author.avatarColor },
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
