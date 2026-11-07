import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { queryParams, sendJson } from '../http/respond.js';
import { type MetricsReport, type MetricsService, RANGES } from '../metrics/core.js';
import { buildProviderHealth } from '../metrics/health.js';
import type { PartyBackend } from '../party/backend.js';
import { runtimeEnv } from '../platform/index.js';
import type { AdminAccount, AuditEntry, OnlineAccount, PartyReportRecord, RegisteredRoom } from '../user/admin-store.js';
import type { AdminRepo } from '../user/repo.js';
import type { Session } from '../user/session.js';
import { parseWith, UserApiError } from '../user/validation.js';
import type { CacheAdmin, PurgeJob, TvCronState } from './cache-types.js';
import { providerEntries } from './ops-platform.js';
import { nextTvRun, tvOverdue } from './ops-stats.js';
import { metricsQuery } from './validation.js';

/**
 * Centre de contrôle (/admin/status, /admin/inbox, /admin/live, /admin/overview-series) : lectures d'exploitation pour le
 * propriétaire. Les calculs sont des fonctions pures (testées directement) ; les routes ne font que lire les sources. Un
 * sous-calcul qui échoue ne fait jamais échouer la route : son service vaut « unknown », son élément est omis.
 * Aucune donnée sensible : ni message de salon, ni détail d'audit, ni jeton, ni clé.
 */

type Health = 'ok' | 'degraded' | 'down' | 'unknown';
type Severity = 'info' | 'warn' | 'critical';

/** Seuils du centre de contrôle (à ajuster d'après l'usage réel). */
const API_5XX_DEGRADED = 0.01;
const API_5XX_DOWN = 0.1;
const API_P95_DEGRADED_MS = 2500;
const ACCOUNTS_LATENCY_DEGRADED_MS = 1000;
const KV_HIT_DEGRADED = 0.5;
const KV_HIT_DOWN = 0.2;
/** Erreurs 5xx sur la dernière heure : au-delà du premier seuil, un élément « pic 5xx » ; au-delà du second, critique. */
const ERRORS_5XX_HOUR_WARN = 20;
const ERRORS_5XX_HOUR_CRITICAL = 100;

/** Bornes de lecture : signalements, comptes à scruter, salons vérifiés (les plus récents), fil d'événements. */
const INBOX_LIMIT = 200;
const QUOTA_SCAN_LIMIT = 500;
const PARTY_CHECK_MAX = 50;
const PARTY_PARALLEL = 10;
const FEED_SIZE = 30;
/** Durée de vie (ms, par instance) de la lecture `info()` d'un salon pour /live : même principe que le cache de /storage. */
const PARTY_INFO_TTL_MS = 15_000;

const RANK: Record<Health, number> = { unknown: -1, ok: 0, degraded: 1, down: 2 };
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Pire état d'une liste, « unknown » ignoré ; « unknown » si rien n'est connu. */
function worst(statuses: readonly Health[]): Health {
  return statuses.reduce<Health>((acc, status) => (RANK[status] > RANK[acc] ? status : acc), 'unknown');
}

const percent = (rate: number): string => `${(rate * 100).toFixed(1).replace('.', ',')} %`;
const isoOf = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const timeOf = (at: string | null): number => (at === null ? 0 : Date.parse(at) || 0);

/** Lecture qui échoue : undefined (le sous-calcul est alors indisponible). */
async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

// Statut global et services

export interface ProviderState {
  id: string;
  label: string;
  status: Health;
  lastFailureAt: string | null;
}

export interface ServiceState {
  id: 'api' | 'accounts' | 'kv' | 'upstream' | 'cron';
  label: string;
  status: Health;
  value: string;
  detail?: string;
}

/** Lecture du cron TV : dernier passage (null : aucun) et retard calculé par tvOverdue. */
interface CronReading {
  state: TvCronState | null;
  overdue: boolean;
}

export interface StatusInput {
  now: number;
  /** Rapport de la dernière heure (API, caches). */
  report: MetricsReport | undefined;
  accounts: ServiceState;
  providers: readonly ProviderState[];
  cron: CronReading | undefined;
}

