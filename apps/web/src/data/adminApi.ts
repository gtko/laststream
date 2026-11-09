import { getSession } from './session';
import { call, UserApiError } from './userApi';

/* Client de l'API d'administration de lastAddon : {base}/admin/… (propriétaire seulement).
 * - Chaque appel envoie X-Profile-Id (profil actif : un profil enfant est refusé par le serveur).
 * - Les actions destructrices passent par `adminAction` : jeton d'élévation (10 min) gardé en MÉMOIRE seulement,
 *   jamais en stockage ; s'il manque ou a expiré, le mot de passe est demandé puis l'action est réessayée une fois. */

export type ElevationPrompt = (o: { error?: string }) => Promise<string | null>;

interface Elevation { token: string; expiresAt: number }
let elevation: Elevation | null = null;
let prompt: ElevationPrompt | null = null;
let pending: Promise<void> | null = null;

export const clearElevation = (): void => { elevation = null; };
export const hasElevation = (now = Date.now()): boolean => elevation !== null && elevation.expiresAt - 5000 > now;
/** Instant (ms) d'expiration de l'élévation en cours, ou null si elle manque ou va expirer (même marge que hasElevation). */
export const elevationExpiresAt = (now = Date.now()): number | null => (elevation && hasElevation(now) ? elevation.expiresAt : null);
export const setElevationPrompt = (p: ElevationPrompt | null): void => { prompt = p; };

export interface AdminOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
}

function qs(q?: AdminOptions['query']): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}

/** Appel brut : X-Profile-Id toujours, X-Admin-Elevation si un jeton valable est gardé. */
export function adminCall<T>(path: string, o: AdminOptions = {}, withElevation = false): Promise<T> {
  const headers: Record<string, string> = {};
  const s = getSession();
  if (s?.profileId) headers['x-profile-id'] = s.profileId;
  if (withElevation && hasElevation() && elevation) headers['x-admin-elevation'] = elevation.token;
  return call<T>(path + qs(o.query), { prefix: '/admin', method: o.method, body: o.body, profileId: s?.profileId ?? undefined, headers });
}

/** Demande le mot de passe (boucle tant qu'il est faux) puis obtient le jeton. Les appels simultanés se partagent la demande. */
export function obtainElevation(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    let error: string | undefined;
    for (;;) {
      const password = prompt ? await prompt({ error }) : null;
      if (!password) throw new UserApiError(0, 'cancelled');
      try {
        const r = await adminCall<{ token: string; expiresAt: string | number }>('/elevate', { method: 'POST', body: { password } });
        const at = typeof r.expiresAt === 'number' ? (r.expiresAt < 1e12 ? r.expiresAt * 1000 : r.expiresAt) : Date.parse(r.expiresAt);
        elevation = { token: r.token, expiresAt: Number.isFinite(at) ? at : Date.now() + 600_000 };
        return;
      } catch (err) {
        if (err instanceof UserApiError && err.code === 'invalid_password') { error = 'Mot de passe incorrect.'; continue; }
        throw err;
      }
    }
  })().finally(() => { pending = null; });
  return pending;
}

/** Élévation pour une série d'actions : le mot de passe est demandé une fois, avant le premier appel (sans rien demander si le jeton est valable). */
export async function ensureElevation(): Promise<void> {
  if (!hasElevation()) await obtainElevation();
}

const needsElevation = (err: unknown): boolean =>
  err instanceof UserApiError && err.status === 403 && (err.code === 'elevation_required' || err.code === 'elevation_expired');

/** Action destructrice [élév.] : envoie le jeton s'il existe ; sur elevation_required/expired, redemande le mot de passe puis réessaie une fois. */
export async function adminAction<T>(path: string, o: AdminOptions = {}): Promise<T> {
  try {
    return await adminCall<T>(path, o, true);
  } catch (err) {
    if (!needsElevation(err)) throw err;
    clearElevation();
    await obtainElevation();
    return adminCall<T>(path, o, true);
  }
}

