import type { AccountList, GroupStats, Metrics, PurgeJob, ReferralNode } from './adminApi';

/* Fonctions pures de la console d'administration : accès, métriques, pagination, purge, parrainage, formats. */

export interface AccessInput { serverMode: boolean; owner: boolean; kid: boolean }
/** Garde d'accès à #/admin : session serveur, propriétaire, profil non enfant. */
export const adminAllowed = (a: AccessInput): boolean => a.serverMode && a.owner && !a.kid;

// ---- Formats ----
export const fmtInt = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('fr-FR'));
export const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace('.', ',') + ' s';
};
export const fmtPct = (r: number | null | undefined, digits = 1): string =>
  r == null || !Number.isFinite(r) ? '—' : (r * 100).toFixed(digits).replace('.', ',') + ' %';
export const fmtRate = (n: number): string => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('fr-FR');

/** Instant en millisecondes : nombre (secondes ou ms) ou date ISO. */
export function toMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; }
  return NaN;
}
export function fmtDateTime(v: unknown): string {
  const t = toMs(v);
  return Number.isFinite(t) ? new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
export function fmtDay(v: unknown): string {
  const t = toMs(v);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}
export function fmtAgo(v: unknown, now = Date.now()): string {
  const t = toMs(v);
  if (!Number.isFinite(t)) return 'jamais';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'à l’instant';
  if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
  if (s < 86_400) return 'il y a ' + Math.floor(s / 3600) + ' h';
  return 'il y a ' + Math.floor(s / 86_400) + ' j';
}

// ---- Métriques ----
export const GROUP_LABEL: Record<string, string> = {
  stream: 'Flux', play: 'Lecture', lt_tmdb: 'Catalogue TMDB', lt: 'Catalogue', user: 'Comptes', party: 'Watch parties', ui: 'Interface', other: 'Autres',
};
export const STATUS_KEYS = ['2xx', '3xx', '4xx', '5xx'] as const;
const emptyStats = (): GroupStats => ({ requests: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: 0, p95: 0, avgMs: 0 });

/** Somme de groupes : requêtes et statuts exacts ; p50/p95/moyenne pondérés par les requêtes (approximation, les histogrammes ne s'additionnent pas ici). */
export function aggregateGroups(groups: Array<Partial<GroupStats> | null | undefined>): GroupStats {
  const out = emptyStats();
  let w50 = 0; let w95 = 0; let wAvg = 0;
  for (const g of groups) {
    if (!g) continue;
    const n = g.requests ?? 0;
    out.requests += n;
    for (const k of STATUS_KEYS) out.status[k] += g.status?.[k] ?? 0;
    w50 += (g.p50 ?? 0) * n; w95 += (g.p95 ?? 0) * n; wAvg += (g.avgMs ?? 0) * n;
  }
  if (out.requests > 0) { out.p50 = w50 / out.requests; out.p95 = w95 / out.requests; out.avgMs = wAvg / out.requests; }
  return out;
}

export interface GroupRow extends GroupStats { id: string; label: string; share: number; errorRate: number }
/** Lignes par groupe de routes, triées par volume ; `share` = part des requêtes, `errorRate` = 5xx / requêtes. */
export function groupRows(m: Pick<Metrics, 'groups'> & Partial<Pick<Metrics, 'totals'>>): GroupRow[] {
  const entries = Object.entries(m.groups ?? {});
  const total = m.totals?.requests ?? entries.reduce((s, [, g]) => s + (g.requests ?? 0), 0);
  return entries
    .map(([id, g]) => ({ ...emptyStats(), ...g, status: { ...emptyStats().status, ...g.status }, id, label: GROUP_LABEL[id] ?? id, share: total > 0 ? (g.requests ?? 0) / total : 0, errorRate: g.requests > 0 ? (g.status?.['5xx'] ?? 0) / g.requests : 0 }))
    .sort((a, b) => b.requests - a.requests);
}

export interface Summary { requests: number; rpm: number; errorRate: number; p50: number; p95: number; minutes: number }
/** Chiffres clés : requêtes/min moyennes sur la période, taux d'erreur 5xx, p95. */
export function summarize(m: Pick<Metrics, 'totals' | 'groups' | 'from' | 'to' | 'range'>): Summary {
  const totals = m.totals && m.totals.requests != null ? m.totals : aggregateGroups(Object.values(m.groups ?? {}));
  const span = (toMs(m.to) - toMs(m.from)) / 60_000;
  const nominal = m.range === '1h' ? 60 : m.range === '7d' ? 10_080 : 1440;
  const minutes = Number.isFinite(span) && span > 0 ? span : nominal;
  return {
    requests: totals.requests,
    rpm: totals.requests / minutes,
    errorRate: totals.requests > 0 ? (totals.status?.['5xx'] ?? 0) / totals.requests : 0,
    p50: totals.p50 ?? 0,
    p95: totals.p95 ?? 0,
    minutes,
  };
}

/** Réduit une série à `max` points en gardant le maximum de chaque paquet (les pics restent visibles). */
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values.slice();
  const size = values.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.max(...values.slice(Math.floor(i * size), Math.max(Math.floor(i * size) + 1, Math.floor((i + 1) * size)))));
  return out;
}