function apiService(report: MetricsReport | undefined): ServiceState {
  const base = { id: 'api' as const, label: 'API' };
  if (report === undefined) return { ...base, status: 'unknown', value: 'indisponible' };
  const { requests, status, p95 } = report.totals;
  if (requests === 0) return { ...base, status: 'unknown', value: 'aucune requête (1 h)' };
  const rate = status['5xx'] / requests;
  const errors: Health = rate >= API_5XX_DOWN ? 'down' : rate >= API_5XX_DEGRADED ? 'degraded' : 'ok';
  const latency: Health = p95 !== null && p95 > API_P95_DEGRADED_MS ? 'degraded' : 'ok';
  return { ...base, status: worst([errors, latency]), value: `p95 ${p95 === null ? 'indisponible' : `${p95} ms`} · 5xx ${percent(rate)} (1 h)` };
}

function kvService(report: MetricsReport | undefined): ServiceState {
  const base = { id: 'kv' as const, label: 'Caches (KV)' };
  if (report === undefined) return { ...base, status: 'unknown', value: 'indisponible' };
  const hits = report.caches.reduce((sum, cache) => sum + cache.hits, 0);
  const misses = report.caches.reduce((sum, cache) => sum + cache.misses, 0);
  if (hits + misses === 0) return { ...base, status: 'unknown', value: 'aucun accès (1 h)' };
  const rate = hits / (hits + misses);
  const status: Health = rate < KV_HIT_DOWN ? 'down' : rate < KV_HIT_DEGRADED ? 'degraded' : 'ok';
  return { ...base, status, value: `${percent(rate)} de succès (1 h)` };
}

function upstreamService(providers: readonly ProviderState[]): ServiceState {
  const base = { id: 'upstream' as const, label: 'Fournisseurs' };
  const known = providers.filter((provider) => provider.status !== 'unknown');
  if (known.length === 0) return { ...base, status: 'unknown', value: 'état inconnu' };
  const ok = known.filter((provider) => provider.status === 'ok').length;
  const failing = known.filter((provider) => provider.status !== 'ok');
  const status: Health = failing.length === 0 ? 'ok' : known.every((provider) => provider.status === 'down') ? 'down' : 'degraded';
  return {
    ...base,
    status,
    value: `${ok}/${providers.length} OK`,
    ...(failing.length === 0 ? {} : { detail: failing.map((provider) => provider.label).join(', ') }),
  };
}

function cronService(cron: CronReading | undefined, now: number): ServiceState {
  const base = { id: 'cron' as const, label: 'Cron TV' };
  if (cron === undefined) return { ...base, status: 'unknown', value: 'indisponible' };
  const next = `prochain passage ${nextTvRun(now)}`;
  const { state } = cron;
  if (state === null) return { ...base, status: 'degraded', value: 'aucun passage enregistré', detail: next };
  if (cron.overdue) return { ...base, status: 'degraded', value: `dernier passage ${state.startedAt} (en retard)`, detail: next };
  if (!state.ok || !state.epgOk) {
    return { ...base, status: 'degraded', value: `dernier passage ${state.startedAt}`, detail: state.error ?? 'catalogue ou programme non reconstruit' };
  }
  return { ...base, status: 'ok', value: `dernier passage ${state.startedAt}`, detail: next };
}

/** Service « comptes » : la base répond-elle, et en combien de temps (lecture des réglages). */
async function accountsService(admin: () => AdminRepo): Promise<ServiceState> {
  const base = { id: 'accounts' as const, label: 'Comptes' };
  const started = Date.now();
  try {
    await admin().getSettings();
    const ms = Date.now() - started;
    return { ...base, status: ms > ACCOUNTS_LATENCY_DEGRADED_MS ? 'degraded' : 'ok', value: `répond en ${ms} ms` };
  } catch {
    return { ...base, status: 'down', value: 'ne répond pas' };
  }
}

