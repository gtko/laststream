import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../user/migrations.js';
import type { SqlDb } from '../../user/sql.js';
import { runtimeEnv } from '../index.js';
import { projectRoot } from './paths.js';

/** Nom du fichier SQLite des données utilisateur, dans LASTADDON_DATA_DIR. */
export const USER_DB_FILE = 'laststream.db';

export { projectRoot };

/**
 * Chemin de la base : LASTADDON_DATA_DIR (relatif à la racine du projet si relatif), sinon ./data. Lu à la demande.
 */
export function userDbPath(): string {
  const raw = runtimeEnv().get('LASTADDON_DATA_DIR')?.trim();
  return join(resolve(projectRoot(), raw ? raw : 'data'), USER_DB_FILE);
}

/**
 * Droits du fichier de base : lecture et écriture pour le seul propriétaire (0600). Sans effet sous Windows, où
 * les permissions POSIX ne s'appliquent pas : l'accès dépend alors des ACL du dossier data/.
 */
function restrictFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Fichier absent ou système de fichiers sans permissions : on ne bloque pas le démarrage.
  }
}

/** Adapte une base node:sqlite à l'interface SQL commune (transaction : BEGIN IMMEDIATE / COMMIT / ROLLBACK). */
export function wrapSqlite(db: DatabaseSync): SqlDb {
  return {
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => statement.run(...params),
      };
    },
    exec: (sql) => db.exec(sql),
    transaction: (work) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}

/** Ouvre la base (':memory:' accepté pour les tests), active les clés étrangères et applique les migrations. */
export function openUserDb(path: string): SqlDb {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const raw = new DatabaseSync(path);
  if (!inMemory) restrictFile(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!inMemory) raw.exec('PRAGMA journal_mode = WAL;');
  const db = wrapSqlite(raw);
  migrate(db);
  return db;
}
