import { randomBytes } from 'node:crypto';
import { consumeRate } from '../user/rate-hits.js';
import { type Handle, handleOf } from '../user/social-v2-store.js';
import type { SqlDb, SqlRow } from '../user/sql.js';

/**
 * Forum communautaire (LAST-1651) : catégories fixes, sujets, messages, réactions, signalements et modération. Même base que
 * les autres stores (SQLite Node ou Durable Object), requêtes paramétrées. Les auteurs sont des profils (pid) : leur handle
 * et leur avatar sont lus à l'affichage (un profil supprimé apparaît comme « compte supprimé »).
 *
 * L'accès au forum suit l'abonnement de soutien : les routes ouvrent une session (`sessionOf`), qui refuse un compte sans
 * accès quand Stripe est configuré. Ce store ne connaît que les rôles : `owner` (propriétaire du serveur, toujours
 * modérateur), `mod` (nommé par le propriétaire) et `member`. Un profil exclu (forum_bans) lit mais n'écrit plus.
 */

export type ForumRole = 'owner' | 'mod' | 'member';

/** Emojis de réaction permis (une petite palette fixe, comme une messagerie). */
export const FORUM_REACTIONS = ['👍', '❤️', '😂', '😮', '🎬', '🙏', '🔥', '👀'] as const;
export type ForumReaction = (typeof FORUM_REACTIONS)[number];

/** Signalements distincts qui masquent un message en attendant un modérateur. */
const AUTO_HIDE_REPORTS = 3;
/** Sujets par page, messages par page. */
const TOPICS_PAGE = 30;
const POSTS_PAGE = 50;
/** Limites d'écriture par profil. */
const TOPICS_PER_HOUR = 5;
const POSTS_PER_10_MIN = 20;
const REPORTS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Catégorie des watch parties communautaires : chaque sujet y porte une séance (date de début, inscriptions, salon). */
const EVENT_CATEGORY = 'watch-parties';
/** Une séance se programme de 5 minutes à 90 jours à l'avance. */
const EVENT_MIN_LEAD_MS = 5 * 60 * 1000;
const EVENT_MAX_AHEAD_MS = 90 * DAY_MS;
/** Le salon s'ouvre de 15 minutes avant le début à 3 heures après ; la séance reste à l'affiche 3 heures après son début. */
const EVENT_OPEN_LEAD_MS = 15 * 60 * 1000;
const EVENT_OPEN_GRACE_MS = 3 * HOUR_MS;
const ATTENDEES_SHOWN = 12;
/** Accueil vivant : nombre d'éléments par bloc et fenêtres d'activité. */
const PULSE_RECENT = 8;
const PULSE_TRENDING = 5;
const PULSE_MEMBERS = 8;
const PULSE_EVENTS = 6;
const TRENDING_WINDOW_MS = 7 * DAY_MS;
const MEMBERS_WINDOW_MS = 30 * DAY_MS;
const EXCERPT_MAX = 160;

export interface ForumAuthor {
  pid: string;
  /** Absent si le profil n'existe plus. */
  handle?: Handle;
  avatarColor?: string;
  avatar?: string;
  role: ForumRole;
}

export interface ForumCategoryView {
  id: string;
  name: string;
  description: string;
  icon: string;
  staffOnly: boolean;
  topicCount: number;
  postCount: number;
  lastPostAt: number | null;
}

export interface ForumTopicSummary {
  id: string;
  categoryId: string;
  title: string;
  author: ForumAuthor;
  createdAt: number;
  lastPostAt: number;
  lastPoster: ForumAuthor;
  replyCount: number;
  pinned: boolean;
  locked: boolean;
  hidden: boolean;
  /** Séance de watch party (sujets de la catégorie watch-parties). */
  event?: ForumEvent;
}

export interface ForumEvent {
  startsAt: number;
  /** Salon de visionnage ouvert pour la séance, null tant qu'il ne l'est pas. */
  roomId: string | null;
  going: number;
  /** Le profil qui lit est inscrit (absent dans les listes qui ne le calculent pas). */
  mine?: boolean;
}

/** Accueil vivant du forum : chiffres, dernières discussions, sujets en vue, membres actifs, prochaines séances. */
export interface ForumPulse {
  stats: { topics: number; posts: number; members: number; postsToday: number };
  recent: (ForumTopicSummary & { excerpt: string })[];
  trending: (ForumTopicSummary & { heat: number })[];
  activeMembers: { author: ForumAuthor; posts: number }[];
  events: ForumTopicSummary[];
}

export interface ForumPostView {
  id: string;
  author: ForumAuthor;
  /** Texte Markdown ; vide pour un message supprimé ou masqué (sauf pour un modérateur, qui voit le texte masqué). */
  body: string;
  createdAt: number;
  editedAt?: number;
  /** '' visible ; 'author' supprimé ; 'mod' masqué ; 'auto' masqué après signalements. */
  hidden: '' | 'author' | 'mod' | 'auto';
  reactions: { emoji: string; count: number; mine: boolean }[];
  /** Le profil qui lit peut le modifier (auteur, message visible, sujet ouvert ; ou modérateur). */
  canEdit: boolean;
  /** Signalé par le profil qui lit. */
  reported: boolean;
}

export interface ForumTopicDetail extends ForumTopicSummary {
  /** Inscrits à la séance (12 premiers), pour un sujet de watch party. */
  attendees?: ForumAuthor[];
  posts: ForumPostView[];
  /** Il reste des messages après cette page (`?after=` le createdAt du dernier). */
  more: boolean;
}

export interface ForumMe {
  pid: string;
  role: ForumRole;
  /** Exclusion en cours : fin (ms) ou null si définitive ; absent si le profil n'est pas exclu. */
  bannedUntil?: number | null;
}

