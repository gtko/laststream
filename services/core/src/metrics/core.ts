/**
 * Métriques d'exploitation : agrégation par tranche de 5 minutes, rétention 7 jours. Ce module est pur (aucune E/S) :
 * il sert à l'instance (accumulateur), au Durable Object `Metrics` (stockage SQLite), au mode Node (mémoire) et aux
 * tests. Aucune donnée personnelle n'y entre : groupes de routes fixes, hôtes d'addons sans chemin ni paramètre, codes
 * d'erreur AllDebrid, préfixes de cache, et messages d'erreur épurés (voir `sanitizeErrorMessage`).
 */

export const BUCKET_MS = 5 * 60_000;
export const RETENTION_MS = 7 * 24 * 3600_000;
/** Dernières erreurs 5xx conservées. */
export const MAX_ERRORS = 100;
/** Les instances envoient leurs compteurs au plus toutes les 10 secondes. */
export const FLUSH_INTERVAL_MS = 10_000;

/** Bornes hautes (ms) de l'histogramme de latence ; l'indice `LATENCY_BOUNDS_MS.length` est le dépassement. */
export const LATENCY_BOUNDS_MS: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

export const ROUTE_GROUPS = ['stream', 'play', 'lt_tmdb', 'lt', 'user', 'party', 'ui', 'other'] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';
export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

export const RANGES = { '1h': { ms: 3600_000, stepMs: BUCKET_MS }, '24h': { ms: 24 * 3600_000, stepMs: BUCKET_MS }, '7d': { ms: RETENTION_MS, stepMs: 3600_000 } } as const;
export type MetricsRange = keyof typeof RANGES;
export const isMetricsRange = (value: unknown): value is MetricsRange => typeof value === 'string' && Object.hasOwn(RANGES, value);

export type AlldebridOp = 'unlock' | 'magnet' | 'other';
export type UpstreamOutcome = 'ok' | 'fail' | 'timeout';

/** Point d'entrée des mesures : appels non bloquants et sans exception. */
export interface MetricsSink {
  request(group: RouteGroup, status: number, ms: number): void;
  upstream(host: string, outcome: UpstreamOutcome, ms: number): void;
  alldebrid(op: AlldebridOp, errorCode: string | null): void;
  cache(prefix: string, hit: boolean): void;
  error(route: string, status: number, message: string): void;
}

export const noopSink: MetricsSink = {
  request: () => undefined,
  upstream: () => undefined,
  alldebrid: () => undefined,
  cache: () => undefined,
  error: () => undefined,
};

export interface MetricRow {
  bucket: number;
  name: string;
  value: number;
}

export interface ErrorRecord {
  at: number;
  route: string;
  status: number;
  message: string;
}

export interface MetricsBatch {
  rows: MetricRow[];
  errors: ErrorRecord[];
}

/** Service de métriques d'une plateforme : l'écriture passe par `sink`, la lecture par `report`. */
export interface MetricsService {
  sink: MetricsSink;
  report(range: MetricsRange): Promise<MetricsReport>;
  /** Envoie les compteurs de l'instance si le délai d'envoi groupé est écoulé (appelé en fin de requête). */
  flushIfDue?(): void;
  /** Envoie immédiatement les compteurs de l'instance (tests, lecture du rapport). */
  flush?(): Promise<void>;
}

// Classification des routes

const STATIC_FILE = /\.(?:js|mjs|css|html|png|jpe?g|webp|svg|ico|woff2?|ttf|map|txt|webmanifest|gif|avif)$/i;
const UI_ROOTS = new Set(['assets', 'index.html', 'favicon.ico', 'sw.js', 'registerSW.js']);

/** Groupe de routes d'un chemin (aucun segment variable n'est conservé). */
export function routeGroup(path: string): RouteGroup {
  const parts = path.split('/').filter((part) => part !== '');
  const [first, second, third] = parts;
  if (first === undefined) return 'ui';
  if (first === 'user') return 'user';
  if (first === 'party') return 'party';
  if (first === 'admin' || first === 'health' || first === 'config' || first === 'manifest.json') return 'other';
  if (second === 'stream') return 'stream';
  if (second === 'play') return 'play';
  if (second === 'lt') return third === 'tmdb' ? 'lt_tmdb' : 'lt';
  if (UI_ROOTS.has(first) || STATIC_FILE.test(parts[parts.length - 1] ?? '')) return 'ui';
  return 'other';
}

const ROUTE_LITERALS = new Set(['user', 'party', 'admin', 'health', 'config', 'manifest.json', 'lt', 'play', 'stream', 'catalog', 'c', 'tmdb', 'status', 'streams']);