/** Statut global (pire service connu ; « ok » si aucun service n'est connu) et détail des services. */
export function statusOf(input: StatusInput): { status: 'ok' | 'degraded' | 'down'; services: ServiceState[] } {
  const services = [
    apiService(input.report),
    input.accounts,
    kvService(input.report),
    upstreamService(input.providers),
    cronService(input.cron, input.now),
  ];
  const top = worst(services.map((service) => service.status));
  return { status: top === 'unknown' ? 'ok' : top, services };
}

// Boîte de contrôle

export interface InboxItem {
  key: string;
  kind: 'report' | 'provider' | 'errors5xx' | 'quota' | 'cron' | 'purge';
  severity: Severity;
  title: string;
  detail: string;
  at: string | null;
  action: { label: string; route: string; call?: 'tv-rerun' };
}

export interface InboxInput {
  now: number;
  /** Signalements de salons en attente. */
  reports: readonly PartyReportRecord[];
  providers: readonly ProviderState[];
  /** Points de la dernière heure (une tranche de 5 minutes par point). */
  series: readonly { t: string; errors5xx: number }[];
  /** Comptes candidats au quota épuisé (le filtre exact est appliqué ici). */
  quotaAccounts: readonly AdminAccount[];
  cron: CronReading | undefined;
  purges: readonly PurgeJob[];
  /** Clés écartées : leurs éléments ne figurent pas dans la boîte. */
  dismissed: readonly string[];
}

const reportItems = (reports: readonly PartyReportRecord[]): InboxItem[] =>
  reports.map((report) => ({
    key: `report:${report.id}`,
    kind: 'report',
    severity: 'warn',
    title: 'Signalement de message',
    detail: `Signalé par ${report.by} contre ${report.against}`,
    at: isoOf(report.at),
    action: { label: 'Modérer', route: '#/admin/moderation' },
  }));

const providerItems = (providers: readonly ProviderState[]): InboxItem[] =>
  providers
    .filter((provider) => provider.status === 'degraded' || provider.status === 'down')
    .map((provider) => ({
      key: `provider:${provider.id}`,
      kind: 'provider',
      severity: provider.status === 'down' ? 'critical' : 'warn',
      title: `${provider.label} ${provider.status === 'down' ? 'en panne' : 'dégradé'}`,
      detail: provider.lastFailureAt === null ? 'Aucun échec enregistré' : `Dernier échec : ${provider.lastFailureAt}`,
      at: provider.lastFailureAt,
      action: { label: 'Voir les sources', route: '#/admin/sources' },
    }));

/** Pic 5xx de l'heure en cours : clé par heure (« 5xx:<yyyy-mm-ddThh> »), donc un nouveau pic redevient visible. */
function errorItems(series: InboxInput['series'], now: number): InboxItem[] {
  const total = series.reduce((sum, point) => sum + point.errors5xx, 0);
  if (total < ERRORS_5XX_HOUR_WARN || series.length === 0) return [];
  const peak = series.reduce((best, point) => (point.errors5xx > best.errors5xx ? point : best));
  const hour = new Date(now).toISOString().slice(0, 13);
  return [
    {
      key: `5xx:${hour}`,
      kind: 'errors5xx',
      severity: total >= ERRORS_5XX_HOUR_CRITICAL ? 'critical' : 'warn',
      title: 'Pic d’erreurs 5xx',
      detail: `${total} erreurs 5xx sur la dernière heure`,
      at: peak.t,
      action: { label: 'Voir les métriques', route: '#/admin/metrics' },
    },
  ];
}

/** Quota épuisé : un quota positif entièrement consommé (les comptes sans quota ne sont pas signalés). */
const quotaItems = (accounts: readonly AdminAccount[]): InboxItem[] =>
  accounts
    .filter((account) => account.inviteQuota > 0 && account.invitesUsed >= account.inviteQuota)
    .map((account) => ({
      key: `quota:${account.id}`,
      kind: 'quota',
      severity: 'info',
      title: 'Quota d’invitations épuisé',
      detail: `${account.username} : ${account.invitesUsed} sur ${account.inviteQuota} utilisées`,
      at: account.lastActivityAt,
      action: { label: 'Voir le compte', route: `#/admin/accounts/${account.id}` },
    }));

