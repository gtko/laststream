import { type AppSettings, readAppSettings, writeAppSettings } from './app-settings.js';
import { hashSessionToken } from './crypto.js';
import type { SqlDb, SqlParam, SqlRow } from './sql.js';

/**
 * Données de l'administration : comptes (vue d'ensemble, parrainage, suspension), réglages globaux, journal d'audit,
 * liens de réinitialisation, file des signalements. Même base et mêmes migrations que UserStore. Chaque vue est une
 * liste explicite de champs : ni hash de mot de passe ou de PIN, ni jeton, ni configuration chiffrée n'en sort.
 */

export const MAX_AUDIT_ROWS = 10_000;
const MAX_TREE_ACCOUNTS = 5_000;
const MAX_REPORT_ROWS = 2_000;
export const RESET_TTL_MS = 24 * 3600_000;
/** Un compte est « en ligne » si sa dernière présence date de moins de deux minutes. */
export const ONLINE_WINDOW_MS = 2 * 60_000;

export type AccountStatus = 'active' | 'suspended';

export interface AdminAccount {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
  status: AccountStatus;
  suspendedAt: string | null;
  /** Pseudo du parrain (null : premier compte ou lien « système »). */
  referrer: string | null;
  /** Dernière trace d'activité (présence, connexion, progression), ou null. */
  lastActivityAt: string | null;
  /** Présence (battement de cœur) de moins de deux minutes. */
  online: boolean;
  /** Sessions ouvertes et non expirées. */
  sessionCount: number;
  profileCount: number;
  libraryCount: number;
  inviteQuota: number;
  invitesUsed: number;
}

/** Session ouverte d'un compte. Ni empreinte ni jeton : `id` est un identifiant public dérivé (voir `sessionRef`). */
export interface AdminSession {
  id: string;
  /** User-agent enregistré à la connexion : aucun n'est stocké aujourd'hui, donc toujours null. */
  device: string | null;
  createdAt: string;
  /** Pas de suivi par session : la dernière activité connue est celle de la connexion. */
  lastSeenAt: string;
  expiresAt: string;
}

export interface AccountListQuery {
  /** Fragment du pseudo (insensible à la casse). */
  q?: string;
  status?: AccountStatus;
  /** Pseudo exact du parrain. */
  referrer?: string;
  createdFrom?: string;
  createdTo?: string;
  order: 'newest' | 'oldest';
  limit: number;
  cursor?: string;
}

export interface AdminAccountDetail {
  account: AdminAccount;
  profiles: { id: string; name: string; isKid: boolean; hasPin: boolean; createdAt: string; libraryCount: number }[];
  libraryCount: number;
  invitees: { id: string; username: string; usedAt: string | null }[];
  sessions: AdminSession[];
}

