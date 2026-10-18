import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlDb } from './sql.js';

/**
 * Données sociales : parrainage, amis, présence, titres masqués, annuaire des salons. Même base et mêmes migrations que
 * UserStore (SQLite Node ou Durable Object). Toutes les requêtes sont paramétrées ; les noms d'utilisateur sont déjà
 * normalisés en minuscules par la validation.
 */

/** Liens de parrainage par compte, par défaut ; le propriétaire peut l'ajuster (0 à MAX_INVITE_QUOTA). */
export const DEFAULT_INVITE_QUOTA = 4;
export const MAX_INVITE_QUOTA = 100;
/** Une présence plus ancienne que ce délai est « hors ligne » (le client envoie un battement toutes les 30 à 60 s). */
export const PRESENCE_TTL_MS = 90_000;
export const MAX_FRIENDS = 200;
export const MAX_OUTGOING_REQUESTS = 50;
/** Titres masqués par profil. */
export const MAX_HIDDEN_PER_PROFILE = 20_000;
export const HIDDEN_KEY = /^(movie|tv):\d{1,10}$/;
/** Anciens réglages de l'accueil : `homeHidden` (nombre de morceaux) puis `homeHidden0`… `homeHidden11`. */
const LEGACY_HIDDEN_CHUNKS = 12;

export type InviteState = 'free' | 'sent' | 'used';

export interface InviteView {
  id: string;
  code: string;
  state: InviteState;
  createdAt: string;
  sentAt: string | null;
  usedAt: string | null;
  /** Pseudo du filleul (null si le lien n'est pas utilisé ou si le compte a été supprimé). */
  invitee: string | null;
}

export type Visibility = 'private' | 'friends';

export interface WatchingNow {
  type: 'movie' | 'series';
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  season: number | null;
  episode: number | null;
}

export type FriendStatus = 'online' | 'watching' | 'offline';

export interface FriendView {
  username: string;
  avatarColor: string;
  status: FriendStatus;
  watching: WatchingNow | null;
  since: string;
}

export interface FriendRequestView {
  username: string;
  avatarColor: string;
  requestedAt: string;
}