function cronItems(cron: CronReading | undefined): InboxItem[] {
  if (cron === undefined || !cron.overdue) return [];
  return [
    {
      key: 'cron:tv',
      kind: 'cron',
      severity: 'warn',
      title: 'Cron TV en retard',
      detail: cron.state === null ? 'Aucun passage enregistré' : `Dernier passage : ${cron.state.startedAt}`,
      at: cron.state?.startedAt ?? null,
      action: { label: 'Relancer la TV', route: '#/admin/tasks', call: 'tv-rerun' },
    },
  ];
}

const purgeItems = (purges: readonly PurgeJob[]): InboxItem[] =>
  purges
    .filter((job) => job.status === 'failed')
    .map((job) => ({
      key: `purge:${job.id}`,
      kind: 'purge',
      severity: 'warn',
      title: `Purge du cache ${job.prefix} échouée`,
      detail: job.error ?? 'Erreur inconnue',
      at: job.updatedAt,
      action: { label: 'Voir les tâches', route: '#/admin/tasks' },
    }));

/** Éléments de la boîte : agrégés, écartés retirés, triés par sévérité puis par date (récent d'abord). */
export function inboxOf(input: InboxInput): { items: InboxItem[]; total: number } {
  const hidden = new Set(input.dismissed);
  const items = [
    ...reportItems(input.reports),
    ...providerItems(input.providers),
    ...errorItems(input.series, input.now),
    ...quotaItems(input.quotaAccounts),
    ...cronItems(input.cron),
    ...purgeItems(input.purges),
  ]
    .filter((item) => !hidden.has(item.key))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || timeOf(b.at) - timeOf(a.at));
  return { items, total: items.length };
}

// Activité en direct

export interface FeedEvent {
  at: string;
  kind: 'audit' | 'signup' | 'party';
  label: string;
  target?: string;
}

/** Libellés français des actions journalisées ; une action inconnue garde son code. */
const AUDIT_LABELS = new Map<string, string>([
  ['account.bulk', 'Action groupée sur des comptes'],
  ['account.delete', 'Compte supprimé'],
  ['account.export', 'Export des comptes'],
  ['account.invite_quota', 'Quota d’invitations modifié'],
  ['account.reactivate', 'Compte réactivé'],
  ['account.reset_link', 'Lien de réinitialisation créé'],
  ['account.revoke_sessions', 'Sessions révoquées'],
  ['account.session.revoke', 'Session révoquée'],
  ['account.suspend', 'Compte suspendu'],
  ['admin.profile', 'Profil administrateur changé'],
  ['announcement.create', 'Annonce créée'],
  ['announcement.delete', 'Annonce supprimée'],
  ['announcement.update', 'Annonce modifiée'],
  ['cache.purge', 'Purge de cache lancée'],
  ['elevate', 'Ré-authentification'],
  ['elevate.failed', 'Ré-authentification échouée'],
  ['inbox.dismiss', 'Élément de la boîte écarté'],
  ['invite.revoke', 'Invitation révoquée'],
  ['party.close_room', 'Salon fermé'],
  ['provider.test', 'Test de fournisseur'],
  ['report.delete_message', 'Message supprimé (signalement)'],
  ['report.ignore', 'Signalement ignoré'],
  ['report.suspend_author', 'Auteur suspendu (signalement)'],
  ['settings.update', 'Réglages modifiés'],
  ['tv.rerun', 'Relance de la TV'],
]);

