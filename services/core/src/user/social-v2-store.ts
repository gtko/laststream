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

/** Vue d'un profil telle qu'un autre la voit, sans le drapeau « foyer » (posé par l'appelant). */
export interface SubjectView {
  pid: string;
  handle: Handle;
  avatarColor: string;
  status: SeenStatus;
  watching?: Watching;
  /** Dernier battement (ms). Absent pour un profil invisible ou jamais vu. */
  lastSeen?: number;
}

export interface FriendView extends SubjectView {
  household: boolean;
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
      friends: friends.map((row) => ({ ...viewOf(row, now), household: false })),
      household: household.map((row) => ({ ...viewOf(row, now), household: true })),
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
    return Number(this.db.prepare("DELETE FROM profile_friendships WHERE low_pid = ? AND high_pid = ? AND status = 'accepted'").run(low, high).changes) === 1;
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
}