export interface FriendsOverview {
  friends: FriendView[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
}

export type FriendRequestResult = 'sent' | 'accepted' | 'already_friends' | 'already_pending' | 'not_found' | 'self' | 'limit_reached';

export interface SharedLibraryItem {
  type: 'movie' | 'series';
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  poster: string | null;
  addedAt: string;
}

export interface HiddenEntry {
  key: string;
  title: string;
  poster: string;
  addedAt: number;
}

export interface PartyRoomRecord {
  id: string;
  hostId: string;
  hostUsername: string;
  visibility: 'private' | 'public';
  title: string;
  poster: string | null;
  language: string | null;
  mediaType: 'movie' | 'series';
  createdAt: string;
}

const AVATAR_SQL = `COALESCE((SELECT p.avatar_color FROM profiles p WHERE p.account_id = a.id AND p.is_kid = 0 ORDER BY p.created_at, p.id LIMIT 1), '#3b82f6')`;

/** Code d'invitation : 16 octets aléatoires (22 caractères base64url, 128 bits). */
export function generateInviteCode(): string {
  return randomBytes(16).toString('base64url');
}

/** Ordonne une paire de comptes (low < high), clé de la table friendships. */
function pair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

interface InviteRow {
  id: string;
  code: string;
  created_at: string;
  sent_at: string | null;
  used_by: string | null;
  used_at: string | null;
  invitee: string | null;
}

function toInvite(row: InviteRow): InviteView {
  return {
    id: row.id,
    code: row.code,
    state: row.used_at !== null ? 'used' : row.sent_at !== null ? 'sent' : 'free',
    createdAt: row.created_at,
    sentAt: row.sent_at,
    usedAt: row.used_at,
    invitee: row.invitee,
  };
}

export type RedeemResult = { ok: true; inviterId: string | null } | { ok: false };

/**
 * Consomme un lien dans la transaction d'inscription (appelée par UserStore.createAccount) : le lien doit exister et être
 * libre ; il est marqué utilisé par le nouveau compte, qui devient ami de son parrain (amitié acceptée d'emblée).
 */
export function redeemInvite(db: SqlDb, code: string, newAccountId: string, now: string): RedeemResult {
  const row = db.prepare('SELECT id, inviter_id, used_at FROM invites WHERE code = ?').get(code) as
    | { id: string; inviter_id: string | null; used_at: string | null }
    | undefined;
  if (row === undefined || row.used_at !== null) return { ok: false };
  // « used_at IS NULL » dans l'UPDATE : un seul inscrit gagne, même si deux requêtes arrivent ensemble.
  const changed = db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL').run(newAccountId, now, row.id);
  if (Number(changed.changes) !== 1) return { ok: false };
  if (row.inviter_id !== null) {
    const { low, high } = pair(row.inviter_id, newAccountId);
    db.prepare(
      `INSERT INTO friendships (low_id, high_id, requested_by, status, created_at, accepted_at) VALUES (?, ?, ?, 'accepted', ?, ?)
       ON CONFLICT(low_id, high_id) DO NOTHING`,
    ).run(low, high, row.inviter_id, now, now);
  }
  return { ok: true, inviterId: row.inviter_id };
}

function validHiddenEntry(raw: unknown): HiddenEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !HIDDEN_KEY.test(r.key)) return undefined;
  if (typeof r.title !== 'string') return undefined;
  const addedAt = typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? Math.trunc(r.addedAt) : Date.now();
  return { key: r.key, title: r.title.slice(0, 200), poster: typeof r.poster === 'string' ? r.poster.slice(0, 200) : '', addedAt };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class SocialStore {
  constructor(private readonly db: SqlDb) {}

  // Parrainage

  private accountIdOf(username: string): string | undefined {
    return (this.db.prepare('SELECT id FROM accounts WHERE username = ?').get(username) as { id: string } | undefined)?.id;
  }

  /**
   * Liens du compte (une ligne par emplacement). Les emplacements manquants sont créés à la volée jusqu'au quota ; si le
   * quota a baissé, les liens libres en trop sont supprimés (un lien utilisé reste toujours visible).
   */
  listInvites(accountId: string, now: string): { quota: number; invites: InviteView[] } {
    return this.db.transaction(() => {
      const quotaRow = this.db.prepare('SELECT invite_quota FROM accounts WHERE id = ?').get(accountId) as { invite_quota: number } | undefined;
      const quota = quotaRow === undefined ? 0 : Number(quotaRow.invite_quota);
      const select = () =>
        this.db
          .prepare(
            `SELECT i.id, i.code, i.created_at, i.sent_at, i.used_by, i.used_at, u.username AS invitee
             FROM invites i LEFT JOIN accounts u ON u.id = i.used_by
             WHERE i.inviter_id = ? ORDER BY i.rowid`,
          )
          .all(accountId) as unknown as InviteRow[];
      let rows = select();
      if (quotaRow !== undefined && rows.length !== quota) {
        if (rows.length < quota) {
          for (let n = rows.length; n < quota; n += 1) {
            this.db.prepare('INSERT INTO invites (id, code, inviter_id, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), generateInviteCode(), accountId, now);
          }
        } else {
          // Quota réduit : supprimer d'abord les liens libres (les derniers créés), sans toucher aux liens utilisés.
          const free = rows.filter((row) => row.used_at === null);
          const surplus = Math.min(rows.length - quota, free.length);
          for (const row of free.slice(free.length - surplus)) this.db.prepare('DELETE FROM invites WHERE id = ?').run(row.id);
        }
        rows = select();
      }
      return { quota, invites: rows.map(toInvite) };
    });
  }

  /** Marque un lien « envoyé » (ou le remet « libre ») : purement indicatif pour le tableau de bord. */
  setInviteSent(accountId: string, inviteId: string, sent: boolean, now: string): 'ok' | 'not_found' | 'used' {
    const row = this.db.prepare('SELECT used_at FROM invites WHERE id = ? AND inviter_id = ?').get(inviteId, accountId) as { used_at: string | null } | undefined;
    if (row === undefined) return 'not_found';
    if (row.used_at !== null) return 'used';
    this.db.prepare('UPDATE invites SET sent_at = ? WHERE id = ?').run(sent ? now : null, inviteId);
    return 'ok';
  }

  /** Révoque un lien non utilisé : l'ancien code cesse de fonctionner et l'emplacement reçoit un nouveau code libre. */
  revokeInvite(accountId: string, inviteId: string, now: string): { result: 'ok'; invite: InviteView } | { result: 'not_found' | 'used' } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT used_at FROM invites WHERE id = ? AND inviter_id = ?').get(inviteId, accountId) as { used_at: string | null } | undefined;
      if (row === undefined) return { result: 'not_found' as const };
      if (row.used_at !== null) return { result: 'used' as const };
      this.db.prepare('UPDATE invites SET code = ?, created_at = ?, sent_at = NULL WHERE id = ?').run(generateInviteCode(), now, inviteId);
      const fresh = this.db
        .prepare('SELECT i.id, i.code, i.created_at, i.sent_at, i.used_by, i.used_at, NULL AS invitee FROM invites i WHERE i.id = ?')
        .get(inviteId) as unknown as InviteRow;
      return { result: 'ok' as const, invite: toInvite(fresh) };
    });
  }

  /** Ajuste le quota d'un compte (propriétaire uniquement, vérifié par la route). */
  setInviteQuota(username: string, quota: number): { username: string; quota: number } | undefined {
    const changed = this.db.prepare('UPDATE accounts SET invite_quota = ? WHERE username = ?').run(quota, username);
    return Number(changed.changes) === 1 ? { username, quota } : undefined;
  }

  /** Vérifie un lien avant l'inscription : valide s'il existe et n'est pas utilisé. Ne révèle que le pseudo du parrain. */
  inviteInfo(code: string): { valid: boolean; inviter: string | null } {
    const row = this.db
      .prepare('SELECT i.used_at, a.username AS inviter FROM invites i LEFT JOIN accounts a ON a.id = i.inviter_id WHERE i.code = ?')
      .get(code) as { used_at: string | null; inviter: string | null } | undefined;
    if (row === undefined || row.used_at !== null) return { valid: false, inviter: null };
    return { valid: true, inviter: row.inviter };
  }

  /** Invitation « système » (administration) : sans parrain, donc sans amitié à l'inscription. */
  createSystemInvite(now: string): { id: string; code: string } {
    const invite = { id: randomUUID(), code: generateInviteCode() };
    this.db.prepare('INSERT INTO invites (id, code, inviter_id, created_at) VALUES (?, ?, NULL, ?)').run(invite.id, invite.code, now);
    return invite;
  }

  /** Supprime une invitation système (nettoyage des tests réels). */
  deleteSystemInvite(code: string): boolean {
    return Number(this.db.prepare('DELETE FROM invites WHERE code = ? AND inviter_id IS NULL').run(code).changes) === 1;
  }

  // Amis

  /**
   * Demande d'ami par pseudo exact. Si l'autre a déjà demandé, l'amitié est acceptée. Le pseudo inconnu et le pseudo de
   * soi-même ne donnent aucun détail de plus que `not_found` / `self`.
   */
  requestFriend(accountId: string, username: string, now: string): FriendRequestResult {
    return this.db.transaction((): FriendRequestResult => {
      const otherId = this.accountIdOf(username);
      if (otherId === undefined) return 'not_found';
      if (otherId === accountId) return 'self';
      const { low, high } = pair(accountId, otherId);
      const existing = this.db.prepare('SELECT status, requested_by FROM friendships WHERE low_id = ? AND high_id = ?').get(low, high) as
        | { status: 'pending' | 'accepted'; requested_by: string }
        | undefined;
      if (existing?.status === 'accepted') return 'already_friends';
      if (existing !== undefined) {
        if (existing.requested_by === accountId) return 'already_pending';
        if (this.countFriends(accountId) >= MAX_FRIENDS) return 'limit_reached';
        this.db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE low_id = ? AND high_id = ?").run(now, low, high);
        return 'accepted';
      }
      const outgoing = this.db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'pending' AND requested_by = ?").get(accountId);
      if (Number(outgoing?.n ?? 0) >= MAX_OUTGOING_REQUESTS || this.countFriends(accountId) >= MAX_FRIENDS) return 'limit_reached';
      this.db.prepare("INSERT INTO friendships (low_id, high_id, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(low, high, accountId, now);
      return 'sent';
    });
  }

  private countFriends(accountId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (low_id = ? OR high_id = ?)").get(accountId, accountId);
    return Number(row?.n ?? 0);
  }

  /** Accepte une demande reçue de `username`. */
  acceptFriend(accountId: string, username: string, now: string): 'ok' | 'not_found' | 'limit_reached' {
    return this.db.transaction((): 'ok' | 'not_found' | 'limit_reached' => {
      const otherId = this.accountIdOf(username);
      if (otherId === undefined) return 'not_found';
      const { low, high } = pair(accountId, otherId);
      const row = this.db.prepare("SELECT requested_by FROM friendships WHERE low_id = ? AND high_id = ? AND status = 'pending'").get(low, high) as
        | { requested_by: string }
        | undefined;
      if (row === undefined || row.requested_by === accountId) return 'not_found';
      if (this.countFriends(accountId) >= MAX_FRIENDS) return 'limit_reached';
      this.db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE low_id = ? AND high_id = ?").run(now, low, high);
      return 'ok';
    });
  }

  /** Refuse une demande reçue, ou annule une demande envoyée. */
  declineFriend(accountId: string, username: string): boolean {
    const otherId = this.accountIdOf(username);
    if (otherId === undefined) return false;
    const { low, high } = pair(accountId, otherId);
    return Number(this.db.prepare("DELETE FROM friendships WHERE low_id = ? AND high_id = ? AND status = 'pending'").run(low, high).changes) === 1;
  }

  /** Supprime une amitié acceptée. */
  removeFriend(accountId: string, username: string): boolean {
    const otherId = this.accountIdOf(username);
    if (otherId === undefined) return false;
    const { low, high } = pair(accountId, otherId);
    return Number(this.db.prepare("DELETE FROM friendships WHERE low_id = ? AND high_id = ? AND status = 'accepted'").run(low, high).changes) === 1;
  }

  areFriends(a: string, b: string): boolean {
    const { low, high } = pair(a, b);
    return this.db.prepare("SELECT 1 AS x FROM friendships WHERE low_id = ? AND high_id = ? AND status = 'accepted'").get(low, high) !== undefined;
  }

  /** Amis (avec statut de présence) et demandes en attente. `now` sert au calcul de l'état en ligne. */
  listFriends(accountId: string, now: string): FriendsOverview {
    const nowMs = Date.parse(now);
    const rows = this.db
      .prepare(
        `SELECT a.username, ${AVATAR_SQL} AS avatar, f.status, f.requested_by, f.created_at, f.accepted_at,
                pr.seen_at, pr.watching, pr.invisible
         FROM friendships f
         JOIN accounts a ON a.id = CASE WHEN f.low_id = ? THEN f.high_id ELSE f.low_id END
         LEFT JOIN presence pr ON pr.account_id = a.id
         WHERE f.low_id = ? OR f.high_id = ?
         ORDER BY a.username`,
      )
      .all(accountId, accountId, accountId) as unknown as {
      username: string;
      avatar: string;
      status: 'pending' | 'accepted';
      requested_by: string;
      created_at: string;
      accepted_at: string | null;
      seen_at: string | null;
      watching: string | null;
      invisible: number | null;
    }[];
    const out: FriendsOverview = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      if (row.status === 'pending') {
        const view = { username: row.username, avatarColor: row.avatar, requestedAt: row.created_at };
        (row.requested_by === accountId ? out.outgoing : out.incoming).push(view);
        continue;
      }
      const online = row.seen_at !== null && row.invisible !== 1 && nowMs - Date.parse(row.seen_at) <= PRESENCE_TTL_MS;
      const watching = online && row.watching !== null ? parseWatching(row.watching) : null;
      out.friends.push({
        username: row.username,
        avatarColor: row.avatar,
        status: watching !== null ? 'watching' : online ? 'online' : 'offline',
        watching,
        since: row.accepted_at ?? row.created_at,
      });
    }
    return out;
  }

  // Présence

  /** Battement de cœur léger : un seul UPSERT. `watching` null = en ligne sans titre en cours. */
  setPresence(accountId: string, profileId: string | null, watching: WatchingNow | null, invisible: boolean, now: string): void {
    this.db
      .prepare(
        `INSERT INTO presence (account_id, profile_id, seen_at, watching, invisible) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET profile_id = excluded.profile_id, seen_at = excluded.seen_at,
           watching = excluded.watching, invisible = excluded.invisible`,
      )
      .run(accountId, profileId, now, watching === null ? null : JSON.stringify(watching), invisible ? 1 : 0);
  }

  clearPresence(accountId: string): void {
    this.db.prepare('DELETE FROM presence WHERE account_id = ?').run(accountId);
  }

  // Bibliothèque partagée

  setLibraryVisibility(profileId: string, type: 'movie' | 'series', ref: string, visibility: Visibility): boolean {
    return (
      Number(
        this.db
          .prepare('UPDATE library_items SET visibility = ? WHERE profile_id = ? AND type = ? AND title_ref = ? AND removed = 0')
          .run(visibility, profileId, type, ref).changes,
      ) === 1
    );
  }

  /** Visibilité de toute la bibliothèque du profil (ou d'un type) : renvoie le nombre de titres modifiés. */
  setAllLibraryVisibility(profileId: string, type: 'movie' | 'series' | undefined, visibility: Visibility): number {
    const run =
      type === undefined
        ? this.db.prepare('UPDATE library_items SET visibility = ? WHERE profile_id = ? AND removed = 0').run(visibility, profileId)
        : this.db.prepare('UPDATE library_items SET visibility = ? WHERE profile_id = ? AND type = ? AND removed = 0').run(visibility, profileId, type);
    return Number(run.changes);
  }

  /**
   * Bibliothèque visible d'un ami : titres « amis » des profils non enfants, fusionnés (un titre présent dans plusieurs
   * profils n'apparaît qu'une fois). `undefined` si `username` n'est pas un ami.
   */
  friendLibrary(
    viewerId: string,
    username: string,
    type: 'movie' | 'series' | undefined,
    limit: number,
    offset: number,
  ): { items: SharedLibraryItem[]; total: number } | undefined {
    const friendId = this.accountIdOf(username);
    if (friendId === undefined || !this.areFriends(viewerId, friendId)) return undefined;
    const typeClause = type === undefined ? '' : 'AND li.type = ?';
    const base = (extra: string) =>
      `SELECT ${extra} FROM library_items li JOIN profiles p ON p.id = li.profile_id
       WHERE p.account_id = ? AND p.is_kid = 0 AND li.removed = 0 AND li.visibility = 'friends' ${typeClause}`;
    const params = type === undefined ? [friendId] : [friendId, type];
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM (${base('li.type, li.title_ref')} GROUP BY li.type, li.title_ref)`)
      .get(...params);
    const rows = this.db
      .prepare(
        `${base('li.type, MAX(li.tmdb_id) AS tmdb_id, MAX(li.imdb_id) AS imdb_id, MAX(li.title) AS title, MAX(li.poster) AS poster, MAX(li.added_at) AS added_at')}
         GROUP BY li.type, li.title_ref ORDER BY MAX(li.added_at) DESC, li.title_ref LIMIT ? OFFSET ?`,
      )
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
      items: rows.map((row) => ({ type: row.type, tmdbId: row.tmdb_id, imdbId: row.imdb_id, title: row.title, poster: row.poster, addedAt: row.added_at })),
    };
  }

  // Titres masqués

  /**
   * Import unique des anciens morceaux de réglages (`homeHidden`, `homeHidden0..11`) dans la table, au premier accès du
   * profil. Les entrées valides sont conservées (la plus ancienne date d'ajout gagne), les clés de réglages supprimées.
   * Renvoie le nombre d'entrées importées (0 si déjà fait).
   */
  ensureHiddenImported(profileId: string, now: string): number {
    return this.db.transaction(() => this.importLegacyHidden(profileId, now));
  }

  /** Corps de l'import, sans transaction propre (appelable depuis une transaction en cours : pas d'imbrication sous node:sqlite). */
  private importLegacyHidden(profileId: string, now: string): number {
    if (this.db.prepare('SELECT 1 AS x FROM hidden_import WHERE profile_id = ?').get(profileId) !== undefined) return 0;
    const keys = ['homeHidden', ...Array.from({ length: LEGACY_HIDDEN_CHUNKS }, (_, k) => `homeHidden${k}`)];
    const rows = this.db
      .prepare(`SELECT key, value FROM settings WHERE profile_id = ? AND key IN (${keys.map(() => '?').join(',')})`)
      .all(profileId, ...keys) as unknown as { key: string; value: string }[];
    let imported = 0;
    for (const row of rows) {
      if (row.key === 'homeHidden') continue; // nombre de morceaux, pas des entrées
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        const entry = validHiddenEntry(raw);
        if (entry === undefined || imported >= MAX_HIDDEN_PER_PROFILE) continue;
        const done = this.db
          .prepare('INSERT INTO hidden_titles (profile_id, key, title, poster, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, key) DO NOTHING')
          .run(profileId, entry.key, entry.title, entry.poster, entry.addedAt);
        imported += Number(done.changes);
      }
    }
    if (rows.length > 0) {
      this.db.prepare(`DELETE FROM settings WHERE profile_id = ? AND key IN (${keys.map(() => '?').join(',')})`).run(profileId, ...keys);
    }
    this.db.prepare('INSERT INTO hidden_import (profile_id, imported_at) VALUES (?, ?)').run(profileId, now);
    return imported;
  }

  /**
   * Titres masqués, du plus récent au plus ancien, par curseur (`added_at:key` du dernier élément reçu). `q` filtre par
   * titre (sous-chaîne, sans casse).
   */
  listHidden(
    profileId: string,
    options: { q?: string; limit: number; cursor?: string },
    now: string,
  ): { items: HiddenEntry[]; total: number; nextCursor: string | null } {
    this.ensureHiddenImported(profileId, now);
    const where = ['profile_id = ?'];
    const params: (string | number)[] = [profileId];
    if (options.q !== undefined && options.q !== '') {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(options.q)}%`);
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM hidden_titles WHERE ${where.join(' AND ')}`).get(...params);
    const page = [...where];
    const pageParams = [...params];
    const cursor = options.cursor === undefined ? undefined : parseCursor(options.cursor);
    if (cursor !== undefined) {
      page.push('(added_at < ? OR (added_at = ? AND key < ?))');
      pageParams.push(cursor.addedAt, cursor.addedAt, cursor.key);
    }
    const rows = this.db
      .prepare(`SELECT key, title, poster, added_at FROM hidden_titles WHERE ${page.join(' AND ')} ORDER BY added_at DESC, key DESC LIMIT ?`)
      .all(...pageParams, options.limit + 1) as unknown as { key: string; title: string; poster: string; added_at: number }[];
    const more = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map((row) => ({ key: row.key, title: row.title, poster: row.poster, addedAt: Number(row.added_at) }));
    const last = items[items.length - 1];
    return { items, total: Number(total?.n ?? 0), nextCursor: more && last !== undefined ? `${last.addedAt}:${last.key}` : null };
  }

  /** Masque des titres (créés ou mis à jour). Renvoie le nombre de titres masqués du profil, ou null (rien écrit) si le plafond serait dépassé. */
  hideTitles(profileId: string, entries: readonly HiddenEntry[], now: string): number | null {
    return this.db.transaction(() => {
      this.importLegacyHidden(profileId, now);
      const existing = Number(this.db.prepare('SELECT COUNT(*) AS n FROM hidden_titles WHERE profile_id = ?').get(profileId)?.n ?? 0);
      let added = 0;
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        if (this.db.prepare('SELECT 1 AS x FROM hidden_titles WHERE profile_id = ? AND key = ?').get(profileId, entry.key) === undefined) added += 1;
      }
      if (existing + added > MAX_HIDDEN_PER_PROFILE) return null;
      for (const entry of entries) {
        this.db
          .prepare(
            `INSERT INTO hidden_titles (profile_id, key, title, poster, added_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, key) DO UPDATE SET title = excluded.title, poster = excluded.poster`,
          )
          .run(profileId, entry.key, entry.title, entry.poster, entry.addedAt);
      }
      return existing + added;
    });
  }

  unhideTitles(profileId: string, keys: readonly string[], now: string): number {
    this.ensureHiddenImported(profileId, now);
    let removed = 0;
    for (const key of keys) {
      removed += Number(this.db.prepare('DELETE FROM hidden_titles WHERE profile_id = ? AND key = ?').run(profileId, key).changes);
    }
    return removed;
  }

  // Annuaire des salons (le temps réel vit dans le Durable Object PartyRoom)

  addPartyRoom(room: Omit<PartyRoomRecord, 'hostUsername'>): void {
    this.db
      .prepare('INSERT INTO party_rooms (id, host_id, visibility, title, poster, language, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(room.id, room.hostId, room.visibility, room.title, room.poster, room.language, room.mediaType, room.createdAt);
  }

  partyRoom(id: string): PartyRoomRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT r.id, r.host_id, a.username, r.visibility, r.title, r.poster, r.language, r.media_type, r.created_at
         FROM party_rooms r JOIN accounts a ON a.id = r.host_id WHERE r.id = ?`,
      )
      .get(id) as unknown as PartyRow | undefined;
    return row === undefined ? undefined : toRoom(row);
  }

  /** Salons d'un hôte (limite du nombre de salons ouverts). */
  partyRoomsOf(hostId: string): PartyRoomRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.host_id, a.username, r.visibility, r.title, r.poster, r.language, r.media_type, r.created_at
         FROM party_rooms r JOIN accounts a ON a.id = r.host_id WHERE r.host_id = ? ORDER BY r.created_at DESC`,
      )
      .all(hostId) as unknown as PartyRow[];
    return rows.map(toRoom);
  }

  /** Salons publics, du plus récent au plus ancien, par curseur (`created_at|id`). */
  listPublicRooms(options: { limit: number; cursor?: string; language?: string }): { rooms: PartyRoomRecord[]; nextCursor: string | null } {
    const where = ["r.visibility = 'public'"];
    const params: (string | number)[] = [];
    if (options.language !== undefined) {
      where.push('r.language = ?');
      params.push(options.language);
    }
    const sep = options.cursor?.indexOf('|') ?? -1;
    if (options.cursor !== undefined && sep > 0) {
      const createdAt = options.cursor.slice(0, sep);
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      params.push(createdAt, createdAt, options.cursor.slice(sep + 1));
    }
    const rows = this.db
      .prepare(
        `SELECT r.id, r.host_id, a.username, r.visibility, r.title, r.poster, r.language, r.media_type, r.created_at
         FROM party_rooms r JOIN accounts a ON a.id = r.host_id WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      )
      .all(...params, options.limit + 1) as unknown as PartyRow[];
    const rooms = rows.slice(0, options.limit).map(toRoom);
    const last = rooms[rooms.length - 1];
    return { rooms, nextCursor: rows.length > options.limit && last !== undefined ? `${last.createdAt}|${last.id}` : null };
  }

  deletePartyRoom(id: string): void {
    this.db.prepare('DELETE FROM party_rooms WHERE id = ?').run(id);
  }
}