export interface ReferralNode {
  id: string;
  username: string;
  createdAt: string;
  status: AccountStatus;
  children: ReferralNode[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  actorId: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

export type ReportStatus = 'open' | 'deleted' | 'suspended' | 'ignored';

export interface PartyReportRecord {
  id: number;
  roomId: string;
  messageId: string;
  by: string;
  againstId: string | null;
  against: string;
  text: string;
  reason: string | null;
  at: number;
  status: ReportStatus;
  resolvedAt: string | null;
}

export type NewPartyReport = Omit<PartyReportRecord, 'id' | 'status' | 'resolvedAt'>;

export interface RegisteredRoom {
  id: string;
  hostId: string;
  host: string;
  visibility: 'private' | 'public';
  title: string;
  mediaType: 'movie' | 'series';
  createdAt: string;
}

const LIKE_ESCAPE = /[\\%_]/g;

/** Colonnes d'un compte. Premier paramètre lié : l'instant courant (ISO), pour ne compter que les sessions non expirées. */
const ACCOUNT_COLUMNS = `
  a.id, a.username, a.is_owner, a.created_at, a.suspended_at, a.invite_quota,
  (SELECT ia.username FROM invites i JOIN accounts ia ON ia.id = i.inviter_id WHERE i.used_by = a.id LIMIT 1) AS referrer,
  (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS profile_count,
  (SELECT COUNT(*) FROM library_items l JOIN profiles p ON p.id = l.profile_id WHERE p.account_id = a.id AND l.removed = 0) AS library_count,
  (SELECT COUNT(*) FROM invites i WHERE i.inviter_id = a.id AND i.used_at IS NOT NULL) AS invites_used,
  (SELECT seen_at FROM presence WHERE account_id = a.id) AS seen_at,
  (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS session_count,
  MAX(
    COALESCE((SELECT seen_at FROM presence WHERE account_id = a.id), ''),
    COALESCE((SELECT MAX(created_at) FROM sessions WHERE account_id = a.id), ''),
    COALESCE((SELECT MAX(pr.updated_at) FROM progress pr JOIN profiles p ON p.id = pr.profile_id WHERE p.account_id = a.id), '')
  ) AS last_activity`;

/** Identifiant public d'une session, dérivé de son empreinte stockée : il ne révèle ni l'empreinte ni le jeton. */
export function sessionRef(tokenHash: string): string {
  return hashSessionToken(tokenHash).slice(0, 24);
}

/** Empreinte stockée de la session désignée par son identifiant public, parmi celles du compte (hors prototype : pas exposée au RPC). */
function sessionHashOf(db: SqlDb, accountId: string, sessionId: string): string | undefined {
  const rows = db.prepare('SELECT token_hash FROM sessions WHERE account_id = ?').all(accountId);
  const row = rows.find((candidate) => sessionRef(String(candidate.token_hash)) === sessionId);
  return row === undefined ? undefined : String(row.token_hash);
}

function toAdminAccount(row: SqlRow, nowMs: number): AdminAccount {
  const suspendedAt = row.suspended_at === null || row.suspended_at === undefined ? null : String(row.suspended_at);
  const activity = String(row.last_activity ?? '');
  const seen = row.seen_at === null || row.seen_at === undefined ? null : String(row.seen_at);
  return {
    id: String(row.id),
    username: String(row.username),
    isOwner: Number(row.is_owner) === 1,
    createdAt: String(row.created_at),
    status: suspendedAt === null ? 'active' : 'suspended',
    suspendedAt,
    referrer: row.referrer === null || row.referrer === undefined ? null : String(row.referrer),
    lastActivityAt: activity === '' ? null : activity,
    online: seen !== null && nowMs - Date.parse(seen) < ONLINE_WINDOW_MS,
    sessionCount: Number(row.session_count),
    profileCount: Number(row.profile_count),
    libraryCount: Number(row.library_count),
    inviteQuota: Number(row.invite_quota),
    invitesUsed: Number(row.invites_used),
  };
}

function toReport(row: SqlRow): PartyReportRecord {
  return {
    id: Number(row.id),
    roomId: String(row.room_id),
    messageId: String(row.message_id),
    by: String(row.by_name),
    againstId: row.against_id === null || row.against_id === undefined ? null : String(row.against_id),
    against: String(row.against_name),
    text: String(row.text),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    at: Number(row.at),
    status: String(row.status) as ReportStatus,
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : String(row.resolved_at),
  };
}

/** Niveau d'une annonce : information ou alerte. */
export type AnnouncementLevel = 'info' | 'warning';

/** Annonce publiée par le propriétaire (bandeau). Dates ISO 8601 UTC ; null = sans borne. */
export interface Announcement {
  id: string;
  title: string;
  message: string;
  level: AnnouncementLevel;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const ANNOUNCEMENT_COLUMNS = 'id, title, message, level, starts_at, ends_at, active, created_at, updated_at';

function toAnnouncement(row: SqlRow): Announcement {
  return {
    id: String(row.id),
    title: String(row.title),
    message: String(row.message),
    level: String(row.level) as AnnouncementLevel,
    startsAt: row.starts_at === null || row.starts_at === undefined ? null : String(row.starts_at),
    endsAt: row.ends_at === null || row.ends_at === undefined ? null : String(row.ends_at),
    active: Number(row.active) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class AdminStore {
  constructor(private readonly db: SqlDb) {}

  // Comptes

  listAccounts(query: AccountListQuery): { accounts: AdminAccount[]; nextCursor: string | null; total: number } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (query.q !== undefined && query.q !== '') {
      where.push("a.username LIKE ? ESCAPE '\\'");
      params.push(`%${query.q.toLowerCase().replace(LIKE_ESCAPE, '\\$&')}%`);
    }
    if (query.status === 'suspended') where.push('a.suspended_at IS NOT NULL');
    if (query.status === 'active') where.push('a.suspended_at IS NULL');
    if (query.referrer !== undefined) {
      where.push('EXISTS (SELECT 1 FROM invites i JOIN accounts ia ON ia.id = i.inviter_id WHERE i.used_by = a.id AND ia.username = ?)');
      params.push(query.referrer);
    }
    if (query.createdFrom !== undefined) {
      where.push('a.created_at >= ?');
      params.push(query.createdFrom);
    }
    if (query.createdTo !== undefined) {
      where.push('a.created_at <= ?');
      params.push(query.createdTo);
    }
    const filter = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM accounts a${filter}`).get(...params)?.n ?? 0);
    const newest = query.order === 'newest';
    const paged = [...where];
    const pagedParams = [...params];
    if (query.cursor !== undefined) {
      const sep = query.cursor.indexOf('|');
      if (sep > 0) {
        paged.push(newest ? '(a.created_at, a.id) < (?, ?)' : '(a.created_at, a.id) > (?, ?)');
        pagedParams.push(query.cursor.slice(0, sep), query.cursor.slice(sep + 1));
      }
    }
    const pagedFilter = paged.length === 0 ? '' : ` WHERE ${paged.join(' AND ')}`;
    const nowMs = Date.now();
    const rows = this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts a${pagedFilter} ORDER BY a.created_at ${newest ? 'DESC' : 'ASC'}, a.id ${newest ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(new Date(nowMs).toISOString(), ...pagedParams, query.limit + 1);
    const accounts = rows.slice(0, query.limit).map((row) => toAdminAccount(row, nowMs));
    const last = accounts[accounts.length - 1];
    return { accounts, nextCursor: rows.length > query.limit && last !== undefined ? `${last.createdAt}|${last.id}` : null, total };
  }

  accountById(id: string): AdminAccount | undefined {
    const nowMs = Date.now();
    const row = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ?`).get(new Date(nowMs).toISOString(), id);
    return row === undefined ? undefined : toAdminAccount(row, nowMs);
  }

  accountDetail(id: string): AdminAccountDetail | undefined {
    const account = this.accountById(id);
    if (account === undefined) return undefined;
    const profiles = this.db
      .prepare(
        `SELECT p.id, p.name, p.is_kid, p.pin_hash IS NOT NULL AS has_pin, p.created_at,
                (SELECT COUNT(*) FROM library_items l WHERE l.profile_id = p.id AND l.removed = 0) AS library_count
         FROM profiles p WHERE p.account_id = ? ORDER BY p.created_at, p.id`,
      )
      .all(id)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        isKid: Number(row.is_kid) === 1,
        hasPin: Number(row.has_pin) === 1,
        createdAt: String(row.created_at),
        libraryCount: Number(row.library_count),
      }));
    const invitees = this.db
      .prepare('SELECT a.id, a.username, i.used_at FROM invites i JOIN accounts a ON a.id = i.used_by WHERE i.inviter_id = ? ORDER BY i.used_at')
      .all(id)
      .map((row) => ({ id: String(row.id), username: String(row.username), usedAt: row.used_at === null ? null : String(row.used_at) }));
    const sessions = this.db
      .prepare('SELECT token_hash, created_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(id, new Date().toISOString())
      .map((row): AdminSession => ({
        id: sessionRef(String(row.token_hash)),
        device: null,
        createdAt: String(row.created_at),
        lastSeenAt: String(row.created_at),
        expiresAt: String(row.expires_at),
      }));
    return { account, profiles, libraryCount: account.libraryCount, invitees, sessions };
  }

  /** Vrai si la session (identifiant public) appartient au compte, expirée ou non. */
  hasSession(accountId: string, sessionId: string): boolean {
    return sessionHashOf(this.db, accountId, sessionId) !== undefined;
  }

  /** Révoque une session du compte. `false` si elle ne lui appartient pas. */
  revokeSession(accountId: string, sessionId: string): boolean {
    const tokenHash = sessionHashOf(this.db, accountId, sessionId);
    if (tokenHash === undefined) return false;
    this.db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash = ?').run(accountId, tokenHash);
    return true;
  }

  /** Forêt de parrainage : racines = comptes sans parrain (premier compte, liens « système »). */
  referralTree(): { roots: ReferralNode[]; total: number; truncated: boolean } {
    const accounts = this.db
      .prepare('SELECT id, username, created_at, suspended_at FROM accounts ORDER BY created_at, id LIMIT ?')
      .all(MAX_TREE_ACCOUNTS + 1);
    const truncated = accounts.length > MAX_TREE_ACCOUNTS;
    const nodes = new Map<string, ReferralNode>();
    for (const row of accounts.slice(0, MAX_TREE_ACCOUNTS)) {
      nodes.set(String(row.id), {
        id: String(row.id),
        username: String(row.username),
        createdAt: String(row.created_at),
        status: row.suspended_at === null ? 'active' : 'suspended',
        children: [],
      });
    }
    const hasParent = new Set<string>();
    const links = this.db.prepare('SELECT inviter_id, used_by FROM invites WHERE used_by IS NOT NULL AND inviter_id IS NOT NULL ORDER BY used_at').all();
    for (const link of links) {
      const parent = nodes.get(String(link.inviter_id));
      const child = nodes.get(String(link.used_by));
      if (parent === undefined || child === undefined || hasParent.has(child.id) || parent.id === child.id) continue;
      parent.children.push(child);
      hasParent.add(child.id);
    }
    return { roots: [...nodes.values()].filter((node) => !hasParent.has(node.id)), total: nodes.size, truncated };
  }

  setInviteQuota(id: string, quota: number): boolean {
    return this.db.prepare('UPDATE accounts SET invite_quota = ? WHERE id = ?').run(quota, id).changes !== 0;
  }

  /** Suspend ou réactive un compte ; la suspension révoque ses sessions. `false` si le compte n'existe pas. */
  setSuspended(id: string, suspended: boolean, now: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE accounts SET suspended_at = ? WHERE id = ?').run(suspended ? now : null, id).changes !== 0;
      if (changed && suspended) this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
      return changed;
    });
  }

  // Réglages globaux

  getSettings(): AppSettings {
    return readAppSettings(this.db);
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    return writeAppSettings(this.db, patch);
  }

  /**
   * Profil administrateur : le seul profil du compte propriétaire qui accède à l'administration. Valeur enregistrée
   * (clé admin_profile_id), sinon (migration) le plus ancien profil du propriétaire, enregistré à la première lecture.
   * Null s'il n'existe aucun profil propriétaire.
   */
  adminProfileId(): string | null {
    const owner = this.db.prepare('SELECT id FROM accounts WHERE is_owner = 1 LIMIT 1').get() as SqlRow | undefined;
    if (owner === undefined) return null;
    const stored = this.db.prepare("SELECT value FROM app_settings WHERE key = 'admin_profile_id'").get() as SqlRow | undefined;
    if (stored !== undefined) {
      try {
        const id = JSON.parse(String(stored.value)) as unknown;
        if (typeof id === 'string' && this.db.prepare('SELECT 1 AS ok FROM profiles WHERE id = ? AND account_id = ?').get(id, String(owner.id)) !== undefined) return id;
      } catch {
        // Valeur illisible : repli sur le plus ancien profil.
      }
    }
    const oldest = this.db.prepare('SELECT id FROM profiles WHERE account_id = ? ORDER BY created_at, id LIMIT 1').get(String(owner.id)) as SqlRow | undefined;
    if (oldest === undefined) return null;
    this.setAdminProfileId(String(oldest.id));
    return String(oldest.id);
  }

  /**
   * Profil principal d'un compte : seul à gérer la configuration (sources, extensions, clés). Compte propriétaire : le
   * profil administrateur ; autre compte : son plus ancien profil. Null s'il n'a aucun profil.
   */
  mainProfileId(accountId: string): string | null {
    const owner = this.db.prepare('SELECT is_owner FROM accounts WHERE id = ?').get(accountId) as SqlRow | undefined;
    if (owner === undefined) return null;
    if (Number(owner.is_owner) === 1) return this.adminProfileId();
    const oldest = this.db.prepare('SELECT id FROM profiles WHERE account_id = ? ORDER BY created_at, id LIMIT 1').get(accountId) as SqlRow | undefined;
    return oldest === undefined ? null : String(oldest.id);
  }

  /** Désigne le profil administrateur (doit appartenir au propriétaire). `false` sinon. */
  setAdminProfileId(profileId: string): boolean {
    const ok = this.db.prepare('SELECT 1 AS ok FROM profiles p JOIN accounts a ON a.id = p.account_id WHERE p.id = ? AND a.is_owner = 1').get(profileId);
    if (ok === undefined) return false;
    this.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('admin_profile_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(profileId));
    return true;
  }

  // Journal d'audit

  addAudit(entry: { at: string; actorId: string | null; actor: string; action: string; target: string | null; detail: Record<string, unknown> | null }): void {
    this.db
      .prepare('INSERT INTO admin_audit (at, actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.actorId, entry.actor, entry.action, entry.target, entry.detail === null ? null : JSON.stringify(entry.detail));
    this.db.prepare('DELETE FROM admin_audit WHERE id <= (SELECT MAX(id) FROM admin_audit) - ?').run(MAX_AUDIT_ROWS);
  }

  /** Entrées récentes d'abord ; `before` : identifiant de la dernière entrée vue. */
  listAudit(options: { limit: number; before?: number; action?: string }): { entries: AuditEntry[]; nextBefore: number | null } {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (options.before !== undefined) {
      where.push('id < ?');
      params.push(options.before);
    }
    if (options.action !== undefined) {
      where.push('action = ?');
      params.push(options.action);
    }
    const rows = this.db
      .prepare(`SELECT id, at, actor_id, actor_name, action, target, detail FROM admin_audit${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY id DESC LIMIT ?`)
      .all(...params, options.limit + 1);
    const entries = rows.slice(0, options.limit).map((row): AuditEntry => {
      let detail: Record<string, unknown> | null = null;
      if (typeof row.detail === 'string') {
        try {
          detail = JSON.parse(row.detail) as Record<string, unknown>;
        } catch {
          detail = null;
        }
      }
      return {
        id: Number(row.id),
        at: String(row.at),
        actor: String(row.actor_name),
        actorId: row.actor_id === null ? null : String(row.actor_id),
        action: String(row.action),
        target: row.target === null ? null : String(row.target),
        detail,
      };
    });
    const last = entries[entries.length - 1];
    return { entries, nextBefore: rows.length > options.limit && last !== undefined ? last.id : null };
  }

  // Réinitialisation de mot de passe

  /** Enregistre l'empreinte d'un jeton (un seul lien valide par compte : les précédents sont supprimés). */
  createPasswordReset(accountId: string, tokenHash: string, now: string, expiresAt: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM password_resets WHERE account_id = ?').run(accountId);
      this.db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(now);
      this.db.prepare('INSERT INTO password_resets (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, accountId, now, expiresAt);
    });
  }

  /**
   * Consomme un lien (usage unique, non expiré) : nouveau mot de passe et révocation de toutes les sessions, dans la même
   * transaction. Renvoie le pseudo du compte, ou undefined si le lien est invalide, expiré ou déjà utilisé.
   */
  redeemPasswordReset(tokenHash: string, now: string, passwordHash: string): { accountId: string; username: string } | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT r.account_id, a.username FROM password_resets r JOIN accounts a ON a.id = r.account_id
           WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`,
        )
        .get(tokenHash, now);
      if (row === undefined) return undefined;
      const claimed = this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now, tokenHash);
      if (claimed.changes === 0) return undefined;
      const accountId = String(row.account_id);
      this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, accountId);
      this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
      return { accountId, username: String(row.username) };
    });
  }

  // Signalements de salons

  addReport(report: NewPartyReport): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO party_reports (room_id, message_id, by_name, against_id, against_name, text, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(report.roomId, report.messageId, report.by, report.againstId, report.against, report.text.slice(0, 1000), report.reason?.slice(0, 200) ?? null, report.at);
    this.db.prepare('DELETE FROM party_reports WHERE id <= (SELECT MAX(id) FROM party_reports) - ?').run(MAX_REPORT_ROWS);
  }

  listReports(status: ReportStatus, limit: number): PartyReportRecord[] {
    return this.db.prepare('SELECT * FROM party_reports WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit).map(toReport);
  }

  reportById(id: number): PartyReportRecord | undefined {
    const row = this.db.prepare('SELECT * FROM party_reports WHERE id = ?').get(id);
    return row === undefined ? undefined : toReport(row);
  }

  resolveReport(id: number, status: Exclude<ReportStatus, 'open'>, now: string): boolean {
    return this.db.prepare("UPDATE party_reports SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(status, now, id).changes !== 0;
  }

  // Annuaire des salons (tous, privés compris)

  listRegisteredRooms(limit: number): RegisteredRoom[] {
    return this.db
      .prepare(
        `SELECT r.id, r.host_id, a.username AS host, r.visibility, r.title, r.media_type, r.created_at
         FROM party_rooms r JOIN accounts a ON a.id = r.host_id ORDER BY r.created_at DESC, r.id LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: String(row.id),
        hostId: String(row.host_id),
        host: String(row.host),
        visibility: String(row.visibility) as 'private' | 'public',
        title: String(row.title),
        mediaType: String(row.media_type) as 'movie' | 'series',
        createdAt: String(row.created_at),
      }));
  }

  deleteRegisteredRoom(id: string): void {
    this.db.prepare('DELETE FROM party_rooms WHERE id = ?').run(id);
  }

  /** Salons dont l'hôte est ce compte (à fermer avant la suppression du compte). */
  roomIdsOfHost(hostId: string): string[] {
    return this.db.prepare('SELECT id FROM party_rooms WHERE host_id = ?').all(hostId).map((row) => String(row.id));
  }

  // Annonces (bandeau d'information)

  listAnnouncements(): Announcement[] {
    return this.db.prepare(`SELECT ${ANNOUNCEMENT_COLUMNS} FROM announcements ORDER BY created_at DESC, id DESC`).all().map(toAnnouncement);
  }

  announcementById(id: string): Announcement | undefined {
    const row = this.db.prepare(`SELECT ${ANNOUNCEMENT_COLUMNS} FROM announcements WHERE id = ?`).get(id);
    return row === undefined ? undefined : toAnnouncement(row);
  }

  /** Annonces actives dont la fenêtre contient `now` (bornes incluses ; une borne NULL n'est pas testée). */
  listActiveAnnouncements(now: string): Announcement[] {
    return this.db
      .prepare(
        `SELECT ${ANNOUNCEMENT_COLUMNS} FROM announcements
         WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY created_at DESC, id DESC`,
      )
      .all(now, now)
      .map(toAnnouncement);
  }

  createAnnouncement(record: Announcement): void {
    this.db
      .prepare(`INSERT INTO announcements (${ANNOUNCEMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.title, record.message, record.level, record.startsAt, record.endsAt, record.active ? 1 : 0, record.createdAt, record.updatedAt);
  }

  /** Réécrit les champs modifiables d'une annonce (identifiant et date de création inchangés). `false` si elle n'existe pas. */
  updateAnnouncement(record: Announcement): boolean {
    return this.db
      .prepare('UPDATE announcements SET title = ?, message = ?, level = ?, starts_at = ?, ends_at = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(record.title, record.message, record.level, record.startsAt, record.endsAt, record.active ? 1 : 0, record.updatedAt, record.id).changes !== 0;
  }

  deleteAnnouncement(id: string): boolean {
    return this.db.prepare('DELETE FROM announcements WHERE id = ?').run(id).changes !== 0;
  }

  // Boîte de contrôle : éléments écartés

  /** Écarte un élément de la boîte (idempotent : la première date d'écartement est conservée). */
  dismissInbox(key: string, now: string): void {
    this.db.prepare('INSERT INTO inbox_dismissed (key, dismissed_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(key, now);
  }

  listDismissedKeys(): string[] {
    return this.db.prepare('SELECT key FROM inbox_dismissed').all().map((row) => String(row.key));
  }
}
