import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimeEnv } from '../platform/index.js';
import { projectRoot } from '../platform/node/paths.js';
import { migrate } from './migrations.js';

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

/** Ouvre la base (':memory:' accepté pour les tests), active les clés étrangères et applique les migrations. */
export function openUserDb(path: string): DatabaseSync {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (!inMemory) restrictFile(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}
