/**
 * Santé des indexeurs (Prowlarr, Jackett) gardée en mémoire du processus : état, latence moyenne glissante et
 * dernier code d'erreur, par source et identifiant d'indexeur. Rien n'est persisté ni envoyé ailleurs.
 */

/** Au-delà de cette latence moyenne (ms), un indexeur qui répond est « slow ». */
export const SLOW_THRESHOLD_MS = 5000;
/** Nombre de latences réussies retenues pour la moyenne glissante. */
export const LATENCY_WINDOW = 10;
/** Nombre maximal d'indexeurs suivis ; au-delà, le plus anciennement créé est oublié. */
export const MAX_TRACKED_INDEXERS = 1000;
const MAX_ERROR_CODE_LENGTH = 120;
/** Poids de la dernière mesure dans la moyenne exponentielle (EWMA) de latence. */
export const EWMA_ALPHA = 0.3;

export type HealthStatus = 'ok' | 'slow' | 'error';

/** Issue d'une requête vers un indexeur. `error` doit être un message déjà sûr (sans clé ni URL). */
export type IndexerOutcome = { ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: string };

export interface IndexerHealthSnapshot {
  source: string;
  indexerId: string;
  status: HealthStatus;
  /** Nombre total de requêtes. */
  count: number;
  /** Nombre de requêtes en échec. */
  errorCount: number;
  /** Latence moyenne des dernières requêtes réussies (fenêtre glissante). */
  avgLatencyMs?: number;
  /** Dernier code d'erreur observé. */
  lastErrorCode?: string;
  lastCheckedAt: number;
}

interface Entry {
  source: string;
  indexerId: string;
  latencies: number[];
  /** Latence moyenne exponentielle (réussites et délais dépassés) : sert à lancer les indexeurs lents en premier. */
  ewmaMs?: number;
  count: number;
  errorCount: number;
  lastOk: boolean;
  lastErrorCode?: string;
  lastCheckedAt: number;
}

function keyOf(source: string, indexerId: string): string {
  return JSON.stringify([source, indexerId]);
}

/**
 * Statut : `error` si la dernière requête a échoué ; `slow` si la latence moyenne dépasse SLOW_THRESHOLD_MS ;
 * sinon `ok`.
 */
function snapshot(entry: Entry): IndexerHealthSnapshot {
  const avg =
    entry.latencies.length > 0
      ? entry.latencies.reduce((sum, value) => sum + value, 0) / entry.latencies.length
      : undefined;
  let status: HealthStatus = 'ok';
  if (!entry.lastOk) status = 'error';
  else if (avg !== undefined && avg > SLOW_THRESHOLD_MS) status = 'slow';
  const result: IndexerHealthSnapshot = {
    source: entry.source,
    indexerId: entry.indexerId,
    status,
    count: entry.count,
    errorCount: entry.errorCount,
    lastCheckedAt: entry.lastCheckedAt,
  };
  if (avg !== undefined) result.avgLatencyMs = Math.round(avg);
  if (entry.lastErrorCode !== undefined) result.lastErrorCode = entry.lastErrorCode;
  return result;
}

/** Table de santé par (source, identifiant d'indexeur). Injectable (horloge) pour les tests. */
export class IndexerHealth {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Enregistre l'issue d'une requête. Le nom de source et l'identifiant forment la clé. */
  record(source: string, indexerId: number | string, outcome: IndexerOutcome): void {
    const id = String(indexerId);
    const key = keyOf(source, id);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { source, indexerId: id, latencies: [], count: 0, errorCount: 0, lastOk: true, lastCheckedAt: 0 };
      this.entries.set(key, entry);
      this.evict();
    }
    entry.count += 1;
    entry.lastCheckedAt = this.clock();
    // Une erreur rapide (refus, 4xx) ne dit rien de la lenteur : seules les réussites et les délais comptent.
    if (outcome.ok || /délai/i.test(outcome.error)) {
      entry.ewmaMs = entry.ewmaMs === undefined ? outcome.latencyMs : entry.ewmaMs + EWMA_ALPHA * (outcome.latencyMs - entry.ewmaMs);
    }
    if (outcome.ok) {
      entry.lastOk = true;
      entry.latencies.push(outcome.latencyMs);
      if (entry.latencies.length > LATENCY_WINDOW) entry.latencies.shift();
    } else {
      entry.lastOk = false;
      entry.errorCount += 1;
      entry.lastErrorCode = outcome.error.slice(0, MAX_ERROR_CODE_LENGTH);
    }
  }

  /** État d'un indexeur, ou undefined s'il n'a jamais été interrogé. */
  get(source: string, indexerId: number | string): IndexerHealthSnapshot | undefined {
    const entry = this.entries.get(keyOf(source, String(indexerId)));
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** Latence moyenne exponentielle d'un indexeur (ms), ou undefined s'il n'a jamais été mesuré. */
  ewma(source: string, indexerId: number | string): number | undefined {
    return this.entries.get(keyOf(source, String(indexerId)))?.ewmaMs;
  }

  /** États de tous les indexeurs suivis, ou seulement ceux d'une source. */
  getHealth(source?: string): IndexerHealthSnapshot[] {
    const all = [...this.entries.values()];
    const selected = source === undefined ? all : all.filter((entry) => entry.source === source);
    return selected.map(snapshot);
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > MAX_TRACKED_INDEXERS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

/** Table partagée par défaut (recherches et /config/test). */
export const defaultIndexerHealth = new IndexerHealth();

/** États de tous les indexeurs suivis par la table par défaut. */
export function getHealth(source?: string): IndexerHealthSnapshot[] {
  return defaultIndexerHealth.getHealth(source);
}