export interface ForumReportView {
  postId: string;
  topicId: string;
  topicTitle: string;
  author: ForumAuthor;
  body: string;
  hidden: ForumPostView['hidden'];
  count: number;
  reasons: string[];
  details: string[];
  firstAt: number;
}

export interface ForumBanView {
  pid: string;
  author: ForumAuthor;
  until: number | null;
  reason?: string;
  createdAt: number;
}

type Refusal =
  | { result: 'not_found' | 'forbidden' | 'locked' | 'banned' | 'staff_only' | 'invalid_event' | 'event_not_open' }
  | { result: 'rate_limited'; retryAfterSec: number };

export type ForumWrite<T extends object = object> = ({ result: 'ok' } & T) | Refusal;

export interface TopicFlags {
  pinned?: boolean;
  locked?: boolean;
  hidden?: boolean;
  categoryId?: string;
  title?: string;
}

interface AuthorRow {
  pid: string;
  handle_name: string | null;
  handle_tag: string | null;
  avatar_color: string | null;
  avatar: string | null;
  is_owner: number | null;
  is_mod: number | null;
}

const newId = (): string => randomBytes(9).toString('base64url');

/** Colonnes d'auteur jointes : `<alias>` est la colonne pid du sujet ou du message. */
const authorJoin = (pidCol: string, prefix: string): string => `
  LEFT JOIN profiles ${prefix}p ON ${prefix}p.pid = ${pidCol}
  LEFT JOIN accounts ${prefix}a ON ${prefix}a.id = ${prefix}p.account_id
  LEFT JOIN forum_moderators ${prefix}m ON ${prefix}m.pid = ${pidCol}`;
const authorCols = (pidCol: string, prefix: string): string =>
  `${pidCol} AS ${prefix}pid, ${prefix}p.handle_name AS ${prefix}handle_name, ${prefix}p.handle_tag AS ${prefix}handle_tag,
   ${prefix}p.avatar_color AS ${prefix}avatar_color, ${prefix}p.avatar AS ${prefix}avatar,
   ${prefix}a.is_owner AS ${prefix}is_owner, CASE WHEN ${prefix}m.pid IS NULL THEN 0 ELSE 1 END AS ${prefix}is_mod`;

function authorOf(row: SqlRow, prefix: string): ForumAuthor {
  const r: AuthorRow = {
    pid: String(row[`${prefix}pid`]),
    handle_name: (row[`${prefix}handle_name`] as string | null) ?? null,
    handle_tag: (row[`${prefix}handle_tag`] as string | null) ?? null,
    avatar_color: (row[`${prefix}avatar_color`] as string | null) ?? null,
    avatar: (row[`${prefix}avatar`] as string | null) ?? null,
    is_owner: row[`${prefix}is_owner`] === null || row[`${prefix}is_owner`] === undefined ? null : Number(row[`${prefix}is_owner`]),
    is_mod: Number(row[`${prefix}is_mod`] ?? 0),
  };
  const author: ForumAuthor = {
    pid: r.pid,
    role: r.is_owner === 1 ? 'owner' : r.is_mod === 1 ? 'mod' : 'member',
  };
  if (r.handle_name !== null && r.handle_tag !== null) author.handle = handleOf(r.handle_name, r.handle_tag);
  if (r.avatar_color !== null) author.avatarColor = r.avatar_color;
  if (r.avatar !== null && r.avatar !== '') author.avatar = r.avatar;
  return author;
}

/** Sujet, ses deux auteurs et sa séance éventuelle ; `extra` ajoute des colonnes calculées (sans paramètre). */
const topicSelect = (extra = ''): string => `
  SELECT t.*, ${authorCols('t.author_pid', 'au_')}, ${authorCols('t.last_post_pid', 'lp_')},
    ev.starts_at AS ev_starts_at, ev.room_id AS ev_room_id,
    (SELECT COUNT(*) FROM forum_event_rsvps r WHERE r.topic_id = t.id) AS ev_going${extra}
  FROM forum_topics t ${authorJoin('t.author_pid', 'au_')} ${authorJoin('t.last_post_pid', 'lp_')}
  LEFT JOIN forum_events ev ON ev.topic_id = t.id`;
const TOPIC_SELECT = topicSelect();

function topicOf(row: SqlRow): ForumTopicSummary {
  return {
    id: String(row.id),
    categoryId: String(row.category_id),
    title: String(row.title),
    author: authorOf(row, 'au_'),
    createdAt: Number(row.created_at),
    lastPostAt: Number(row.last_post_at),
    lastPoster: authorOf(row, 'lp_'),
    replyCount: Number(row.reply_count),
    pinned: Number(row.pinned) === 1,
    locked: Number(row.locked) === 1,
    hidden: Number(row.hidden) === 1,
    ...(row.ev_starts_at === null || row.ev_starts_at === undefined
      ? {}
      : {
          event: {
            startsAt: Number(row.ev_starts_at),
            roomId: row.ev_room_id === null || row.ev_room_id === undefined ? null : String(row.ev_room_id),
            going: Number(row.ev_going ?? 0),
          },
        }),
  };
}

/**
 * Extrait en texte brut d'un message (accueil) : spoilers remplacés, marques Markdown retirées, espaces resserrés, coupé à
 * 160 caractères. Le client l'affiche comme texte, jamais comme HTML.
 */
function excerptOf(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]')
    .replace(/^>.*$/gm, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...plain];
  return chars.length > EXCERPT_MAX
    ? `${chars
        .slice(0, EXCERPT_MAX - 1)
        .join('')
        .trimEnd()}…`
    : plain;
}

/** Message et son auteur ; le premier paramètre est le pid du lecteur (« signalé par moi »). */
const POST_SELECT = `
  SELECT fp.*, ${authorCols('fp.author_pid', 'au_')},
    EXISTS (SELECT 1 FROM forum_reports r WHERE r.post_id = fp.id AND r.reporter_pid = ?) AS reported
  FROM forum_posts fp ${authorJoin('fp.author_pid', 'au_')}`;

