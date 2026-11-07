import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { SqlDb, SqlParam, SqlRow, SqlStatement } from '../../user/sql.js';

/** Liaison acceptée par le SQLite d'un Durable Object : les Uint8Array deviennent des ArrayBuffer, bigint un nombre. */
function bind(param: SqlParam): string | number | null | ArrayBuffer {
  if (param instanceof Uint8Array) {
    return param.buffer.slice(param.byteOffset, param.byteOffset + param.byteLength) as ArrayBuffer;
  }
  return typeof param === 'bigint' ? Number(param) : param;
}

/** Les BLOB reviennent en ArrayBuffer : l'interface commune les expose en Uint8Array. */
function unbind(row: Record<string, unknown>): SqlRow {
  const out: SqlRow = {};
  for (const [name, value] of Object.entries(row)) out[name] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return out;
}

/**
 * Adapte le stockage SQLite d'un Durable Object à l'interface SQL commune. L'API du DO est synchrone comme celle de
 * node:sqlite : les stores s'y portent tels quels. Les transactions passent par `transactionSync` (BEGIN/COMMIT sont
 * interdits dans un DO) ; les clés étrangères sont actives par défaut.
 */
export function durableObjectSql(storage: DurableObjectStorage): SqlDb {
  const sql = storage.sql;
  const rowsOf = (query: string, params: SqlParam[]): SqlRow[] => sql.exec(query, ...params.map(bind)).toArray().map(unbind);
  return {
    prepare(query: string): SqlStatement {
      return {
        get: (...params) => rowsOf(query, params)[0],
        all: (...params) => rowsOf(query, params),
        run: (...params) => {
          rowsOf(query, params);
          // Lignes touchées par la dernière instruction (rowsWritten compterait aussi les écritures d'index).
          const changes = sql.exec('SELECT changes() AS n').one().n;
          return { changes: Number(changes) };
        },
      };
    },
    exec: (query) => {
      sql.exec(query).toArray();
    },
    transaction: (work) => storage.transactionSync(work),
    close: () => undefined,
  };
}
