import type { DurableObjectState, KVNamespace } from '@cloudflare/workers-types';
import { DurableObject } from 'cloudflare:workers';
import { isCachePrefix, type PurgeJob } from '../../admin/cache-types.js';
import {
  type MetricsBatch,
  type MetricsRange,
  type MetricsReport,
  MAX_ERRORS,
  RETENTION_MS,
  buildReport,
  isProvider,
  isProviderEvent,
  type ProviderEvent,
  type ProviderName,
  type ProviderRow,
  providerWindowStart,
} from '../../metrics/core.js';
import { durableObjectSql } from './sql.js';

/** Au plus cette durée (ms) ou ce nombre d'opérations KV par réveil : la purge reprend au réveil suivant. */
const PURGE_STEP_BUDGET_MS = 20_000;
const PURGE_STEP_OPS = 800;
const PURGE_LIST_LIMIT = 100;
const PRUNE_EVERY_MS = 10 * 60_000;
const MAX_JOBS_KEPT = 20;

interface JobRow {
  id: string;
  prefix: string;
  status: PurgeJob['status'];
  deleted: number;
  cursor: string | null;
  started_at: string;
  updated_at: string;
  error: string | null;
}

const toJob = (row: JobRow): PurgeJob => ({
  id: row.id,
  prefix: row.prefix,
  status: row.status,
  deleted: Number(row.deleted),
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  error: row.error,
});

/**
 * Durable Object « Metrics » : agrégation des métriques d'exploitation (tranches de 5 minutes, 7 jours de rétention,
 * 100 dernières erreurs 5xx), compteurs par fournisseur et par jour (30 jours), et purges de cache par préfixe,
 * asynchrones (alarme, lots, progression consultable).
 * Un seul objet global : les instances du Worker lui envoient des lots, jamais une requête par requête HTTP.
 */