export const isStaff = (role: ForumRole): boolean => role !== 'member';

/** Échappe `%`, `_` et `\` pour un LIKE … ESCAPE '\'. */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export class ForumStore {
  constructor(private readonly db: SqlDb) {}

  /**
   * Rôle et exclusion d'un profil. `owner` : profil d'un compte propriétaire, hors session verrouillée sur un invité du foyer
   * (`locked`). Une exclusion expirée est oubliée.
   */
  me(accountId: string, pid: string, locked: boolean, now: number): ForumMe {
    const owner = this.db.prepare('SELECT is_owner FROM accounts WHERE id = ?').get(accountId);
    const mod = this.db.prepare('SELECT 1 FROM forum_moderators WHERE pid = ?').get(pid);
    const role: ForumRole = !locked && Number(owner?.is_owner ?? 0) === 1 ? 'owner' : mod !== undefined ? 'mod' : 'member';
    const me: ForumMe = { pid, role };
    const ban = this.db.prepare('SELECT until FROM forum_bans WHERE pid = ?').get(pid);
    if (ban !== undefined) {
      const until = ban.until === null ? null : Number(ban.until);
      if (until === null || until > now) me.bannedUntil = until;
      else this.db.prepare('DELETE FROM forum_bans WHERE pid = ?').run(pid);
    }
    return me;
  }

  /** Catégories avec leurs compteurs (sujets et messages visibles) et la date du dernier message. */
  categories(): ForumCategoryView[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM forum_topics t WHERE t.category_id = c.id AND t.hidden = 0) AS topic_count,
           (SELECT COALESCE(SUM(t.reply_count + 1), 0) FROM forum_topics t WHERE t.category_id = c.id AND t.hidden = 0) AS post_count,
           (SELECT MAX(t.last_post_at) FROM forum_topics t WHERE t.category_id = c.id AND t.hidden = 0) AS last_post_at
         FROM forum_categories c ORDER BY c.position`,
      )
      .all();
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      icon: String(row.icon),
      staffOnly: Number(row.staff_only) === 1,
      topicCount: Number(row.topic_count),
      postCount: Number(row.post_count),
      lastPostAt: row.last_post_at === null ? null : Number(row.last_post_at),
    }));
  }

  private categoryExists(id: string): { staffOnly: boolean } | undefined {
    const row = this.db.prepare('SELECT staff_only FROM forum_categories WHERE id = ?').get(id);
    return row === undefined ? undefined : { staffOnly: Number(row.staff_only) === 1 };
  }

  /**
   * Sujets d'une catégorie, du plus récemment actif au plus ancien ; les sujets épinglés viennent en tête de la première page.
   * `before` : lastPostAt exclu (page suivante). Les sujets masqués ne sont listés que pour un modérateur.
   */
  topics(
    categoryId: string,
    role: ForumRole,
    before: number | undefined,
    limit: number = TOPICS_PAGE,
  ): { topics: ForumTopicSummary[]; more: boolean } | undefined {
    if (this.categoryExists(categoryId) === undefined) return undefined;
    const hiddenClause = isStaff(role) ? '' : 'AND t.hidden = 0';
    const pinned =
      before === undefined
        ? this.db.prepare(`${TOPIC_SELECT} WHERE t.category_id = ? AND t.pinned = 1 ${hiddenClause} ORDER BY t.last_post_at DESC`).all(categoryId).map(topicOf)
        : [];
    const rows = this.db
      .prepare(`${TOPIC_SELECT} WHERE t.category_id = ? AND t.pinned = 0 ${hiddenClause} AND t.last_post_at < ? ORDER BY t.last_post_at DESC LIMIT ?`)
      .all(categoryId, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
      .map(topicOf);
    return {
      topics: [...pinned, ...rows.slice(0, limit)],
      more: rows.length > limit,
    };
  }

  /** Recherche dans les titres et les messages visibles (30 sujets au plus, du plus récent au plus ancien). */
  search(query: string, role: ForumRole, limit: number = TOPICS_PAGE): ForumTopicSummary[] {
    const like = `%${likeEscape(query)}%`;
    const hiddenClause = isStaff(role) ? '' : 'AND t.hidden = 0';
    return this.db
      .prepare(
        `${TOPIC_SELECT}
         WHERE (t.title LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM forum_posts fp WHERE fp.topic_id = t.id AND fp.hidden = '' AND fp.body LIKE ? ESCAPE '\\'))
         ${hiddenClause}
         ORDER BY t.last_post_at DESC LIMIT ?`,
      )
      .all(like, like, limit)
      .map(topicOf);
  }

  private topicRow(id: string): SqlRow | undefined {
    return this.db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).get(id);
  }

  /** Sujet et une page de ses messages (`after` : createdAt exclu). Un sujet masqué n'existe que pour un modérateur. */
  topic(id: string, me: ForumMe, after: number | undefined, limit: number = POSTS_PAGE): ForumTopicDetail | undefined {
    const row = this.topicRow(id);
    if (row === undefined) return undefined;
    const topic = topicOf(row);
    if (topic.hidden && !isStaff(me.role)) return undefined;
    const rows = this.db
      .prepare(`${POST_SELECT} WHERE fp.topic_id = ? AND fp.created_at > ? ORDER BY fp.created_at, fp.id LIMIT ?`)
      .all(me.pid, id, after ?? -1, limit + 1);
    const detail: ForumTopicDetail = {
      ...topic,
      posts: this.postsOf(rows.slice(0, limit), me, topic.locked),
      more: rows.length > limit,
    };
    if (topic.event !== undefined) {
      topic.event.mine = this.rsvped(id, me.pid);
      detail.event = topic.event;
      detail.attendees = this.db
        .prepare(
          `SELECT ${authorCols('r.pid', 'au_')} FROM forum_event_rsvps r ${authorJoin('r.pid', 'au_')}
           WHERE r.topic_id = ? ORDER BY r.created_at LIMIT ?`,
        )
        .all(id, ATTENDEES_SHOWN)
        .map((r) => authorOf(r, 'au_'));
    }
    return detail;
  }

  private rsvped(topicId: string, pid: string): boolean {
    return this.db.prepare('SELECT 1 FROM forum_event_rsvps WHERE topic_id = ? AND pid = ?').get(topicId, pid) !== undefined;
  }

  /**
   * Accueil vivant : chiffres du forum (sujets et messages visibles, membres ayant écrit, messages des dernières 24 h),
   * 8 dernières discussions avec un extrait du dernier message, 5 sujets les plus actifs sur 7 jours, 8 membres les plus
   * actifs sur 30 jours et les 6 prochaines séances de watch party (déjà commencées depuis moins de 3 h comprises).
   * Seuls les sujets et messages visibles comptent, quel que soit le rôle du lecteur.
   */
  pulse(me: ForumMe, now: number): ForumPulse {
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM forum_topics WHERE hidden = 0) AS topics,
           (SELECT COUNT(*) FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id WHERE p.hidden = '' AND t.hidden = 0) AS posts,
           (SELECT COUNT(DISTINCT p.author_pid) FROM forum_posts p WHERE p.hidden = '') AS members,
           (SELECT COUNT(*) FROM forum_posts p JOIN forum_topics t ON t.id = p.topic_id
              WHERE p.hidden = '' AND t.hidden = 0 AND p.created_at > ?) AS posts_today`,
      )
      .get(now - DAY_MS);
    const recent = this.db
      .prepare(
        `${topicSelect(`, (SELECT p.body FROM forum_posts p WHERE p.topic_id = t.id AND p.hidden = '' ORDER BY p.created_at DESC LIMIT 1) AS last_body`)}
         WHERE t.hidden = 0 ORDER BY t.last_post_at DESC LIMIT ?`,
      )
      .all(PULSE_RECENT)
      .map((row) => ({ ...topicOf(row), excerpt: excerptOf(String(row.last_body ?? '')) }));
    const trending = this.db
      .prepare(
        `${topicSelect(', h.heat AS heat')}
         JOIN (SELECT topic_id, COUNT(*) AS heat FROM forum_posts WHERE hidden = '' AND created_at > ? GROUP BY topic_id) h ON h.topic_id = t.id
         WHERE t.hidden = 0 ORDER BY h.heat DESC, t.last_post_at DESC LIMIT ?`,
      )
      .all(now - TRENDING_WINDOW_MS, PULSE_TRENDING)
      .map((row) => ({ ...topicOf(row), heat: Number(row.heat) }));
    const activeMembers = this.db
      .prepare(
        `SELECT q.n, ${authorCols('q.author_pid', 'au_')}
         FROM (SELECT author_pid, COUNT(*) AS n FROM forum_posts WHERE hidden = '' AND created_at > ? GROUP BY author_pid ORDER BY n DESC LIMIT ?) q
         ${authorJoin('q.author_pid', 'au_')}
         ORDER BY q.n DESC`,
      )
      .all(now - MEMBERS_WINDOW_MS, PULSE_MEMBERS)
      .map((row) => ({ author: authorOf(row, 'au_'), posts: Number(row.n) }))
      .filter((m) => m.author.handle !== undefined);
    const events = this.db
      .prepare(`${TOPIC_SELECT} WHERE t.hidden = 0 AND ev.starts_at > ? ORDER BY ev.starts_at LIMIT ?`)
      .all(now - EVENT_OPEN_GRACE_MS, PULSE_EVENTS)
      .map(topicOf);
    for (const topic of events) if (topic.event !== undefined) topic.event.mine = this.rsvped(topic.id, me.pid);
    return {
      stats: {
        topics: Number(counts?.topics ?? 0),
        posts: Number(counts?.posts ?? 0),
        members: Number(counts?.members ?? 0),
        postsToday: Number(counts?.posts_today ?? 0),
      },
      recent,
      trending,
      activeMembers,
      events,
    };
  }

  private postsOf(rows: SqlRow[], me: ForumMe, locked: boolean): ForumPostView[] {
    const reactions = this.reactionsOf(
      rows.map((r) => String(r.id)),
      me.pid,
    );
    return rows.map((r): ForumPostView => {
      const hidden = String(r.hidden) as ForumPostView['hidden'];
      const authorPid = String(r.author_pid);
      // Un modérateur voit le texte d'un message masqué (pas celui d'un message supprimé par son auteur : il est effacé).
      const showBody = hidden === '' || (isStaff(me.role) && hidden !== 'author');
      const post: ForumPostView = {
        id: String(r.id),
        author: authorOf(r, 'au_'),
        body: showBody ? String(r.body) : '',
        createdAt: Number(r.created_at),
        hidden,
        reactions: reactions.get(String(r.id)) ?? [],
        canEdit: hidden !== 'author' && (isStaff(me.role) || (authorPid === me.pid && hidden === '' && !locked && me.bannedUntil === undefined)),
        reported: Number(r.reported) === 1,
      };
      if (r.edited_at !== null && r.edited_at !== undefined) post.editedAt = Number(r.edited_at);
      return post;
    });
  }

  private reactionsOf(postIds: string[], pid: string): Map<string, ForumPostView['reactions']> {
    const out = new Map<string, ForumPostView['reactions']>();
    if (postIds.length === 0) return out;
    const marks = postIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT post_id, emoji, COUNT(*) AS n, MAX(CASE WHEN pid = ? THEN 1 ELSE 0 END) AS mine, MIN(created_at) AS first
         FROM forum_reactions WHERE post_id IN (${marks}) GROUP BY post_id, emoji ORDER BY first`,
      )
      .all(pid, ...postIds);
    for (const row of rows) {
      const list = out.get(String(row.post_id)) ?? [];
      list.push({
        emoji: String(row.emoji),
        count: Number(row.n),
        mine: Number(row.mine) === 1,
      });
      out.set(String(row.post_id), list);
    }
    return out;
  }

  private writeGate(me: ForumMe): Refusal | undefined {
    if (me.bannedUntil !== undefined) return { result: 'banned' };
    return undefined;
  }

  private rate(bucket: string, pid: string, limit: number, windowMs: number, now: number): Refusal | undefined {
    const retryAfterSec = consumeRate(this.db, bucket, pid, limit, windowMs, now);
    return retryAfterSec === undefined ? undefined : { result: 'rate_limited', retryAfterSec };
  }

  /**
   * Ouvre un sujet et son premier message. 5 sujets par heure (les modérateurs ne sont pas limités). Dans la catégorie des
   * watch parties, `startsAt` (de 5 min à 90 jours à l'avance) est obligatoire et l'auteur est inscrit à sa séance ; ailleurs
   * il est refusé (`invalid_event`).
   */
  createTopic(
    me: ForumMe,
    categoryId: string,
    title: string,
    body: string,
    now: number,
    startsAt?: number,
  ): ForumWrite<{ topic: ForumTopicSummary; postId: string }> {
    const gate = this.writeGate(me);
    if (gate !== undefined) return gate;
    const category = this.categoryExists(categoryId);
    if (category === undefined) return { result: 'not_found' };
    if (category.staffOnly && !isStaff(me.role)) return { result: 'staff_only' };
    const isEvent = categoryId === EVENT_CATEGORY;
    if (isEvent !== (startsAt !== undefined)) return { result: 'invalid_event' };
    if (startsAt !== undefined && (startsAt < now + EVENT_MIN_LEAD_MS || startsAt > now + EVENT_MAX_AHEAD_MS)) return { result: 'invalid_event' };
    return this.db.transaction(() => {
      if (!isStaff(me.role)) {
        const limited = this.rate('forumTopic', me.pid, TOPICS_PER_HOUR, HOUR_MS, now);
        if (limited !== undefined) return limited;
      }
      const id = newId();
      const postId = newId();
      this.db
        .prepare('INSERT INTO forum_topics (id, category_id, author_pid, title, created_at, last_post_at, last_post_pid) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, categoryId, me.pid, title, now, now, me.pid);
      this.db.prepare('INSERT INTO forum_posts (id, topic_id, author_pid, body, created_at) VALUES (?, ?, ?, ?, ?)').run(postId, id, me.pid, body, now);
      if (startsAt !== undefined) {
        this.db.prepare('INSERT INTO forum_events (topic_id, starts_at) VALUES (?, ?)').run(id, startsAt);
        this.db.prepare('INSERT INTO forum_event_rsvps (topic_id, pid, created_at) VALUES (?, ?, ?)').run(id, me.pid, now);
      }
      const row = this.topicRow(id);
      if (row === undefined) throw new Error('sujet introuvable après création');
      return { result: 'ok' as const, topic: topicOf(row), postId };
    });
  }

  /** Répond dans un sujet. Refusé dans un sujet verrouillé (sauf modérateur). 20 messages par 10 minutes. */
  reply(me: ForumMe, topicId: string, body: string, now: number): ForumWrite<{ post: ForumPostView; topic: ForumTopicSummary }> {
    const gate = this.writeGate(me);
    if (gate !== undefined) return gate;
    const row = this.topicRow(topicId);
    if (row === undefined) return { result: 'not_found' };
    const topic = topicOf(row);
    if (topic.hidden && !isStaff(me.role)) return { result: 'not_found' };
    if (topic.locked && !isStaff(me.role)) return { result: 'locked' };
    return this.db.transaction(() => {
      if (!isStaff(me.role)) {
        const limited = this.rate('forumPost', me.pid, POSTS_PER_10_MIN, TEN_MIN_MS, now);
        if (limited !== undefined) return limited;
      }
      const id = newId();
      // Deux messages au même instant : l'ordre reste stable (created_at strictement croissant dans un sujet).
      const last = this.db.prepare('SELECT MAX(created_at) AS m FROM forum_posts WHERE topic_id = ?').get(topicId);
      const at = Math.max(now, Number(last?.m ?? 0) + 1);
      this.db.prepare('INSERT INTO forum_posts (id, topic_id, author_pid, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, topicId, me.pid, body, at);
      this.db.prepare('UPDATE forum_topics SET reply_count = reply_count + 1, last_post_at = ?, last_post_pid = ? WHERE id = ?').run(at, me.pid, topicId);
      const post = this.postView(id, me);
      const updated = this.topicRow(topicId);
      if (post === undefined || updated === undefined) throw new Error('message introuvable après création');
      return { result: 'ok' as const, post, topic: topicOf(updated) };
    });
  }

  private postView(postId: string, me: ForumMe): ForumPostView | undefined {
    const row = this.db.prepare(`${POST_SELECT} WHERE fp.id = ?`).get(me.pid, postId);
    if (row === undefined) return undefined;
    const topic = this.db.prepare('SELECT locked FROM forum_topics WHERE id = ?').get(String(row.topic_id));
    return this.postsOf([row], me, Number(topic?.locked ?? 0) === 1)[0];
  }

  private postMeta(postId: string):
    | {
        topicId: string;
        authorPid: string;
        hidden: string;
        first: boolean;
        locked: boolean;
        topicHidden: boolean;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT fp.topic_id, fp.author_pid, fp.hidden, t.locked, t.hidden AS topic_hidden,
           (SELECT f.id FROM forum_posts f WHERE f.topic_id = fp.topic_id ORDER BY f.created_at, f.id LIMIT 1) = fp.id AS first
         FROM forum_posts fp JOIN forum_topics t ON t.id = fp.topic_id WHERE fp.id = ?`,
      )
      .get(postId);
    if (row === undefined) return undefined;
    return {
      topicId: String(row.topic_id),
      authorPid: String(row.author_pid),
      hidden: String(row.hidden),
      first: Number(row.first) === 1,
      locked: Number(row.locked) === 1,
      topicHidden: Number(row.topic_hidden) === 1,
    };
  }

  /** Modifie un message : son auteur (message visible, sujet ouvert, non exclu) ou un modérateur. */
  editPost(me: ForumMe, postId: string, body: string, now: number): ForumWrite<{ post: ForumPostView; topicId: string }> {
    const meta = this.postMeta(postId);
    if (meta === undefined || (meta.topicHidden && !isStaff(me.role))) return { result: 'not_found' };
    if (!isStaff(me.role)) {
      if (meta.authorPid !== me.pid || meta.hidden !== '') return { result: 'forbidden' };
      const gate = this.writeGate(me);
      if (gate !== undefined) return gate;
      if (meta.locked) return { result: 'locked' };
    }
    this.db.prepare('UPDATE forum_posts SET body = ?, edited_at = ? WHERE id = ?').run(body, now, postId);
    const post = this.postView(postId, me);
    if (post === undefined) return { result: 'not_found' };
    return { result: 'ok', post, topicId: meta.topicId };
  }

  /**
   * Supprime son message : le texte est effacé et le message reste en place (« message supprimé »). Le premier message d'un
   * sujet sans réponse emporte le sujet (masqué). Un modérateur supprime de la même façon n'importe quel message.
   */
  deletePost(me: ForumMe, postId: string): ForumWrite<{ topicId: string; topicRemoved: boolean }> {
    const meta = this.postMeta(postId);
    if (meta === undefined || (meta.topicHidden && !isStaff(me.role))) return { result: 'not_found' };
    if (!isStaff(me.role) && meta.authorPid !== me.pid) return { result: 'forbidden' };
    return this.db.transaction(() => {
      this.db.prepare("UPDATE forum_posts SET body = '', hidden = 'author' WHERE id = ?").run(postId);
      this.db.prepare("UPDATE forum_reports SET status = 'closed' WHERE post_id = ?").run(postId);
      let topicRemoved = false;
      if (meta.first) {
        const replies = this.db
          .prepare("SELECT COUNT(*) AS n FROM forum_posts WHERE topic_id = ? AND id != ? AND hidden != 'author'")
          .get(meta.topicId, postId);
        if (Number(replies?.n ?? 0) === 0) {
          this.db.prepare('UPDATE forum_topics SET hidden = 1 WHERE id = ?').run(meta.topicId);
          topicRemoved = true;
        }
      }
      return { result: 'ok' as const, topicId: meta.topicId, topicRemoved };
    });
  }

  /** Ajoute ou retire une réaction (emoji de la palette) sur un message visible. Rend les réactions à jour du message. */
  react(me: ForumMe, postId: string, emoji: ForumReaction, on: boolean, now: number): ForumWrite<{ reactions: ForumPostView['reactions']; topicId: string }> {
    const gate = this.writeGate(me);
    if (gate !== undefined) return gate;
    const meta = this.postMeta(postId);
    if (meta === undefined || meta.hidden !== '' || (meta.topicHidden && !isStaff(me.role))) return { result: 'not_found' };
    if (on) this.db.prepare('INSERT OR IGNORE INTO forum_reactions (post_id, pid, emoji, created_at) VALUES (?, ?, ?, ?)').run(postId, me.pid, emoji, now);
    else this.db.prepare('DELETE FROM forum_reactions WHERE post_id = ? AND pid = ? AND emoji = ?').run(postId, me.pid, emoji);
    return {
      result: 'ok',
      reactions: this.reactionsOf([postId], me.pid).get(postId) ?? [],
      topicId: meta.topicId,
    };
  }

  /**
   * Signale un message (une fois par profil). À AUTO_HIDE_REPORTS signalements ouverts distincts, le message est masqué
   * (`auto`) en attendant un modérateur. Son propre message ne se signale pas ; un message du propriétaire ou d'un modérateur
   * se signale, mais n'est jamais masqué automatiquement.
   */
  report(me: ForumMe, postId: string, reason: string, details: string | undefined, now: number): ForumWrite<{ autoHidden: boolean }> {
    const meta = this.postMeta(postId);
    if (meta === undefined || meta.hidden === 'author' || (meta.topicHidden && !isStaff(me.role))) return { result: 'not_found' };
    if (meta.authorPid === me.pid) return { result: 'forbidden' };
    return this.db.transaction(() => {
      const limited = this.rate('forumReport', me.pid, REPORTS_PER_HOUR, HOUR_MS, now);
      if (limited !== undefined) return limited;
      this.db
        .prepare('INSERT OR IGNORE INTO forum_reports (post_id, reporter_pid, reason, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(postId, me.pid, reason, details ?? null, now);
      let autoHidden = false;
      if (meta.hidden === '') {
        const open = this.db.prepare("SELECT COUNT(*) AS n FROM forum_reports WHERE post_id = ? AND status = 'open'").get(postId);
        const authorRole = this.roleOfPid(meta.authorPid);
        if (Number(open?.n ?? 0) >= AUTO_HIDE_REPORTS && authorRole === 'member') {
          this.db.prepare("UPDATE forum_posts SET hidden = 'auto' WHERE id = ?").run(postId);
          autoHidden = true;
        }
      }
      return { result: 'ok' as const, autoHidden };
    });
  }

  private roleOfPid(pid: string): ForumRole {
    const row = this.db.prepare('SELECT a.is_owner FROM profiles p JOIN accounts a ON a.id = p.account_id WHERE p.pid = ?').get(pid);
    if (Number(row?.is_owner ?? 0) === 1) return 'owner';
    return this.db.prepare('SELECT 1 FROM forum_moderators WHERE pid = ?').get(pid) !== undefined ? 'mod' : 'member';
  }

  // ---- Watch parties ----

  /** Séance d'un sujet visible pour ce lecteur, ou undefined. */
  private eventOf(topicId: string, me: ForumMe): { topic: ForumTopicSummary; event: ForumEvent } | undefined {
    const row = this.topicRow(topicId);
    if (row === undefined) return undefined;
    const topic = topicOf(row);
    if ((topic.hidden && !isStaff(me.role)) || topic.event === undefined) return undefined;
    return { topic, event: topic.event };
  }

  /** S'inscrit à une séance ou se désinscrit. Fermé 3 h après le début (`event_not_open`). Les exclus ne s'inscrivent plus. */
  rsvp(me: ForumMe, topicId: string, on: boolean, now: number): ForumWrite<{ event: ForumEvent }> {
    const gate = this.writeGate(me);
    if (gate !== undefined) return gate;
    const found = this.eventOf(topicId, me);
    if (found === undefined) return { result: 'not_found' };
    if (now > found.event.startsAt + EVENT_OPEN_GRACE_MS) return { result: 'event_not_open' };
    if (on) this.db.prepare('INSERT OR IGNORE INTO forum_event_rsvps (topic_id, pid, created_at) VALUES (?, ?, ?)').run(topicId, me.pid, now);
    else this.db.prepare('DELETE FROM forum_event_rsvps WHERE topic_id = ? AND pid = ?').run(topicId, me.pid);
    const after = this.eventOf(topicId, me);
    if (after === undefined) return { result: 'not_found' };
    return { result: 'ok', event: { ...after.event, mine: on } };
  }

  /**
   * Vérifie qu'un profil peut ouvrir le salon d'une séance : auteur du sujet ou équipe, de 15 min avant le début à 3 h après.
   * Rend le titre du sujet et le salon déjà rattaché (null sinon).
   */
  eventOpening(me: ForumMe, topicId: string, now: number): ForumWrite<{ title: string; roomId: string | null }> {
    const gate = this.writeGate(me);
    if (gate !== undefined) return gate;
    const found = this.eventOf(topicId, me);
    if (found === undefined) return { result: 'not_found' };
    if (found.topic.author.pid !== me.pid && !isStaff(me.role)) return { result: 'forbidden' };
    if (found.event.roomId !== null) return { result: 'ok', title: found.topic.title, roomId: found.event.roomId };
    if (now < found.event.startsAt - EVENT_OPEN_LEAD_MS || now > found.event.startsAt + EVENT_OPEN_GRACE_MS) return { result: 'event_not_open' };
    return { result: 'ok', title: found.topic.title, roomId: null };
  }

  /** Rattache un salon à une séance ; le premier rattachement gagne. Rend le salon effectif (undefined : séance disparue). */
  attachRoom(topicId: string, roomId: string): string | undefined {
    this.db.prepare('UPDATE forum_events SET room_id = ? WHERE topic_id = ? AND room_id IS NULL').run(roomId, topicId);
    const row = this.db.prepare('SELECT room_id FROM forum_events WHERE topic_id = ?').get(topicId);
    return row === undefined || row.room_id === null ? undefined : String(row.room_id);
  }

  /** Détache un salon terminé de sa séance (pour en rouvrir un). */
  detachRoom(topicId: string, roomId: string): void {
    this.db.prepare('UPDATE forum_events SET room_id = NULL WHERE topic_id = ? AND room_id = ?').run(topicId, roomId);
  }

  // ---- Modération (rôles owner et mod ; les routes vérifient le rôle) ----

  /** Épingle, verrouille, masque, déplace ou renomme un sujet. */
  setTopic(topicId: string, flags: TopicFlags): ForumWrite<{ topic: ForumTopicSummary }> {
    if (this.topicRow(topicId) === undefined) return { result: 'not_found' };
    if (flags.categoryId !== undefined && this.categoryExists(flags.categoryId) === undefined) return { result: 'not_found' };
    const columns: [string, string | number | undefined][] = [
      ['pinned', flags.pinned === undefined ? undefined : Number(flags.pinned)],
      ['locked', flags.locked === undefined ? undefined : Number(flags.locked)],
      ['hidden', flags.hidden === undefined ? undefined : Number(flags.hidden)],
      ['category_id', flags.categoryId],
      ['title', flags.title],
    ];
    const changed = columns.filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    const sets = changed.map(([column]) => `${column} = ?`);
    const args = changed.map(([, value]) => value);
    if (sets.length > 0) this.db.prepare(`UPDATE forum_topics SET ${sets.join(', ')} WHERE id = ?`).run(...args, topicId);
    const row = this.topicRow(topicId);
    if (row === undefined) return { result: 'not_found' };
    return { result: 'ok', topic: topicOf(row) };
  }

  /** Masque (`mod`) ou rétablit un message ; les signalements ouverts du message sont clos dans les deux cas. */
  moderatePost(postId: string, hide: boolean): ForumWrite<{ topicId: string }> {
    const meta = this.postMeta(postId);
    if (meta === undefined || meta.hidden === 'author') return { result: 'not_found' };
    this.db.transaction(() => {
      this.db.prepare('UPDATE forum_posts SET hidden = ? WHERE id = ?').run(hide ? 'mod' : '', postId);
      this.db.prepare("UPDATE forum_reports SET status = 'closed' WHERE post_id = ?").run(postId);
    });
    return { result: 'ok', topicId: meta.topicId };
  }

  /** File de modération : messages qui ont des signalements ouverts, le plus signalé d'abord. */
  reports(limit = 100): ForumReportView[] {
    const rows = this.db
      .prepare(
        `SELECT r.post_id, COUNT(*) AS n, MIN(r.created_at) AS first_at,
           GROUP_CONCAT(r.reason, '|') AS reasons, GROUP_CONCAT(COALESCE(r.details, ''), '\u001f') AS details,
           fp.topic_id, fp.body, fp.hidden, t.title, ${authorCols('fp.author_pid', 'au_')}
         FROM forum_reports r
         JOIN forum_posts fp ON fp.id = r.post_id
         JOIN forum_topics t ON t.id = fp.topic_id
         ${authorJoin('fp.author_pid', 'au_')}
         WHERE r.status = 'open'
         GROUP BY r.post_id ORDER BY n DESC, first_at LIMIT ?`,
      )
      .all(limit);
    return rows.map((row) => ({
      postId: String(row.post_id),
      topicId: String(row.topic_id),
      topicTitle: String(row.title),
      author: authorOf(row, 'au_'),
      body: String(row.body),
      hidden: String(row.hidden) as ForumPostView['hidden'],
      count: Number(row.n),
      reasons: [
        ...new Set(
          String(row.reasons ?? '')
            .split('|')
            .filter(Boolean),
        ),
      ],
      details: String(row.details ?? '')
        .split('\u001f')
        .filter((d) => d !== ''),
      firstAt: Number(row.first_at),
    }));
  }

  /** Nombre de messages en attente de modération (pastille). */
  openReportCount(): number {
    return Number(this.db.prepare("SELECT COUNT(DISTINCT post_id) AS n FROM forum_reports WHERE status = 'open'").get()?.n ?? 0);
  }

  /** Classe les signalements d'un message sans rien changer (message gardé, et rétabli s'il était masqué automatiquement). */
  dismissReports(postId: string): ForumWrite<{ topicId: string }> {
    const meta = this.postMeta(postId);
    if (meta === undefined) return { result: 'not_found' };
    this.db.transaction(() => {
      if (meta.hidden === 'auto') this.db.prepare("UPDATE forum_posts SET hidden = '' WHERE id = ?").run(postId);
      this.db.prepare("UPDATE forum_reports SET status = 'closed' WHERE post_id = ?").run(postId);
    });
    return { result: 'ok', topicId: meta.topicId };
  }

  /** Exclut un profil (jours, ou null pour une exclusion définitive). Le propriétaire et les modérateurs ne s'excluent pas. */
  ban(byPid: string, pid: string, days: number | null, reason: string | undefined, now: number): ForumWrite<{ until: number | null }> {
    if (this.db.prepare('SELECT 1 FROM profiles WHERE pid = ?').get(pid) === undefined) return { result: 'not_found' };
    if (this.roleOfPid(pid) !== 'member') return { result: 'forbidden' };
    const until = days === null ? null : now + days * 24 * HOUR_MS;
    this.db
      .prepare(
        `INSERT INTO forum_bans (pid, until, reason, by_pid, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pid) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_pid = excluded.by_pid, created_at = excluded.created_at`,
      )
      .run(pid, until, reason ?? null, byPid, now);
    return { result: 'ok', until };
  }

  unban(pid: string): boolean {
    return Number(this.db.prepare('DELETE FROM forum_bans WHERE pid = ?').run(pid).changes) > 0;
  }

  bans(now: number): ForumBanView[] {
    this.db.prepare('DELETE FROM forum_bans WHERE until IS NOT NULL AND until <= ?').run(now);
    return this.db
      .prepare(`SELECT b.*, ${authorCols('b.pid', 'au_')} FROM forum_bans b ${authorJoin('b.pid', 'au_')} ORDER BY b.created_at DESC`)
      .all()
      .map((row) => {
        const ban: ForumBanView = {
          pid: String(row.pid),
          author: authorOf(row, 'au_'),
          until: row.until === null ? null : Number(row.until),
          createdAt: Number(row.created_at),
        };
        if (row.reason !== null) ban.reason = String(row.reason);
        return ban;
      });
  }

  /** Modérateurs nommés (le propriétaire n'y figure pas : il l'est d'office). */
  moderators(): ForumAuthor[] {
    return this.db
      .prepare(`SELECT ${authorCols('fm.pid', 'au_')} FROM forum_moderators fm ${authorJoin('fm.pid', 'au_')} ORDER BY fm.added_at`)
      .all()
      .map((row) => authorOf(row, 'au_'));
  }

  /** Nomme un modérateur par son handle (clé normalisée du nom et tag, voir parseHandle), profil non enfant. */
  addModerator(key: string, tag: string, now: number): ForumWrite<{ moderator: ForumAuthor }> {
    const row = this.db.prepare('SELECT pid FROM profiles WHERE handle_key = ? AND handle_tag = ? AND is_kid = 0 AND pid IS NOT NULL').get(key, tag);
    if (row === undefined) return { result: 'not_found' };
    const pid = String(row.pid);
    this.db.prepare('INSERT OR IGNORE INTO forum_moderators (pid, added_at) VALUES (?, ?)').run(pid, now);
    this.db.prepare('DELETE FROM forum_bans WHERE pid = ?').run(pid);
    const moderator = this.moderators().find((m) => m.pid === pid);
    if (moderator === undefined) return { result: 'not_found' };
    return { result: 'ok', moderator };
  }

  removeModerator(pid: string): boolean {
    return Number(this.db.prepare('DELETE FROM forum_moderators WHERE pid = ?').run(pid).changes) > 0;
  }
}