export function upstreamRows(m: Pick<Metrics, 'upstreams'>) {
  return (m.upstreams ?? []).map((u) => ({ ...u, failureRate: u.calls > 0 ? u.failures / u.calls : 0, timeoutRate: u.calls > 0 ? u.timeouts / u.calls : 0 }))
    .sort((a, b) => b.failures - a.failures || b.calls - a.calls);
}

export const ALLDEBRID_LABEL: Record<string, string> = { unlock: 'Déblocage de lien', magnet: 'Magnets', other: 'Autres appels' };
export function alldebridRows(m: Pick<Metrics, 'alldebrid'>) {
  return Object.entries(m.alldebrid ?? {}).map(([id, v]) => {
    const errors = Object.entries(v.errors ?? {}).map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n);
    const errTotal = errors.reduce((s, e) => s + e.n, 0);
    const total = (v.ok ?? 0) + errTotal;
    return { id, label: ALLDEBRID_LABEL[id] ?? id, ok: v.ok ?? 0, errTotal, errors, successRate: total > 0 ? (v.ok ?? 0) / total : null };
  });
}

// ---- Pagination à curseur (comptes, journal) ----
/** Pile de curseurs : « Suivant » empile le curseur renvoyé par la page courante, « Précédent » dépile. */
export class CursorPager {
  private stack: Array<string | null> = [null];
  next = (c: string | null): boolean => {
    if (!c) return false;
    this.stack.push(c);
    return true;
  };
  prev = (): boolean => {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    return true;
  };
  reset = (): void => { this.stack = [null]; };
  get cursor(): string | null { return this.stack[this.stack.length - 1]; }
  get page(): number { return this.stack.length; }
  get hasPrev(): boolean { return this.stack.length > 1; }
}

// ---- Purge de cache ----
export interface PurgeView { state: 'running' | 'done' | 'failed'; pct: number | null; label: string }
/** Progression d'une purge : pourcentage si le nombre de clés est connu, sinon indéterminé (null). */
export function purgeView(job: Pick<PurgeJob, 'status' | 'deleted' | 'error'>, keys?: number): PurgeView {
  if (job.status === 'done') return { state: 'done', pct: 100, label: 'Terminé : ' + fmtInt(job.deleted) + ' clé(s) supprimée(s).' };
  if (job.status === 'failed') return { state: 'failed', pct: null, label: 'Échec' + (job.error ? ' : ' + job.error : '.') + ' (' + fmtInt(job.deleted) + ' supprimée(s))' };
  const pct = keys && keys > 0 ? Math.min(99, Math.round((job.deleted / keys) * 100)) : null;
  return { state: 'running', pct, label: 'Purge en cours : ' + fmtInt(job.deleted) + ' clé(s) supprimée(s)' + (pct !== null ? ' (' + pct + ' %)' : '') + '…' };
}
/** Les listes de purges peuvent arriver nues ou enveloppées. */
export function purgeList(raw: unknown): PurgeJob[] {
  if (Array.isArray(raw)) return raw as PurgeJob[];
  const o = raw as { purges?: PurgeJob[]; jobs?: PurgeJob[] } | null;
  return o?.purges ?? o?.jobs ?? [];
}

// ---- Parrainage ----
export const countDescendants = (n: ReferralNode): number => (n.children ?? []).reduce((s, c) => s + 1 + countDescendants(c), 0);
export function treeDepth(roots: ReferralNode[]): number {
  const d = (n: ReferralNode): number => 1 + Math.max(0, ...(n.children ?? []).map(d));
  return Math.max(0, ...roots.map(d));
}

// ---- Dates de filtre ----
export const daysAgoIso = (days: number, now = Date.now()): string => new Date(now - days * 86_400_000).toISOString();
export const isActiveWithin = (lastActivityAt: unknown, hours: number, now = Date.now()): boolean => {
  const t = toMs(lastActivityAt);
  return Number.isFinite(t) && now - t <= hours * 3_600_000;
};

// ---- Vue d'ensemble : balayage des comptes ----
/** Taille maximale d'une page de GET /admin/accounts (serveur : `limit` de 1 à 100, sinon 400 invalid_body). */
export const ACCOUNT_PAGE_LIMIT = 100;
/** Pages parcourues au plus pour la vue d'ensemble : 1 000 comptes les plus récents. */
export const ACCOUNT_SCAN_PAGES = 10;

export interface AccountScan { total: number; active24: number; suspended: number; scanned: number; truncated: boolean }

/** Parcourt les pages de comptes (les plus récents d'abord) : total, actifs sur 24 h, suspendus, nombre scanné. */
export async function scanAccounts(page: (cursor: string | null) => Promise<AccountList>, now = Date.now()): Promise<AccountScan> {
  let active = 0;
  let suspended = 0;
  let scanned = 0;
  let current = await page(null);
  for (let pages = 1; ; pages += 1) {
    for (const a of current.accounts) {
      scanned += 1;
      if (isActiveWithin(a.lastActivityAt, 24, now)) active += 1;
      if (a.status === 'suspended') suspended += 1;
    }
    if (!current.nextCursor || pages >= ACCOUNT_SCAN_PAGES) {
      return { total: current.total, active24: active, suspended, scanned, truncated: !!current.nextCursor };
    }
    current = await page(current.nextCursor);
  }
}
