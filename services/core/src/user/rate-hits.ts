import type { SqlDb } from './sql.js';

/**
 * Limites de débit persistantes à fenêtre glissante, comptées en SQL (table `rate_hits`, migration 23) : elles survivent
 * au redémarrage du processus et sont partagées entre instances. Une ligne par action autorisée ; les actions refusées
 * ne sont pas comptées. Aucune clé étrangère : une ligne expire d'elle-même.
 */

/** Plus longue fenêtre utilisée : les lignes plus anciennes sont purgées à chaque écriture. */
const RETENTION_MS = 2 * 60 * 60 * 1000;

/** Secondes avant la prochaine action permise, ou `undefined` si la limite de la fenêtre n'est pas atteinte (rien n'est écrit). */
export function rateRetryAfter(db: SqlDb, bucket: string, key: string, limit: number, windowMs: number, now: number): number | undefined {
  const row = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM rate_hits WHERE bucket = ? AND key = ? AND at > ?').get(bucket, key, now - windowMs);
  if (Number(row?.n ?? 0) < limit) return undefined;
  const oldest = Number(row?.oldest ?? now);
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

/** Compte une action autorisée. */
export function recordRateHit(db: SqlDb, bucket: string, key: string, now: number): void {
  db.prepare('DELETE FROM rate_hits WHERE at <= ?').run(now - RETENTION_MS);
  db.prepare('INSERT INTO rate_hits (bucket, key, at) VALUES (?, ?, ?)').run(bucket, key, now);
}

/** Vérifie puis compte : `undefined` si l'action est permise (et comptée), sinon les secondes d'attente. */
export function consumeRate(db: SqlDb, bucket: string, key: string, limit: number, windowMs: number, now: number): number | undefined {
  const retryAfter = rateRetryAfter(db, bucket, key, limit, windowMs, now);
  if (retryAfter !== undefined) return retryAfter;
  recordRateHit(db, bucket, key, now);
  return undefined;
}
