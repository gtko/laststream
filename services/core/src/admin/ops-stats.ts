import type { SqlDb } from '../user/sql.js';
import type { TvCronState } from './cache-types.js';

/**
 * Lectures d'exploitation pour l'administration (/admin/storage, /admin/tasks) : pages R2 bornées, lignes des tables
 * SQLite, prochain passage du cron TV. Module pur : les accès aux liaisons (R2, Durable Object) sont injectés par la
 * plateforme (voir OpsPorts). Tout ce qui est indisponible vaut null : rien n'est estimé.
 */

export type R2BucketName = 'TV' | 'META' | 'AVATARS';
export const R2_BUCKET_NAMES: readonly R2BucketName[] = ['TV', 'META', 'AVATARS'];

/** Objets lus par page (maximum d'un appel R2 list) et pages lues au plus par bucket : au-delà, `truncated`. */
export const R2_PAGE_LIMIT = 1000;
export const R2_MAX_PAGES = 10;

/** Page d'une liste R2 : seule la taille de chaque objet sert ici. */
export interface R2Page {
  objects: readonly { size: number }[];
  truncated: boolean;
  cursor?: string;
}

/** Sous-ensemble du binding R2 utilisé : liste paginée, lecture seule. */
export interface R2Listing {
  list(options: { limit: number; cursor?: string }): Promise<R2Page>;
}

export interface R2Usage {
  /** Nombre d'objets comptés (minimum quand `truncated`), ou null si indisponible. */
  objects: number | null;
  /** Taille cumulée des objets comptés, ou null si indisponible. */
  bytes: number | null;
  /** Vrai quand le plafond de pages a été atteint : les totaux sont alors partiels. */
  truncated: boolean;
}

/** Usage d'un bucket R2 : pages successives jusqu'au bout ou jusqu'au plafond. Absent ou en erreur : tout est null. */
export async function r2UsageOf(bucket: R2Listing | undefined): Promise<R2Usage> {
  const unavailable: R2Usage = { objects: null, bytes: null, truncated: false };
  if (bucket === undefined) return unavailable;
  try {
    let objects = 0;
    let bytes = 0;
    let cursor: string | undefined;
    for (let page = 0; page < R2_MAX_PAGES; page += 1) {
      const result = await bucket.list({ limit: R2_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
      objects += result.objects.length;
      bytes += result.objects.reduce((sum, object) => sum + object.size, 0);
      if (!result.truncated) return { objects, bytes, truncated: false };
      cursor = result.cursor;
      if (cursor === undefined) break;
    }
    return { objects, bytes, truncated: true };
  } catch {
    return unavailable;
  }
}

/** Tables d'une base SQLite : taille (octets, null si non obtenable) et nombre de lignes par table (null si le comptage échoue). */
export interface SqlStats {
  sizeBytes: number | null;
  tables: { name: string; rows: number | null }[];
}

/** Tables internes (SQLite, Cloudflare) exclues du décompte. */
const internalTable = (name: string): boolean => name.startsWith('sqlite_') || name.startsWith('_cf_');

/** Nombre de lignes de chaque table utilisateur (COUNT). Le nom vient du schéma, il est tout de même entre guillemets. */
export function sqlStatsOf(db: SqlDb, sizeBytes: number | null): SqlStats {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !internalTable(name));
  const tables = names.map((name) => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get();
      return { name, rows: row === undefined ? null : Number(row.n) };
    } catch {
      return { name, rows: null };
    }
  });
  return { sizeBytes, tables };
}

/** Cron Trigger de la TV : toutes les 6 h, à heure pleine UTC (wrangler.jsonc, triggers). Garder aligné avec wrangler.jsonc. */
export const TV_CRON_PERIOD_MS = 6 * 3600_000;
/** Retard toléré au-delà de la période avant de signaler un passage en retard. */
export const TV_CRON_SLACK_MS = 3600_000;

/** Prochain passage du cron, ISO 8601 : premier multiple de la période (UTC) strictement après `now`. */
export function nextTvRun(now: number): string {
  return new Date(Math.floor(now / TV_CRON_PERIOD_MS) * TV_CRON_PERIOD_MS + TV_CRON_PERIOD_MS).toISOString();
}

/**
 * En retard : aucune trace de passage, ou dernier passage commencé il y a plus d'une période et demie. Une première
 * exécution peut donc manquer pendant au plus une période après le déploiement du stockage TV.
 */
export function tvOverdue(lastCron: TvCronState | null, now: number): boolean {
  if (lastCron === null) return true;
  const started = Date.parse(lastCron.startedAt);
  if (!Number.isFinite(started)) return true;
  return now - started > TV_CRON_PERIOD_MS + TV_CRON_SLACK_MS;
}

/** Liaisons d'exploitation injectées par la plateforme (Workers : buckets R2 et base du Durable Object). Absentes : « indisponible ». */
export interface OpsPorts {
  r2?: Partial<Record<R2BucketName, R2Listing>>;
  sqlStats?: () => Promise<SqlStats>;
}