// ---- Types ----
export interface AdminAccount {
  id: string; username: string; isOwner: boolean; createdAt: string; status: 'active' | 'suspended'; suspendedAt: string | null;
  referrer: string | null; lastActivityAt: string | null; profileCount: number; libraryCount: number; inviteQuota: number; invitesUsed: number;
  /** Présence < 2 min. `lastActivityAt` reste la dernière activité. */
  online: boolean; sessionCount: number;
}
/** Filtres de la liste des comptes. */
export type AccountFilter = 'all' | 'online' | 'inactive30' | 'suspended' | 'noInvites';
/** Totaux par filtre, indépendants de la pagination et du filtre courant. */
export type AccountCounts = Record<AccountFilter, number>;
export interface AccountList { accounts: AdminAccount[]; nextCursor: string | null; total: number; counts: AccountCounts }
export interface AccountQuery { q?: string; filter?: AccountFilter; status?: string; referrer?: string; createdFrom?: string; createdTo?: string; order?: 'newest' | 'oldest'; limit?: number; cursor?: string | null }
/** Session ouverte d'un compte : jamais de hash ni de jeton. */
export interface AdminSession { id: string; device: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }
/** Filleul : compte créé avec un lien d'invitation de ce compte. */
export interface AdminInvitee { id: string; username: string; usedAt: string | null }
export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';
/** Lien d'invitation (jamais le code ni le jeton). */
export interface AdminInvite {
  id: string; ownerId: string; ownerUsername: string; createdAt: string; expiresAt: string | null;
  usedAt: string | null; usedBy: string | null; status: InviteStatus;
}
export interface AccountDetail {
  account: AdminAccount;
  profiles: Array<{ id?: string; name: string; isKid?: boolean; kid?: boolean; hasPin?: boolean; pin?: boolean; libraryCount?: number; library?: number }>;
  libraryCount: number;
  invitees: AdminInvitee[];
  sessions: AdminSession[];
  invites: AdminInvite[];
}
export type BulkAction = 'quota' | 'revoke-sessions' | 'suspend';
/** Action groupée sur au plus 100 comptes [élév.]. `quota` prend `quota` ou `delta`. */
export interface BulkBody { ids: string[]; action: BulkAction; quota?: number; delta?: number }
/** `skipped` : comptes ignorés sans échec (le propriétaire ne peut être ni suspendu ni modifié en lot). */
export interface BulkResult { done: number; failed: Array<{ id: string; error: string }>; skipped?: Array<{ id: string; reason: 'owner' }> }
export interface AccountExport { accounts: AdminAccount[]; truncated: boolean }
export type TimelineKind = 'audit' | 'signup' | 'invite' | 'session' | 'party';
export interface TimelineEvent { at: string; kind: TimelineKind; label: string; detail?: string }
export interface OnlineAccount { id: string; username: string; lastSeenAt: string; watching: { title: string; mediaType?: string } | null }
export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown';
export interface ServiceEntry { id: 'api' | 'accounts' | 'kv' | 'upstream' | 'cron'; label: string; status: ServiceStatus; value: string; detail?: string }
export interface StatusReport { status: 'ok' | 'degraded' | 'down'; services: ServiceEntry[] }
export type InboxKind = 'report' | 'provider' | 'errors5xx' | 'quota' | 'cron' | 'purge';
export interface InboxItem {
  key: string; kind: InboxKind; severity: 'info' | 'warn' | 'critical'; title: string; detail: string; at: string | null;
  action: { label: string; route: string; call?: 'tv-rerun' };
}
export interface Inbox { items: InboxItem[]; total: number }
export interface LiveFeedEntry { at: string; kind: 'audit' | 'signup' | 'party'; label: string; target?: string }
export interface LiveSnapshot { online: number; watching: number; parties: number; feed: LiveFeedEntry[] }
export interface OverviewPoint { t: string; requests: number; errors5xx: number; p95: number }
/** Variations en % contre la période précédente ; null si indisponibles. */
export interface OverviewSeries { points: OverviewPoint[]; deltas: { requests: number | null; errors5xx: number | null; p95: number | null } }
export interface ProviderStatus {
  id: string; label: string; successRate: number | null; p95: number | null; spark: Array<number | null>;
  lastFailureAt: string | null; status: ServiceStatus; testable: boolean;
}
export interface ProviderTestResult { id: string; ok: boolean; status: number | null; latencyMs: number; error?: string }
export interface StorageReport {
  kv: { prefixes: Array<{ prefix: string; keys: number; exact: boolean; hitRate: number | null }> };
  r2: Array<{ bucket: 'TV' | 'META' | 'AVATARS'; objects: number | null; bytes: number | null; truncated: boolean }>;
  do: { sizeBytes: number | null; tables: Array<{ name: string; rows: number | null }> };
  cachedAt: string;
}
export interface TasksReport {
  tv: { lastCron: unknown; nextRunAt: string | null; overdue: boolean };
  purges: Array<PurgeJob & { progress: number | null }>;
}
export type AnnouncementLevel = 'info' | 'warning';
export interface Announcement {
  id: string; title: string; message: string; level: AnnouncementLevel; startsAt: string | null; endsAt: string | null;
  active: boolean; createdAt: string; updatedAt: string;
}
/** Corps d'une création ou d'un patch : `active` (activer / désactiver) est accepté par le serveur sur les deux. */
export interface AnnouncementInput { title: string; message: string; level: AnnouncementLevel; startsAt?: string | null; endsAt?: string | null; active?: boolean }
export interface ReferralNode { id: string; username: string; createdAt: string; status: string; children: ReferralNode[] }
export interface Settings { inviteDefaultQuota: number; invitesOpen: boolean; maintenance: { enabled: boolean; message: string } }
export type Range = '1h' | '24h' | '7d';
export interface GroupStats { requests: number; status: { '2xx': number; '3xx': number; '4xx': number; '5xx': number }; p50: number; p95: number; avgMs: number }
/** Compteurs d'un fournisseur (serveur : metrics/providers.ts). `hitRate` : lectures servies sans appel sortant / lectures. */
export interface ProviderCounts {
  calls: number; l1Hits: number; l2Hits: number; stale: number; coalesced: number; r2Hits: number; r2Misses: number; notModified: number;
  hitRate: number | null; r2HitRate: number | null;
}
export interface ProviderEntry extends ProviderCounts { provider: string }
export interface ProviderDayEntry { day: string; providers: ProviderEntry[] }
/** Rapport fournisseurs (fenêtre de 30 jours UTC, indépendante de `range`). */
export interface ProviderReport { windowDays: number; from: string; to: string; byDay: ProviderDayEntry[]; totals: ProviderEntry[] }
export interface Metrics {
  range: Range; from: number | string; to: number | string; stepSec: number;
  totals: GroupStats; groups: Record<string, GroupStats>;
  series: Array<{ t: number | string; requests: number; errors5xx: number; p95: number }>;
  upstreams: Array<{ host: string; calls: number; failures: number; timeouts: number; avgMs: number }>;
  alldebrid: Record<string, { ok: number; errors: Record<string, number> }>;
  caches: Array<{ prefix: string; hits: number; misses: number; hitRate: number }>;
  /** Absent sur les serveurs qui ne publient pas encore ces compteurs. */
  providers?: ProviderReport;
  errors: Array<{ at: number | string; route: string; status: number; message: string }>;
}
export interface CacheRow { prefix: string; keys: number; exact: boolean; hits: number; misses: number; hitRate: number }
export interface PurgeJob { id: string; prefix: string; status: 'running' | 'done' | 'failed'; deleted: number; startedAt?: string; updatedAt?: string; error?: string | null }
export interface PartyRoomRow { id: string; host: string; visibility: string; title: string; mediaType?: string; createdAt?: string; participants: number; maxParticipants?: number }
export interface Report { id: string; roomId: string; messageId: string; by: string; against: string; text: string; reason?: string; at: number | string; status: string }
export interface AuditEntry { id: string; at: number | string; actor: string; actorId?: string; action: string; target?: string; detail?: unknown }