/**
 * Étiquette stable d'une route pour les erreurs : le segment de configuration (jeton chiffré) et tout identifiant
 * deviennent des paramètres (`/:config/stream/:type/:id`), jamais de valeur réelle.
 */
export function routeLabel(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return '/';
  const out = parts.slice(0, 6).map((part, index) => {
    if (ROUTE_LITERALS.has(part)) return part;
    if (index === 0 && !['user', 'party', 'admin', 'health', 'config', 'manifest.json', 'assets', '_ss'].includes(part)) return ':config';
    if (/^(?:movie|series|tv|anime|channel|other)$/.test(part)) return part;
    if (/^[a-z]{1,12}$/.test(part)) return part;
    return ':id';
  });
  return `/${out.join('/')}`;
}

// Épuration des messages d'erreur

/**
 * Message d'erreur sans donnée sensible : les URL deviennent `[url]`, les suites longues (jetons, configurations,
 * clés) `[masqué]`, les adresses IP et e-mails sont retirés ; longueur bornée.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/(?:[A-Fa-f0-9:]{2,}:){3,}[A-Fa-f0-9:]*/g, '[ip]')
    .replace(/[A-Za-z0-9_\-+/=%.]{24,}/g, '[masqué]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Nom d'hôte seul (sans port, chemin ni identifiants), en minuscules ; undefined si l'adresse est illisible. */
export function hostOf(rawUrl: string): string | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return /^[a-z0-9._:-]{1,100}$/.test(host) ? host.replace(/:/g, '_') : undefined;
  } catch {
    return undefined;
  }
}

export function statusClass(status: number): StatusClass {
  return status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
}

export function latencyIndex(ms: number): number {
  const index = LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? LATENCY_BOUNDS_MS.length : index;
}

export const bucketOf = (at: number): number => Math.floor(at / BUCKET_MS) * BUCKET_MS;

// Noms de compteurs : « genre|élément|détail » (le séparateur « | » ne peut figurer dans aucun élément).
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_UPSTREAM_HOSTS = 200;
const MAX_ELEMENTS_PER_KIND = 100;

/**
 * Accumulateur d'instance : additionne les compteurs par (tranche, nom) en mémoire. `take()` rend le lot à envoyer et
 * remet à zéro. Les erreurs sont gardées dans la limite de MAX_ERRORS. Aucune exception ne sort des méthodes d'écriture.
 */
export class MetricsAccumulator implements MetricsSink {
  private counters = new Map<string, MetricRow>();
  private errors: ErrorRecord[] = [];
  private readonly hosts = new Set<string>();
  private readonly elements = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  isEmpty(): boolean {
    return this.counters.size === 0 && this.errors.length === 0;
  }

  private add(name: string, value = 1): void {
    const bucket = bucketOf(this.now());
    const key = `${bucket}|${name}`;
    const row = this.counters.get(key);
    if (row === undefined) this.counters.set(key, { bucket, name, value });
    else row.value += value;
  }

  /** Borne le nombre d'éléments distincts par genre (une entrée utilisateur ne doit pas faire exploser le stockage). */
  private allowed(kind: string, element: string): boolean {
    let set = this.elements.get(kind);
    if (set === undefined) {
      set = new Set();
      this.elements.set(kind, set);
    }
    if (set.has(element)) return true;
    if (set.size >= MAX_ELEMENTS_PER_KIND) return false;
    set.add(element);
    return true;
  }

  request(group: RouteGroup, status: number, ms: number): void {
    this.add(`rq|${group}`);
    this.add(`st|${group}|${statusClass(status)}`);
    this.add(`lt|${group}|${latencyIndex(ms)}`);
    this.add(`ls|${group}`, Math.max(0, Math.round(ms)));
  }

  upstream(host: string, outcome: UpstreamOutcome, ms: number): void {
    if (!SAFE_NAME.test(host)) return;
    if (!this.hosts.has(host)) {
      if (this.hosts.size >= MAX_UPSTREAM_HOSTS) return;
      this.hosts.add(host);
    }
    this.add(`up|${host}|calls`);
    if (outcome === 'fail') this.add(`up|${host}|fail`);
    if (outcome === 'timeout') this.add(`up|${host}|timeout`);
    this.add(`up|${host}|ms`, Math.max(0, Math.round(ms)));
  }

  alldebrid(op: AlldebridOp, errorCode: string | null): void {
    if (errorCode === null) {
      this.add(`ad|${op}|ok`);
      return;
    }
    const code = SAFE_NAME.test(errorCode) && this.allowed('adcode', errorCode) ? errorCode : 'autre';
    this.add(`ad|${op}|err|${code}`);
  }

  cache(prefix: string, hit: boolean): void {
    const safe = /^[a-z0-9_-]{1,32}$/.test(prefix) && this.allowed('cache', prefix) ? prefix : 'autre';
    this.add(`ch|${safe}|${hit ? 'hit' : 'miss'}`);
  }

