import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrations.js';

/** Nom du fichier SQLite des données utilisateur, dans LASTADDON_DATA_DIR. */
export const USER_DB_FILE = 'laststream.db';

/** Racine du projet (src/user ou dist/user : deux niveaux au-dessus). */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Chemin de la base : LASTADDON_DATA_DIR (relatif à la racine du projet si relatif), sinon ./data. Lu à la demande.
 */
export function userDbPath(): string {
  const raw = process.env.LASTADDON_DATA_DIR?.trim();
  return join(resolve(projectRoot(), raw ? raw : 'data'), USER_DB_FILE);
}

/** Ouvre la base (':memory:' accepté pour les tests), active les clés étrangères et applique les migrations. */
export function openUserDb(path: string): DatabaseSync {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}
