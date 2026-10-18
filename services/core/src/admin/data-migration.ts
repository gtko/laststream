import type { SqlDb, SqlParam } from '../user/sql.js';

/**
 * Migration des données utilisateur vers le Durable Object (route d'administration, voir admin/routes.ts).
 * Tables dans l'ordre des clés étrangères (parents d'abord) ; `schema_migrations` n'est jamais copiée (le DO se migre seul).
 */
export const MIGRATED_TABLES = [
  'accounts',
  'sessions',
  'profiles',
  'library_items',
  'progress',
  'settings',
  'follows',
  'ratings',
  'continue_hidden',
  'skip_segments',
  'skip_fingerprints',
] as const;

export type MigratedTable = (typeof MIGRATED_TABLES)[number];

export function isMigratedTable(name: unknown): name is MigratedTable {
  return typeof name === 'string' && (MIGRATED_TABLES as readonly string[]).includes(name);
}

/** Valeur transportée en JSON : les BLOB deviennent `{ b64 }`. */
export type WireValue = string | number | null | { b64: string };

export interface TableDigest {
  count: number;
  sha256: string;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Colonnes d'une table, triées par nom (l'ordre physique peut varier selon l'historique des ALTER). */
export function columnsOf(db: SqlDb, table: MigratedTable): string[] {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name))
    .sort();
}

/** Ligne → tableau de valeurs transportables, dans l'ordre de `columns`. */
export function toWire(row: Record<string, unknown>, columns: readonly string[]): WireValue[] {
  return columns.map((column) => {
    const value = row[column];
    if (value instanceof Uint8Array) return { b64: toBase64(value) };
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    return value as string | number;
  });
}

/** Empreinte d'une table : nombre de lignes et SHA-256 des lignes triées (colonnes par nom, BLOB en base64). */
export async function digestTable(db: SqlDb, table: MigratedTable): Promise<TableDigest> {
  const columns = columnsOf(db, table);
  const select = columns.map((name) => `"${name}"`).join(', ');
  const order = columns.map((_, index) => index + 1).join(', ');
  const rows = db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${order}`).all();
  const text = rows.map((row) => JSON.stringify(toWire(row, columns))).join('\n');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${columns.join(',')}\n${text}`));
  return { count: rows.length, sha256: hex(hash) };
}

export async function digestAll(db: SqlDb): Promise<Record<MigratedTable, TableDigest>> {
  const out = {} as Record<MigratedTable, TableDigest>;
  for (const table of MIGRATED_TABLES) out[table] = await digestTable(db, table);
  return out;
}

/** Vrai si aucune table utilisateur ne contient de ligne. */
export function isEmpty(db: SqlDb): boolean {
  return MIGRATED_TABLES.every((table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0) === 0);
}

/** Vide toutes les tables (enfants d'abord) et remet à zéro le compteur AUTOINCREMENT des segments. */
export function wipeAll(db: SqlDb): void {
  db.transaction(() => {
    for (const table of [...MIGRATED_TABLES].reverse()) db.exec(`DELETE FROM "${table}"`);
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'skip_segments'");
  });
}

/** Insère un lot dans une transaction ; les colonnes doivent toutes exister dans la table. Renvoie le nombre de lignes. */
export function insertBatch(db: SqlDb, table: MigratedTable, columns: readonly string[], rows: readonly (readonly WireValue[])[]): number {
  const known = new Set(columnsOf(db, table));
  if (columns.length === 0 || columns.some((column) => !known.has(column))) throw new Error('colonnes inconnues');
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  return db.transaction(() => {
    const statement = db.prepare(sql);
    for (const row of rows) {
      if (row.length !== columns.length) throw new Error('ligne de longueur invalide');
      statement.run(...row.map((value): SqlParam => (value !== null && typeof value === 'object' ? fromBase64(value.b64) : value)));
    }
    return rows.length;
  });
}