/** Fil des 30 derniers événements (journal d'audit, inscriptions, salons créés), récent d'abord. Aucun détail d'audit. */
export function feedOf(
  audit: readonly AuditEntry[],
  signups: readonly Pick<AdminAccount, 'username' | 'createdAt'>[],
  rooms: readonly RegisteredRoom[],
): FeedEvent[] {
  const events: FeedEvent[] = [
    ...audit.map((entry): FeedEvent => ({ at: entry.at, kind: 'audit', label: AUDIT_LABELS.get(entry.action) ?? entry.action, ...(entry.target === null ? {} : { target: entry.target }) })),
    ...signups.map((account): FeedEvent => ({ at: account.createdAt, kind: 'signup', label: 'Nouvelle inscription', target: account.username })),
    ...rooms.map((room): FeedEvent => ({ at: room.createdAt, kind: 'party', label: 'Salon créé', target: room.host })),
  ];
  return events.sort((a, b) => timeOf(b.at) - timeOf(a.at)).slice(0, FEED_SIZE);
}

/** Lecture `info()` d'un salon mise en cache (horodatage et résultat), propre à une instance. */
type PartyInfoCache = Map<string, { at: number; alive: boolean }>;

/**
 * Salons vivants parmi ceux de l'annuaire (un salon dont la lecture échoue n'est pas compté). Le résultat de `info()` est
 * gardé PARTY_INFO_TTL_MS par salon : une lecture répétée de /live n'interroge pas à nouveau chaque salon.
 */
async function liveParties(party: PartyBackend | undefined, rooms: readonly RegisteredRoom[], cache: PartyInfoCache, now: number): Promise<number> {
  if (party === undefined) return 0;
  for (const [id, entry] of cache) if (now - entry.at >= PARTY_INFO_TTL_MS) cache.delete(id);
  const alive = async (room: RegisteredRoom): Promise<boolean> => {
    const hit = cache.get(room.id);
    if (hit !== undefined) return hit.alive;
    let flag: boolean;
    try {
      flag = (await party.room(room.id).info()) !== null;
    } catch {
      flag = false;
    }
    cache.set(room.id, { at: now, alive: flag });
    return flag;
  };
  let live = 0;
  for (let start = 0; start < rooms.length; start += PARTY_PARALLEL) {
    const flags = await Promise.all(rooms.slice(start, start + PARTY_PARALLEL).map(alive));
    live += flags.filter(Boolean).length;
  }
  return live;
}

// Courbes et deltas

export interface OverviewPoint {
  t: string;
  requests: number;
  errors5xx: number;
  p95: number | null;
}

export interface OverviewDeltas {
  requests: number | null;
  errors5xx: number | null;
  p95: number | null;
}

/** Variation en % (une décimale) par rapport à la base ; null sans base (absente ou nulle). */
export function deltaPercent(current: number | null | undefined, base: number | null | undefined): number | null {
  if (current === null || current === undefined || base === null || base === undefined || base === 0) return null;
  return Math.round(((current - base) / base) * 1000) / 10;
}

/** Points de la période et variations par rapport à la période précédente (même durée, juste avant). */
export function overviewOf(current: MetricsReport | undefined, previous: MetricsReport | undefined): { points: OverviewPoint[]; deltas: OverviewDeltas } {
  return {
    points: (current?.series ?? []).map((point) => ({ t: point.t, requests: point.requests, errors5xx: point.errors5xx, p95: point.p95 })),
    deltas: {
      requests: deltaPercent(current?.totals.requests, previous?.totals.requests),
      errors5xx: deltaPercent(current?.totals.status['5xx'], previous?.totals.status['5xx']),
      p95: deltaPercent(current?.totals.p95, previous?.totals.p95),
    },
  };
}

// Routes

/** Dépendances fournies par api.ts : gardes d'accès (propriétaire), dépôt, métriques, caches et salons. */
export interface ControlRouteContext {
  deps: AppDeps;
  owner(c: Ctx): Promise<Session>;
  admin(): AdminRepo;
  metrics(): MetricsService | undefined;
  caches(): CacheAdmin | undefined;
  party: PartyBackend | undefined;
}

/** Fournisseurs avec leur santé mesurée sur les appels sortants : même construction que GET /admin/providers. */
async function providersOf(metrics: () => MetricsService | undefined, now: number): Promise<ProviderState[]> {
  const rows = await attempt(async () => metrics()?.providerHours?.());
  return providerEntries(runtimeEnv(), buildProviderHealth(rows ?? [], now));
}