interface PartyRow {
  id: string;
  host_id: string;
  username: string;
  visibility: 'private' | 'public';
  title: string;
  poster: string | null;
  language: string | null;
  media_type: 'movie' | 'series';
  created_at: string;
}

function toRoom(row: PartyRow): PartyRoomRecord {
  return {
    id: row.id,
    hostId: row.host_id,
    hostUsername: row.username,
    visibility: row.visibility,
    title: row.title,
    poster: row.poster,
    language: row.language,
    mediaType: row.media_type,
    createdAt: row.created_at,
  };
}

function parseCursor(raw: string): { addedAt: number; key: string } | undefined {
  const sep = raw.indexOf(':');
  if (sep <= 0) return undefined;
  const addedAt = Number(raw.slice(0, sep));
  return Number.isFinite(addedAt) ? { addedAt, key: raw.slice(sep + 1) } : undefined;
}

function parseWatching(raw: string): WatchingNow | null {
  try {
    const value = JSON.parse(raw) as Partial<WatchingNow>;
    if ((value.type !== 'movie' && value.type !== 'series') || typeof value.title !== 'string') return null;
    return {
      type: value.type,
      tmdbId: typeof value.tmdbId === 'number' ? value.tmdbId : null,
      imdbId: typeof value.imdbId === 'string' ? value.imdbId : null,
      title: value.title,
      season: typeof value.season === 'number' ? value.season : null,
      episode: typeof value.episode === 'number' ? value.episode : null,
    };
  } catch {
    return null;
  }
}
