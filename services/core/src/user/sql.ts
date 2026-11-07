/**
 * Accès SQL synchrone minimal, commun à Node (node:sqlite) et aux Durable Objects Cloudflare (SQLite du DO, API
 * synchrone elle aussi). Les stores (`UserStore`, `SkipSegmentStore`) et les migrations ne dépendent que de cette
 * interface : le moteur concret est choisi par la plateforme (voir platform/node/user-db.ts et platform/workers/).
 */

/** Valeur liée à un paramètre `?`. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Ligne de résultat : colonnes par nom (les BLOB sont toujours des `Uint8Array`). */
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): SqlRow[];
  run(...params: SqlParam[]): { changes: number | bigint };
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  /** Exécute une ou plusieurs instructions sans paramètre ni résultat. */
  exec(sql: string): void;
  /**
   * Exécute `work` de façon atomique : validée si elle rend, annulée si elle lève (l'erreur est relancée).
   * `work` est synchrone, comme toute l'interface.
   */
  transaction<T>(work: () => T): T;
  /** Libère la base (fichier fermé). Sans effet pour un Durable Object. */
  close(): void;
}