const E = encodeURIComponent;
const call2 = <T>(path: string, o: AdminOptions, elevated: boolean): Promise<T> => (elevated ? adminAction<T>(path, o) : adminCall<T>(path, o));
export const adminMe = () => adminCall<{ account: { id: string; username: string }; elevationTtlSec: number }>('/me');
export const listAccounts = (q: AccountQuery = {}) => adminCall<AccountList>('/accounts', { query: { ...q } as AdminOptions['query'] });
export const getAccount = (id: string) => adminCall<AccountDetail>('/accounts/' + E(id));
export const getReferrals = () => adminCall<{ roots: ReferralNode[]; total: number; truncated: boolean }>('/referrals');
export const setInviteQuota = (id: string, quota: number) => adminCall<unknown>('/accounts/' + E(id) + '/invite-quota', { method: 'PUT', body: { quota } });
export const suspendAccount = (id: string) => adminAction<unknown>('/accounts/' + E(id) + '/suspend', { method: 'POST' });
export const reactivateAccount = (id: string) => adminCall<unknown>('/accounts/' + E(id) + '/reactivate', { method: 'POST' });
export const revokeSessions = (id: string) => adminAction<void>('/accounts/' + E(id) + '/revoke-sessions', { method: 'POST' });
export const deleteAccount = (id: string) => adminAction<void>('/accounts/' + E(id), { method: 'DELETE' });
export const resetLink = (id: string) => adminAction<{ token: string; expiresAt: string; url: string }>('/accounts/' + E(id) + '/reset-link', { method: 'POST' });
export const getSettings = () => adminCall<Settings>('/settings');
/** Activer la maintenance exige l'élévation ; le reste s'enregistre sans. */
export const putSettings = (patch: Partial<Settings>) =>
  call2<Settings>('/settings', { method: 'PUT', body: patch }, !!patch.maintenance?.enabled);