/** Lecture du cron TV, ou undefined si l'API TV est absente ou en échec. */
async function cronReading(deps: AppDeps, now: number): Promise<CronReading | undefined> {
  const tv = deps.tvAdmin;
  if (tv === undefined) return undefined;
  const state = await attempt(() => tv.lastCron());
  return state === undefined ? undefined : { state, overdue: tvOverdue(state, now) };
}

/** Routes du centre de contrôle, réservées au propriétaire (gardes de api.ts). */
export function registerControlRoutes(router: App, ctx: ControlRouteContext): void {
  const { deps, owner, admin, metrics, caches, party } = ctx;
  /** Lectures `info()` des salons pour /live, gardées PARTY_INFO_TTL_MS par instance. */
  const partyInfo: PartyInfoCache = new Map();

  /** État des services (API, comptes, caches, fournisseurs, cron TV) et statut global. */
  router.get('/status', async (c) => {
    await owner(c);
    const now = Date.now();
    const [report, accounts, cron, providers] = await Promise.all([
      attempt(async () => metrics()?.report('1h')),
      accountsService(admin),
      cronReading(deps, now),
      providersOf(metrics, now),
    ]);
    return sendJson(c, statusOf({ now, report, accounts, providers, cron }));
  });

  /** Éléments à traiter : signalements, fournisseurs, pic 5xx, quotas épuisés, cron TV en retard, purges échouées. */
  router.get('/inbox', async (c) => {
    await owner(c);
    const now = Date.now();
    const [reports, report, quota, cron, purges, dismissed, providers] = await Promise.all([
      attempt(() => admin().listReports('open', INBOX_LIMIT)),
      attempt(async () => metrics()?.report('1h')),
      attempt(() => admin().listAccounts({ filter: 'noInvites', order: 'newest', limit: QUOTA_SCAN_LIMIT }, { withCounts: false })),
      cronReading(deps, now),
      attempt(async () => caches()?.purgeJobs()),
      attempt(() => admin().listDismissedKeys()),
      providersOf(metrics, now),
    ]);
    return sendJson(
      c,
      inboxOf({
        now,
        reports: reports ?? [],
        providers,
        series: report?.series ?? [],
        quotaAccounts: quota?.accounts ?? [],
        cron,
        purges: purges ?? [],
        dismissed: dismissed ?? [],
      }),
    );
  });

  /** Présence, lectures en cours, salons vivants et fil des 30 derniers événements. Aucune donnée sensible. */
  router.get('/live', async (c) => {
    await owner(c);
    const [online, audit, rooms, signups] = await Promise.all([
      attempt(() => admin().onlineAccounts()),
      attempt(() => admin().listAudit({ limit: FEED_SIZE })),
      attempt(() => admin().listRegisteredRooms(PARTY_CHECK_MAX)),
      attempt(() => admin().recentAccounts(FEED_SIZE)),
    ]);
    const present: OnlineAccount[] = online ?? [];
    const roomList = rooms ?? [];
    return sendJson(c, {
      online: present.length,
      watching: present.filter((account) => account.watching !== null).length,
      parties: await liveParties(party, roomList, partyInfo, Date.now()),
      feed: feedOf(audit?.entries ?? [], signups ?? [], roomList),
    });
  });

  /** Courbes de la période (requêtes, 5xx, p95) et variations en % par rapport à la période précédente de même durée. */
  router.get('/overview-series', async (c) => {
    await owner(c);
    const service = metrics();
    if (service === undefined) throw new UserApiError(501, 'metrics_unavailable');
    const { range } = parseWith(metricsQuery, queryParams(c));
    const now = Date.now();
    const [current, previous] = await Promise.all([
      attempt(() => service.report(range, now)),
      attempt(() => service.report(range, now - RANGES[range].ms)),
    ]);
    return sendJson(c, overviewOf(current, previous));
  });
}