  error(route: string, status: number, message: string): void {
    this.errors.push({ at: this.now(), route: route.slice(0, 120), status, message: sanitizeErrorMessage(message) });
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
  }

  /** Lot à envoyer ; l'accumulateur repart de zéro. */
  take(): MetricsBatch {
    const batch: MetricsBatch = { rows: [...this.counters.values()], errors: this.errors };
    this.counters = new Map();
    this.errors = [];
    return batch;
  }

  /** Remet un lot non envoyé (échec d'envoi), dans la limite de MAX_ERRORS erreurs. */
  restore(batch: MetricsBatch): void {
    for (const row of batch.rows) {
      const key = `${row.bucket}|${row.name}`;
      const existing = this.counters.get(key);
      if (existing === undefined) this.counters.set(key, { ...row });
      else existing.value += row.value;
    }
    this.errors = [...batch.errors, ...this.errors].slice(-MAX_ERRORS);
  }
}

/** Stockage en mémoire (mode Node, tests) : mêmes lots, même rétention que le Durable Object. */
export class MemoryMetricsStore {
  private readonly rows = new Map<string, MetricRow>();
  private errors: ErrorRecord[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  ingest(batch: MetricsBatch): void {
    for (const row of batch.rows) {
      const key = `${row.bucket}|${row.name}`;
      const existing = this.rows.get(key);
      if (existing === undefined) this.rows.set(key, { ...row });
      else existing.value += row.value;
    }
    this.errors = [...this.errors, ...batch.errors].sort((a, b) => a.at - b.at).slice(-MAX_ERRORS);
    const limit = this.now() - RETENTION_MS;
    for (const [key, row] of this.rows) if (row.bucket < limit) this.rows.delete(key);
    this.errors = this.errors.filter((entry) => entry.at >= limit);
  }

  report(range: MetricsRange): MetricsReport {
    return buildReport([...this.rows.values()], this.errors, range, this.now());
  }
}

// Rapport

export interface LatencyStats {
  p50: number | null;
  p95: number | null;
  avgMs: number | null;
}

export interface GroupReport extends LatencyStats {
  requests: number;
  status: Record<StatusClass, number>;
}

export interface MetricsReport {
  range: MetricsRange;
  from: string;
  to: string;
  stepSec: number;
  totals: GroupReport;
  groups: Record<RouteGroup, GroupReport>;
  /** Une entrée par pas de temps (début de tranche) : requêtes, erreurs 5xx, p95 global. */
  series: { t: string; requests: number; errors5xx: number; p95: number | null }[];
  upstreams: { host: string; calls: number; failures: number; timeouts: number; avgMs: number | null }[];
  alldebrid: Record<'unlock' | 'magnet' | 'other', { ok: number; errors: Record<string, number> }>;
  caches: { prefix: string; hits: number; misses: number; hitRate: number | null }[];
  errors: { at: string; route: string; status: number; message: string }[];
}

function quantile(histogram: readonly number[], q: number): number | null {
  const total = histogram.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = q * total;
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index] ?? 0;
    if (count === 0) continue;
    if (cumulative + count >= target) {
      const low = index === 0 ? 0 : (LATENCY_BOUNDS_MS[index - 1] ?? 0);
      const high = LATENCY_BOUNDS_MS[index] ?? low * 2;
      return Math.round(low + ((target - cumulative) / count) * (high - low));
    }
    cumulative += count;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1] ?? null;
}

