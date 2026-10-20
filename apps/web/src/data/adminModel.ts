import type {
  AccountList, AdminAccount, GroupStats, Inbox, InboxItem, LiveFeedEntry, Metrics, PurgeJob, Range, ReferralNode, ServiceStatus, StatusReport,
} from './adminApi';

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

// ---- Export CSV des comptes ----
const CSV_HEADERS = [
  'Identifiant', 'Pseudo', 'Statut', 'Créé le', 'Dernière activité', 'Suspendu le', 'Parrain',
  'Profils', 'Bibliothèque', 'Quota d’invitations', 'Invitations utilisées', 'Sessions', 'En ligne',
];

/** Neutralise une cellule qu'un tableur lirait comme une formule (=, +, -, @, tabulation, retour chariot) en la préfixant d'une apostrophe. */
export function neutralizeFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? '\'' + v : v;
}

/** Cellule CSV : neutralisée puis entre guillemets si elle contient une virgule, un guillemet ou un saut de ligne (les guillemets sont doublés). */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = neutralizeFormula(String(v));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV (RFC 4180, fins de ligne CRLF) des comptes fournis, dans leur ordre. */
export function csvOfAccounts(accounts: readonly AdminAccount[]): string {
  const rows = accounts.map((a) => [
    a.id, a.username, a.status, a.createdAt, a.lastActivityAt, a.suspendedAt, a.referrer,
    a.profileCount, a.libraryCount, a.inviteQuota, a.invitesUsed, a.sessionCount, a.online ? 'oui' : 'non',
  ]);
  return [CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(',') + '\r\n').join('');
}

// ---- Compte à rebours (élévation) ----
/** « mm:ss » à partir de millisecondes, tronqué à la seconde ; 0, négatif ou non fini donne 00:00. Les minutes peuvent dépasser 59. */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

// ---- Centre de contrôle : libellés d'état ----
const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = { ok: 'Opérationnel', degraded: 'Dégradé', down: 'En panne', unknown: 'Inconnu' };
/** Libellé français d'un état de service ; une valeur inconnue donne « Inconnu ». */
export function serviceStatusLabel(status: string | null | undefined): string {
  return typeof status === 'string' && Object.hasOwn(SERVICE_STATUS_LABEL, status) ? SERVICE_STATUS_LABEL[status as ServiceStatus] : 'Inconnu';
}

// ---- Centre de contrôle : santé des services, variations, « En direct », « À traiter » ----
/** Ton visuel : opérationnel, dégradé, en panne, inconnu (classes CSS is-ok, is-warn, is-bad, is-neutral). */
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export const serviceTone = (status: string | null | undefined): Tone =>
  status === 'ok' ? 'ok' : status === 'degraded' ? 'warn' : status === 'down' ? 'bad' : 'neutral';

/** Services de la santé, dans l'ordre de la maquette (identifiants du rapport serveur). */
export const HEALTH_IDS = ['api', 'accounts', 'kv', 'upstream', 'cron'] as const;
const HEALTH_NAME: Record<(typeof HEALTH_IDS)[number], string> = {
  api: 'API Worker', accounts: 'Base comptes', kv: 'Cache KV', upstream: 'Addons amont', cron: 'Cron TV',
};

export interface HealthTile { id: string; name: string; value: string; sub: string; statusLabel: string; tone: Tone }

/**
 * Une tuile par service, dans l'ordre fixe ; un service absent du rapport donne une tuile « Inconnu » (valeur « — »).
 * `sub` : le détail donné par le serveur, ou chaîne vide (la ligne est alors masquée). Le statut n'est jamais répété en bas.
 */
export function healthTiles(report: StatusReport | null | undefined): HealthTile[] {
  const services = report && Array.isArray(report.services) ? report.services : [];
  return HEALTH_IDS.map((id) => {
    const s = services.find((x) => x.id === id);
    const statusLabel = serviceStatusLabel(s ? s.status : 'unknown');
    const detail = s && typeof s.detail === 'string' ? s.detail.trim() : '';
    return {
      id,
      name: s && s.label ? s.label : HEALTH_NAME[id],
      value: s && s.value ? s.value : '—',
      sub: detail && detail !== statusLabel ? detail : '',
      statusLabel,
      tone: serviceTone(s ? s.status : null),
    };
  });
}

