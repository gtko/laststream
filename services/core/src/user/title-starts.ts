import type { SqlDb } from './sql.js';

/**
 * Lancements de titres par pays (agrégat anonyme). Pour chaque jour UTC, pays et titre, `n` compte les comptes dont
 * c'est la toute première progression enregistrée sur ce titre (tous épisodes et tous profils du compte confondus).
 * La table ne contient aucune donnée de compte : seulement le jour, le pays, la clé du titre et le compteur.
 */

/** Pays inconnu : absent, invalide, ou requête hors Cloudflare (serveur Node). */
export const UNKNOWN_COUNTRY = 'XX';
/** Nombre minimal de lancements pour qu'un titre soit lisible (anonymat). */
export const MIN_STARTS = 3;
/** Durée de conservation des lignes, en jours. */
export const RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** Code pays ISO 3166-1 alpha-2 en majuscules, ou « XX » si la valeur n'est pas un code à deux lettres. */
export function countryCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : UNKNOWN_COUNTRY;
}

/** Jour UTC (AAAA-MM-JJ) d'un instant ISO 8601. */
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Jour décalé de `delta` jours (AAAA-MM-JJ, calcul en UTC). */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Clé d'un titre pour l'agrégat : type et référence (`movie|tmdb:550`, `series|tmdb:1399`). Pas de saison ni d'épisode. */
export function titleStartKey(type: string, ref: string): string {
  return `${type}|${ref}`;
}

/** Vrai si le compte (tous profils confondus) a déjà une progression sur ce titre. */
export function accountHasProgress(db: SqlDb, profileId: string, type: string, ref: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS found FROM profiles pr JOIN progress p ON p.profile_id = pr.id
         WHERE pr.account_id = (SELECT account_id FROM profiles WHERE id = ?) AND p.type = ? AND p.title_ref = ? LIMIT 1`,
      )
      .get(profileId, type, ref) !== undefined
  );
}

/** Compte un lancement pour (jour, pays, titre). */
export function recordTitleStart(db: SqlDb, day: string, country: string, key: string): void {
  db.prepare(
    `INSERT INTO title_starts (day, country, key, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, country, key) DO UPDATE SET n = n + 1`,
  ).run(day, country, key);
}

/** Supprime les lignes antérieures à `cutoffDay` (exclu). */
export function purgeTitleStarts(db: SqlDb, cutoffDay: string): void {
  db.prepare('DELETE FROM title_starts WHERE day < ?').run(cutoffDay);
}

/** Un titre de l'agrégat : clé et nombre de lancements. */
export interface TitleStart {
  key: string;
  n: number;
}

/** Titres les plus lancés dans un pays depuis `sinceDay` (inclus), `n` cumulé ; seuls ceux à MIN_STARTS lancements ou plus. */
export function topTitleStarts(db: SqlDb, country: string, sinceDay: string, limit: number): TitleStart[] {
  const rows = db
    .prepare(
      `SELECT key, SUM(n) AS n FROM title_starts WHERE country = ? AND day >= ?
       GROUP BY key HAVING SUM(n) >= ? ORDER BY n DESC, key LIMIT ?`,
    )
    .all(country, sinceDay, MIN_STARTS, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1);
  return rows.map((row) => ({ key: String(row.key), n: Number(row.n) }));
}