export const getMetrics = (range: Range) => adminCall<Metrics>('/metrics', { query: { range } });
export const getCaches = (range: Range = '24h') => adminCall<{ caches: CacheRow[] }>('/caches', { query: { range } });
export const purgeCache = (prefix: string) => adminAction<PurgeJob>('/caches/' + E(prefix) + '/purge', { method: 'POST' });
export const getPurges = () => adminCall<unknown>('/caches/purges');
export const getPurge = (id: string) => adminCall<PurgeJob>('/caches/purges/' + E(id));
export const getTv = () => adminCall<{ lastCron: unknown }>('/tv');
export const rerunTv = () => adminCall<unknown>('/tv/rerun', { method: 'POST' });
export const listRooms = () => adminCall<{ rooms: PartyRoomRow[] }>('/party/rooms');
export const closeRoom = (id: string) => adminAction<void>('/party/rooms/' + E(id), { method: 'DELETE' });
export const listReports = (status = 'open') => adminCall<{ reports: Report[] }>('/party/reports', { query: { status } });
export const reportAction = (id: string, action: 'delete' | 'suspend' | 'ignore') =>
  call2<unknown>('/party/reports/' + E(id) + '/action', { method: 'POST', body: { action } }, action === 'suspend');
export const listAudit = (q: { limit?: number; before?: string | null; action?: string } = {}) =>
  adminCall<{ entries: AuditEntry[]; nextBefore: string | null }>('/audit', { query: { ...q } as AdminOptions['query'] });

// ---- Comptes (vue détaillée, actions groupées, export, présence) ----
export const revokeSession = (id: string, sid: string) => adminAction<void>('/accounts/' + E(id) + '/sessions/' + E(sid), { method: 'DELETE' });
export const bulkAccounts = (body: BulkBody) => adminAction<BulkResult>('/accounts/bulk', { method: 'POST', body });
export const exportAccounts = (q: { filter?: AccountFilter; q?: string } = {}) =>
  adminCall<AccountExport>('/accounts/export', { query: { ...q } as AdminOptions['query'] });
export const getTimeline = (id: string, limit?: number) =>
  adminCall<{ events: TimelineEvent[] }>('/accounts/' + E(id) + '/timeline', { query: { limit } });
export const listInvites = (q: { status?: InviteStatus; limit?: number } = {}) =>
  adminCall<{ invites: AdminInvite[] }>('/invites', { query: { ...q } as AdminOptions['query'] });
export const revokeInvite = (id: string) => adminAction<void>('/invites/' + E(id), { method: 'DELETE' });
export const listOnline = () => adminCall<{ accounts: OnlineAccount[] }>('/online');

// ---- Centre de contrôle ----
export const getStatus = () => adminCall<StatusReport>('/status');
export const getInbox = () => adminCall<Inbox>('/inbox');
export const dismissInbox = (key: string) => adminCall<{ ok: boolean }>('/inbox/' + E(key) + '/dismiss', { method: 'POST' });
export const getLive = () => adminCall<LiveSnapshot>('/live');
export const getOverviewSeries = (range: Range = '24h') => adminCall<OverviewSeries>('/overview-series', { query: { range } });

// ---- Sources, stockage, tâches ----
export const listProviders = () => adminCall<{ providers: ProviderStatus[] }>('/providers');
export const testProvider = (id: string) => adminAction<ProviderTestResult>('/providers/' + E(id) + '/test', { method: 'POST' });
export const getStorage = () => adminCall<StorageReport>('/storage');
export const getTasks = () => adminCall<TasksReport>('/tasks');

// ---- Clés des services (lecture libre, écritures sous élévation) ----
export type ServiceKeySource = 'db' | 'env' | 'none';
/** État masqué d'une clé serveur : jamais la valeur, sauf `value` pour le modèle OpenRouter (non secret). */
export interface ServiceKeyState { set: boolean; last4?: string; value?: string; source: ServiceKeySource }
export type ServiceKeys = Record<string, ServiceKeyState>;
export const getServiceKeys = () => adminCall<{ services: ServiceKeys }>('/services');
/** Valeur : enregistrée ; null : effacée de la base (la variable d'exécution reprend le relais). */
export const putServiceKeys = (patch: Record<string, string | null>) => adminAction<{ services: ServiceKeys }>('/services', { method: 'PUT', body: patch });
/** Reprend les clés de la configuration du compte propriétaire. */
export const importServiceKeys = () => adminAction<{ services: ServiceKeys; imported: string[] }>('/services/import', { method: 'POST' });

// ---- Annonces (écritures auditées, sans élévation) ----
export const listAnnouncements = () => adminCall<{ announcements: Announcement[] }>('/announcements');
export const createAnnouncement = (body: AnnouncementInput) => adminAction<Announcement>('/announcements', { method: 'POST', body });
export const updateAnnouncement = (id: string, patch: Partial<AnnouncementInput>) =>
  adminAction<Announcement>('/announcements/' + E(id), { method: 'PUT', body: patch });
export const deleteAnnouncement = (id: string) => adminAction<void>('/announcements/' + E(id), { method: 'DELETE' });
