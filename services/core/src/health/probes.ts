/**
 * Sondes de dépendances de /health. Chaque dépendance est testée en parallèle, avec un délai d'attente : une dépendance
 * en panne (erreur, sonde qui lève, délai dépassé) met `degraded` à true ; `ok` reste true tant que le Worker répond
 * (les apps testent `ok` pour choisir leur serveur : il ne doit jamais passer à false pour une dépendance). Aucun message
 * d'erreur n'est renvoyé (il peut contenir une URL ou un identifiant) : seuls l'état et la durée.
 * Les sondes sont en lecture seule (voir platform/workers/ops.ts).
 */

/** Délai d'attente de chaque dépendance, en millisecondes : au-delà, elle est comptée en panne. */
export const HEALTH_TIMEOUT_MS = 1500;

/** Sonde d'une dépendance : résolue si elle répond, rejetée sinon. */
export type HealthProbe = () => Promise<unknown>;

export interface DependencyHealth {
  ok: boolean;
  /** Durée de la sonde en millisecondes (délai d'attente compris). */
  ms: number;
}

export interface HealthReport {
  /** Toujours true tant que le Worker répond. */
  ok: true;
  /** true si une dépendance est en panne ou hors délai. */
  degraded: boolean;
  release: string;
  deps: Record<string, DependencyHealth>;
}

const TIMED_OUT = Symbol('timeout');

/** Une sonde, bornée par le délai. Ne rejette jamais. */
async function probeOne(probe: HealthProbe, timeoutMs: number): Promise<DependencyHealth> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let ok: boolean;
  try {
    // `Promise.resolve().then` transforme aussi une sonde qui lève de façon synchrone en rejet.
    const outcome = await Promise.race([Promise.resolve().then(probe), timeout]);
    ok = outcome !== TIMED_OUT;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  return { ok, ms: Date.now() - started };
}

/** État de chaque dépendance. Les sondes tournent en parallèle ; la promesse ne rejette jamais. */
export async function checkDependencies(
  probes: Readonly<Record<string, HealthProbe>>,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<Record<string, DependencyHealth>> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, probe]) => [name, await probeOne(probe, timeoutMs)] as const),
  );
  return Object.fromEntries(entries);
}

/** Corps de /health : `ok` (true tant que le Worker répond), `degraded` (une dépendance en panne ou hors délai), la version et l'état par dépendance. */
export async function healthReport(
  release: string,
  probes: Readonly<Record<string, HealthProbe>>,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthReport> {
  const deps = await checkDependencies(probes, timeoutMs);
  return { ok: true, degraded: !Object.values(deps).every((dep) => dep.ok), release, deps };
}

/** Durée de validité d'un rapport /health : /health est public, les sondes touchent KV, R2 et le Durable Object. */
export const HEALTH_CACHE_MS = 15_000;

export interface HealthReporterOptions {
  release: string;
  probes: Readonly<Record<string, HealthProbe>>;
  timeoutMs?: number;
  cacheMs?: number;
  /** Horloge (ms) : injectable pour les tests. */
  now?: () => number;
}

/**
 * Rapport /health mis en cache : seul le rapport résolu est gardé, pendant `cacheMs`, par isolat. Un appel après résolution
 * réutilise ce rapport ; des appels simultanés sans cache valide lancent chacun leurs sondes. La promesse n'est jamais
 * partagée entre requêtes : si la requête qui l'a lancée est annulée, les autres n'attendent pas une promesse orpheline.
 */
export function createHealthReporter(options: HealthReporterOptions): () => Promise<HealthReport> {
  const { release, probes, timeoutMs = HEALTH_TIMEOUT_MS, cacheMs = HEALTH_CACHE_MS, now = Date.now } = options;
  let cached: { at: number; report: HealthReport } | undefined;
  return async () => {
    const at = now();
    if (cached !== undefined && at - cached.at < cacheMs) return cached.report;
    const report = await healthReport(release, probes, timeoutMs);
    cached = { at, report };
    return report;
  };
}