/** Variation en pourcentage (« +12 % », « −2 % ») ; chaîne vide si indisponible. Le signe moins est typographique. */
export function fmtDelta(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '';
  const r = Math.round(Math.abs(pct) * 10) / 10;
  if (r === 0) return '0 %';
  const txt = (r >= 10 ? Math.round(r) : r).toString().replace('.', ',');
  return (pct > 0 ? '+' : '−') + txt + ' %';
}

/** Ton d'une variation : une hausse est bonne ou mauvaise selon l'indicateur (erreurs et latence : mauvaise). Sans variation : neutre. */
export function deltaTone(pct: number | null | undefined, goodWhenUp: boolean): Tone {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return 'neutral';
  return (pct > 0) === goodWhenUp ? 'ok' : 'bad';
}

/** Étiquettes de l'axe X d'une série : heure (1 h, 24 h) ou date (7 j). */
export function seriesLabels(points: ReadonlyArray<{ t: number | string }>, range: Range): string[] {
  return points.map((p) => {
    const d = new Date(toMs(p.t));
    if (!Number.isFinite(d.getTime())) return '';
    return range === '7d'
      ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  });
}

export interface FeedRow { at: string; label: string; target: string }

/** Derniers événements (« En direct ») : heure HH:MM, libellé, cible facultative ; `max` entrées au plus. */
export function feedRows(feed: LiveFeedEntry[] | null | undefined, max = 8): FeedRow[] {
  return (Array.isArray(feed) ? feed : []).slice(0, max).map((e) => {
    const t = toMs(e.at);
    return {
      at: Number.isFinite(t) ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—',
      label: String(e.label ?? ''),
      target: e.target ? String(e.target) : '',
    };
  });
}

/** Sévérités de « À traiter », de la plus grave à la moins grave. */
export const INBOX_SEVERITY = [
  { id: 'critical', label: 'Critique' },
  { id: 'warn', label: 'À surveiller' },
  { id: 'info', label: 'Pour information' },
] as const;
export type InboxSeverity = (typeof INBOX_SEVERITY)[number]['id'];

/** Sévérité d'un item ; une valeur inconnue est traitée comme « information ». */
export const inboxSeverity = (i: Pick<InboxItem, 'severity'>): InboxSeverity =>
  INBOX_SEVERITY.some((g) => g.id === i.severity) ? (i.severity as InboxSeverity) : 'info';

/** Items groupés par sévérité (ordre de INBOX_SEVERITY) ; les groupes vides sont omis. */
export function inboxGroups(items: InboxItem[] | null | undefined): Array<{ id: InboxSeverity; label: string; items: InboxItem[] }> {
  const list = Array.isArray(items) ? items : [];
  return INBOX_SEVERITY.map((g) => ({ id: g.id, label: g.label, items: list.filter((i) => inboxSeverity(i) === g.id) }))
    .filter((g) => g.items.length > 0);
}

/** Boîte sans l'item de clé `key` (retrait optimiste) : le total baisse d'un seulement si l'item y figurait. */
export function inboxWithout(inbox: Inbox, key: string): Inbox {
  const items = inbox.items.filter((i) => i.key !== key);
  return { items, total: items.length < inbox.items.length ? Math.max(0, inbox.total - 1) : inbox.total };
}

const ROUTE_ALIAS: Record<string, string> = { metrics: 'performance' };

/** Section de la console visée par la route d'une action (« #/admin/tasks » donne « tasks ») ; null pour une autre route. */
export function routeSection(route: string | null | undefined): string | null {
  const m = /^#?\/?admin\/([a-z-]+)\/?$/.exec(String(route ?? '').trim());
  if (!m) return null;
  return ROUTE_ALIAS[m[1]] ?? m[1];
}