const emptyHistogram = (): number[] => new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0);
const emptyStatus = (): Record<StatusClass, number> => ({ '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 });

interface GroupAcc {
  requests: number;
  status: Record<StatusClass, number>;
  histogram: number[];
  sumMs: number;
}

const newGroupAcc = (): GroupAcc => ({ requests: 0, status: emptyStatus(), histogram: emptyHistogram(), sumMs: 0 });

function finishGroup(acc: GroupAcc): GroupReport {
  return {
    requests: acc.requests,
    status: acc.status,
    p50: quantile(acc.histogram, 0.5),
    p95: quantile(acc.histogram, 0.95),
    avgMs: acc.requests === 0 ? null : Math.round(acc.sumMs / acc.requests),
  };
}

const isGroup = (value: string | undefined): value is RouteGroup => (ROUTE_GROUPS as readonly string[]).includes(value ?? '');
const isStatusClass = (value: string | undefined): value is StatusClass => (STATUS_CLASSES as readonly string[]).includes(value ?? '');

/** Rapport d'une période à partir des compteurs bruts. Fonction pure : même résultat en mémoire et dans le Durable Object. */
export function buildReport(rows: readonly MetricRow[], errors: readonly ErrorRecord[], range: MetricsRange, now: number): MetricsReport {
  const { ms: spanMs, stepMs } = RANGES[range];
  const to = bucketOf(now) + BUCKET_MS;
  const from = to - spanMs;
  const totals = newGroupAcc();
  const groups = Object.fromEntries(ROUTE_GROUPS.map((group) => [group, newGroupAcc()])) as Record<RouteGroup, GroupAcc>;
  const steps = new Map<number, { requests: number; errors5xx: number; histogram: number[] }>();
  for (let t = Math.floor(from / stepMs) * stepMs; t < to; t += stepMs) steps.set(t, { requests: 0, errors5xx: 0, histogram: emptyHistogram() });
  const upstreams = new Map<string, { calls: number; failures: number; timeouts: number; ms: number }>();
  const alldebrid: MetricsReport['alldebrid'] = { unlock: { ok: 0, errors: {} }, magnet: { ok: 0, errors: {} }, other: { ok: 0, errors: {} } };
  const caches = new Map<string, { hits: number; misses: number }>();

  for (const row of rows) {
    if (row.bucket < from || row.bucket >= to) continue;
    const [kind, a, b, c] = row.name.split('|');
    const step = steps.get(Math.floor(row.bucket / stepMs) * stepMs);
    if (kind === 'rq' && isGroup(a)) {
      groups[a].requests += row.value;
      totals.requests += row.value;
      if (step !== undefined) step.requests += row.value;
    } else if (kind === 'st' && isGroup(a) && isStatusClass(b)) {
      groups[a].status[b] += row.value;
      totals.status[b] += row.value;
      if (b === '5xx' && step !== undefined) step.errors5xx += row.value;
    } else if (kind === 'lt' && isGroup(a) && b !== undefined) {
      const index = Number(b);
      if (Number.isInteger(index) && index >= 0 && index <= LATENCY_BOUNDS_MS.length) {
        groups[a].histogram[index] = (groups[a].histogram[index] ?? 0) + row.value;
        totals.histogram[index] = (totals.histogram[index] ?? 0) + row.value;
        if (step !== undefined) step.histogram[index] = (step.histogram[index] ?? 0) + row.value;
      }
    } else if (kind === 'ls' && isGroup(a)) {
      groups[a].sumMs += row.value;
      totals.sumMs += row.value;
    } else if (kind === 'up' && a !== undefined && b !== undefined) {
      const entry = upstreams.get(a) ?? { calls: 0, failures: 0, timeouts: 0, ms: 0 };
      if (b === 'calls') entry.calls += row.value;
      else if (b === 'fail') entry.failures += row.value;
      else if (b === 'timeout') entry.timeouts += row.value;
      else if (b === 'ms') entry.ms += row.value;
      upstreams.set(a, entry);
    } else if (kind === 'ad' && (a === 'unlock' || a === 'magnet' || a === 'other')) {
      if (b === 'ok') alldebrid[a].ok += row.value;
      else if (b === 'err' && c !== undefined) alldebrid[a].errors[c] = (alldebrid[a].errors[c] ?? 0) + row.value;
    } else if (kind === 'ch' && a !== undefined && (b === 'hit' || b === 'miss')) {
      const entry = caches.get(a) ?? { hits: 0, misses: 0 };
      if (b === 'hit') entry.hits += row.value;
      else entry.misses += row.value;
      caches.set(a, entry);
    }
  }

  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    stepSec: stepMs / 1000,
    totals: finishGroup(totals),
    groups: Object.fromEntries(ROUTE_GROUPS.map((group) => [group, finishGroup(groups[group])])) as Record<RouteGroup, GroupReport>,
    series: [...steps.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([t, step]) => ({ t: new Date(t).toISOString(), requests: step.requests, errors5xx: step.errors5xx, p95: quantile(step.histogram, 0.95) })),
    upstreams: [...upstreams.entries()]
      .map(([host, u]) => ({ host, calls: u.calls, failures: u.failures, timeouts: u.timeouts, avgMs: u.calls === 0 ? null : Math.round(u.ms / u.calls) }))
      .sort((x, y) => y.calls - x.calls)
      .slice(0, 100),
    alldebrid,
    caches: [...caches.entries()]
      .map(([prefix, c]) => ({ prefix, hits: c.hits, misses: c.misses, hitRate: c.hits + c.misses === 0 ? null : Math.round((c.hits / (c.hits + c.misses)) * 1000) / 1000 }))
      .sort((x, y) => x.prefix.localeCompare(y.prefix)),
    errors: errors
      .filter((entry) => entry.at >= from)
      .slice(-MAX_ERRORS)
      .reverse()
      .map((entry) => ({ at: new Date(entry.at).toISOString(), route: entry.route, status: entry.status, message: entry.message })),
  };
}