export class Metrics extends DurableObject {
  private readonly db;
  private lastPrune = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.db = durableObjectSql(ctx.storage);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (bucket INTEGER NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (bucket, name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_daily (day INTEGER NOT NULL, provider TEXT NOT NULL, event TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, provider, event)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS purge_jobs (
        id TEXT PRIMARY KEY, prefix TEXT NOT NULL, status TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, cursor TEXT,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
    `);
  }

  /**
   * Reçoit le lot d'une instance : additionne les compteurs par (tranche, nom) et par (jour, fournisseur, événement),
   * et garde les dernières erreurs.
   */
  ingest(batch: MetricsBatch): void {
    this.db.transaction(() => {
      const upsert = this.db.prepare(
        'INSERT INTO metrics (bucket, name, value) VALUES (?, ?, ?) ON CONFLICT (bucket, name) DO UPDATE SET value = value + excluded.value',
      );
      for (const row of batch.rows) upsert.run(row.bucket, row.name, Math.round(row.value));
      const upsertProvider = this.db.prepare(
        'INSERT INTO provider_daily (day, provider, event, value) VALUES (?, ?, ?, ?) ON CONFLICT (day, provider, event) DO UPDATE SET value = value + excluded.value',
      );
      for (const row of batch.providers ?? []) {
        if (isProvider(row.provider) && isProviderEvent(row.event)) upsertProvider.run(row.day, row.provider, row.event, Math.round(row.value));
      }
      const insert = this.db.prepare('INSERT INTO errors (at, route, status, message) VALUES (?, ?, ?, ?)');
      for (const error of batch.errors.slice(-MAX_ERRORS)) insert.run(error.at, error.route, error.status, error.message);
      this.db.prepare('DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?').run(MAX_ERRORS);
    });
    const now = Date.now();
    if (now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.db.prepare('DELETE FROM metrics WHERE bucket < ?').run(now - RETENTION_MS);
      this.db.prepare('DELETE FROM errors WHERE at < ?').run(now - RETENTION_MS);
      this.db.prepare('DELETE FROM provider_daily WHERE day < ?').run(providerWindowStart(now));
    }
  }

  report(range: MetricsRange, now: number = Date.now()): MetricsReport {
    const rows = this.db.prepare('SELECT bucket, name, value FROM metrics WHERE bucket >= ?').all(now - RETENTION_MS);
    const errors = this.db.prepare('SELECT at, route, status, message FROM errors ORDER BY id').all();
    const providers = this.db.prepare('SELECT day, provider, event, value FROM provider_daily WHERE day >= ?').all(providerWindowStart(now));
    return buildReport(
      rows.map((row) => ({ bucket: Number(row.bucket), name: String(row.name), value: Number(row.value) })),
      errors.map((row) => ({ at: Number(row.at), route: String(row.route), status: Number(row.status), message: String(row.message) })),
      range,
      now,
      providers.map(
        (row): ProviderRow => ({
          day: Number(row.day),
          provider: String(row.provider) as ProviderName,
          event: String(row.event) as ProviderEvent,
          value: Number(row.value),
        }),
      ),
    );
  }

  // Purge de cache

  async startPurge(prefix: string): Promise<PurgeJob> {
    if (!isCachePrefix(prefix)) throw new Error('préfixe inconnu');
    const running = this.db.prepare("SELECT * FROM purge_jobs WHERE prefix = ? AND status = 'running'").get(prefix) as JobRow | undefined;
    if (running !== undefined) return toJob(running);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO purge_jobs (id, prefix, status, started_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run(id, prefix, now, now);
    this.db.prepare('DELETE FROM purge_jobs WHERE id NOT IN (SELECT id FROM purge_jobs ORDER BY started_at DESC LIMIT ?)').run(MAX_JOBS_KEPT);
    await this.ctx.storage.setAlarm(Date.now());
    return toJob(this.db.prepare('SELECT * FROM purge_jobs WHERE id = ?').get(id) as unknown as JobRow);
  }

  purgeJob(id: string): PurgeJob | undefined {
    const row = this.db.prepare('SELECT * FROM purge_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  purgeJobs(): PurgeJob[] {
    return (this.db.prepare('SELECT * FROM purge_jobs ORDER BY started_at DESC LIMIT ?').all(MAX_JOBS_KEPT) as unknown as JobRow[]).map(toJob);
  }

  /** Réveil : avance la plus ancienne purge d'un lot (limites de temps et d'opérations), puis se reprogramme s'il en reste. */
  async alarm(): Promise<void> {
    const job = this.db.prepare("SELECT * FROM purge_jobs WHERE status = 'running' ORDER BY started_at LIMIT 1").get() as JobRow | undefined;
    if (job === undefined) return;
    const kv = (this.env as { CACHE?: KVNamespace }).CACHE;
    const save = (status: PurgeJob['status'], deleted: number, cursor: string | null, error: string | null): void => {
      this.db
        .prepare('UPDATE purge_jobs SET status = ?, deleted = ?, cursor = ?, updated_at = ?, error = ? WHERE id = ?')
        .run(status, deleted, cursor, new Date().toISOString(), error, job.id);
    };
    if (kv === undefined) {
      save('failed', Number(job.deleted), null, 'kv_unavailable');
    } else {
      let deleted = Number(job.deleted);
      let cursor: string | undefined = job.cursor ?? undefined;
      let ops = 0;
      const deadline = Date.now() + PURGE_STEP_BUDGET_MS;
      try {
        for (;;) {
          const page = await kv.list({ prefix: `${job.prefix}:`, limit: PURGE_LIST_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
          await Promise.all(page.keys.map((key) => kv.delete(key.name)));
          deleted += page.keys.length;
          ops += 1 + page.keys.length;
          if (page.list_complete) {
            save('done', deleted, null, null);
            break;
          }
          cursor = page.cursor;
          save('running', deleted, cursor ?? null, null);
          if (ops >= PURGE_STEP_OPS || Date.now() >= deadline) break;
        }
      } catch {
        save('failed', deleted, null, 'kv_error');
      }
    }
    if (this.db.prepare("SELECT 1 AS n FROM purge_jobs WHERE status = 'running' LIMIT 1").get() !== undefined) {
      await this.ctx.storage.setAlarm(Date.now() + 500);
    }
  }
}
