/**
 * Santé des fournisseurs (appels sortants) à partir des lignes horaires UTC de providers.ts : taux de succès sur 24 h,
 * latence p95 estimée sur l'histogramme des appels réussis, sparkline de 24 points (taux de succès par heure), date du
 * dernier échec et statut. Fonction pure : même résultat en mémoire et dans le Durable Object.
 */

import { quantile } from './core.js';
import { HOUR_MS, healthWindowStart, hourOf, isProvider, PROVIDERS, type ProviderHourRow, type ProviderName } from './providers.js';

/** Fenêtre des taux, de la latence et du statut : 24 heures UTC, heure courante incluse (= nombre de points de la sparkline). */
export const HEALTH_WINDOW_HOURS = 24;
/** Taux de succès à partir duquel le statut est « ok » (fraction). */
const OK_RATE = 0.98;
/** Taux de succès à partir duquel le statut est « degraded » ; en dessous : « down ». */
const DEGRADED_RATE = 0.9;
/** Appels minimum sur la fenêtre pour qu'un fournisseur puisse être déclaré « down ». */
export const DOWN_MIN_CALLS = 5;

export type ProviderStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ProviderHealth {
  /** Taux de succès sur 24 h (fraction de 0 à 1, 3 décimales) ; null sans appel. */
  successRate: number | null;
  /** Latence p95 estimée (ms) des appels réussis sur 24 h ; null sans appel réussi. */
  p95: number | null;
  /** 24 points : taux de succès de chaque heure UTC, de la plus ancienne à l'heure courante ; null sans appel. */
  spark: (number | null)[];
  /** Dernier échec (ISO 8601) sur la rétention ; null sans échec. */
  lastFailureAt: string | null;
  status: ProviderStatus;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Statut d'après les appels réussis et les échecs de la fenêtre : ok (>= 98 %), degraded (90 à 98 %), down (< 90 %, avec
 * au moins DOWN_MIN_CALLS appels ; en dessous, degraded), unknown (aucun appel).
 */
export function providerStatus(ok: number, fail: number): ProviderStatus {
  const calls = ok + fail;
  if (calls === 0) return 'unknown';
  const rate = ok / calls;
  if (rate >= OK_RATE) return 'ok';
  if (rate >= DEGRADED_RATE) return 'degraded';
  return calls >= DOWN_MIN_CALLS ? 'down' : 'degraded';
}

/** Santé d'un fournisseur à partir de ses lignes horaires (déjà filtrées sur la rétention). */
function healthOf(rows: readonly ProviderHourRow[], now: number): ProviderHealth {
  const current = hourOf(now);
  const windowStart = current - (HEALTH_WINDOW_HOURS - 1) * HOUR_MS;
  let ok = 0;
  let fail = 0;
  let lastFailAt = 0;
  const latency: number[] = [];
  const perHour = new Map<number, { ok: number; fail: number }>();
  for (const row of rows) {
    lastFailAt = Math.max(lastFailAt, row.lastFailAt ?? 0);
    if (row.hour < windowStart || row.hour > current) continue;
    ok += row.ok;
    fail += row.fail;
    row.latency.forEach((count, index) => {
      latency[index] = (latency[index] ?? 0) + count;
    });
    const hour = perHour.get(row.hour) ?? { ok: 0, fail: 0 };
    hour.ok += row.ok;
    hour.fail += row.fail;
    perHour.set(row.hour, hour);
  }
  const spark: (number | null)[] = [];
  for (let index = 0; index < HEALTH_WINDOW_HOURS; index += 1) {
    const hour = perHour.get(windowStart + index * HOUR_MS);
    spark.push(hour === undefined || hour.ok + hour.fail === 0 ? null : round3(hour.ok / (hour.ok + hour.fail)));
  }
  const calls = ok + fail;
  return {
    successRate: calls === 0 ? null : round3(ok / calls),
    p95: quantile(latency, 0.95),
    spark,
    lastFailureAt: lastFailAt > 0 ? new Date(lastFailAt).toISOString() : null,
    status: providerStatus(ok, fail),
  };
}

/**
 * Santé de chaque fournisseur de la liste fixe (PROVIDERS) à l'instant `now`. Un fournisseur sans ligne a le statut
 * unknown, des taux null et une sparkline de 24 valeurs null.
 */
export function buildProviderHealth(rows: readonly ProviderHourRow[], now: number): Record<ProviderName, ProviderHealth> {
  const from = healthWindowStart(now);
  const to = hourOf(now);
  const byProvider = new Map<ProviderName, ProviderHourRow[]>();
  for (const row of rows) {
    if (!isProvider(row.provider) || row.hour < from || row.hour > to) continue;
    const list = byProvider.get(row.provider);
    if (list === undefined) byProvider.set(row.provider, [row]);
    else list.push(row);
  }
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, healthOf(byProvider.get(provider) ?? [], now)])) as Record<
    ProviderName,
    ProviderHealth
  >;
}
