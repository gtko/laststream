import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUserDb, projectRoot, userDbPath, USER_DB_FILE, wrapSqlite } from '../src/platform/node/user-db.js';
import type { SqlDb } from '../src/user/sql.js';
import {
  generateSessionToken,
  hashSecret,
  hashSessionToken,
  PROFILE_TOKEN_TTL_MS,
  signProfileToken,
  verifyProfileToken,
  verifySecret,
} from '../src/user/crypto.js';
import { migrate, type Migration, MIGRATIONS } from '../src/user/migrations.js';
import { continueWatching, isFinished, normalizeProgress } from '../src/user/progress.js';
import { titleRef, type ProgressItem } from '../src/user/store.js';
import { parseWith, UserApiError, credentialsSchema } from '../src/user/validation.js';
import { z } from 'zod';

const SECRET = 'user-db-test-secret-with-more-than-32-chars';

afterEach(() => {
  vi.unstubAllEnvs();
});

function tableNames(db: SqlDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );
}

describe('base de données utilisateur', () => {
  it('ouverture : schéma créé, migration tracée une seule fois, réouverture sans effet', () => {
    const db = openUserDb(':memory:');
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['accounts', 'sessions', 'profiles', 'library_items', 'progress', 'settings', 'schema_migrations']),
    );
    migrate(db);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as { version: number }[];
    expect(rows.map((row) => row.version)).toEqual(MIGRATIONS.map((migration) => migration.version));
  });

  it('une migration en échec est annulée entièrement et non tracée', () => {
    const db = wrapSqlite(new DatabaseSync(':memory:'));
    const broken: Migration[] = [{ version: 1, name: 'cassée', sql: 'CREATE TABLE partielle (a INTEGER); CE N EST PAS DU SQL;' }];
    expect(() => migrate(db, broken)).toThrow();
    expect(tableNames(db)).not.toContain('partielle');
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(0);
  });

  it('une base dont la version dépasse celle du code est refusée', () => {
    const db = openUserDb(':memory:');
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, ?, ?)').run('futur', new Date().toISOString());
    expect(() => migrate(db)).toThrow(/version de schéma inconnue/);
  });

  it('chemin par défaut : data/laststream.db à la racine du projet', () => {
    vi.stubEnv('LASTADDON_DATA_DIR', '');
    expect(userDbPath()).toBe(join(resolve(projectRoot(), 'data'), USER_DB_FILE));
  });

  it('LASTADDON_DATA_DIR relatif (à la racine du projet) ou absolu', () => {
    vi.stubEnv('LASTADDON_DATA_DIR', 'mes-donnees');
    expect(userDbPath()).toBe(join(resolve(projectRoot(), 'mes-donnees'), USER_DB_FILE));
    const absolute = resolve(tmpdir(), 'lastaddon-abs');
    vi.stubEnv('LASTADDON_DATA_DIR', absolute);
    expect(userDbPath()).toBe(join(absolute, USER_DB_FILE));
  });

  it('fichier : dossier créé à la demande, WAL activé', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-db-'));
    const file = join(dir, 'sous', 'laststream.db');
    try {
      const db = openUserDb(file);
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('primitives cryptographiques', () => {
  it('scrypt : vérification juste, mauvais secret refusé, hash salé et format stable', async () => {
    const stored = await hashSecret('1234');
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifySecret('1234', stored)).toBe(true);
    expect(await verifySecret('4321', stored)).toBe(false);
    expect(await hashSecret('1234')).not.toBe(stored);
  });

  it('hash de format invalide : refusé sans exception', async () => {
    expect(await verifySecret('x', 'pas-un-hash')).toBe(false);
    expect(await verifySecret('x', 'scrypt$1$1$1$AAAA$AAAA')).toBe(false);
  });

  it('jeton de session : 32 octets base64url, empreinte SHA-256 hexadécimale stable', () => {
    const token = generateSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('jeton de profil : valide pour exactement ses claims, expire, refusé si altéré', () => {
    const now = Date.parse('2025-01-01T00:00:00.000Z');
    const claims = { accountId: 'acc-1', profileId: 'prof-1', sessionHash: 'sess-1', pinVersion: 0 };
    const { token } = signProfileToken(claims, now, SECRET);
    expect(verifyProfileToken(token, claims, now, SECRET)).toBe(true);
    expect(verifyProfileToken(token, { ...claims, profileId: 'prof-2' }, now, SECRET)).toBe(false);
    expect(verifyProfileToken(token, { ...claims, accountId: 'acc-2' }, now, SECRET)).toBe(false);
    expect(verifyProfileToken(token, { ...claims, sessionHash: 'autre-session' }, now, SECRET)).toBe(false);
    expect(verifyProfileToken(token, { ...claims, pinVersion: 1 }, now, SECRET)).toBe(false);
    expect(verifyProfileToken(token, claims, now + PROFILE_TOKEN_TTL_MS, SECRET)).toBe(false);
    expect(verifyProfileToken(token, claims, now, 'autre-secret-avec-plus-de-trente-deux-car')).toBe(false);
    const [body, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ purpose: 'profile-unlock', ...claims, exp: now + 1e9 }),
    ).toString('base64url');
    expect(verifyProfileToken(`${forged}.${signature}`, claims, now, SECRET)).toBe(false);
    expect(verifyProfileToken(`${body}.`, claims, now, SECRET)).toBe(false);
    expect(verifyProfileToken('pas-un-jeton', claims, now, SECRET)).toBe(false);
  });

  it('migration v2 appliquée à une base v1 existante : données conservées, colonnes PIN ajoutées', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-v2-'));
    const file = join(dir, 'laststream.db');
    try {
      const old = wrapSqlite(new DatabaseSync(file));
      migrate(old, MIGRATIONS.slice(0, 1));
      old.prepare("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('a1', 'alice', 'h', 1, 't')").run();
      old.prepare("INSERT INTO profiles (id, account_id, name, avatar_color, created_at) VALUES ('p1', 'a1', 'Greg', '#000000', 't')").run();
      old.close();

      const upgraded = openUserDb(file);
      try {
        expect(upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n).toBe(MIGRATIONS.length);
        const row = upgraded.prepare('SELECT name, pin_failures, pin_locked_until, pin_version FROM profiles').get();
        expect(row).toEqual({ name: 'Greg', pin_failures: 0, pin_locked_until: null, pin_version: 0 });
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fichier de base : droits 0600 sous POSIX (sans effet sous Windows)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-mode-'));
    const file = join(dir, 'laststream.db');
    try {
      openUserDb(file).close();
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('règles de progression', () => {
  it('finie à partir de 90 % de la durée ; durée inconnue : jamais finie', () => {
    expect(isFinished(90, 100)).toBe(true);
    expect(isFinished(89.9, 100)).toBe(false);
    expect(isFinished(500, 0)).toBe(false);
  });

  it('normalisation : film sans saison ni épisode ; position bornée à la durée', () => {
    const movie = normalizeProgress({ type: 'movie', tmdbId: 603, season: 3, episode: 4, positionSec: 150, durationSec: 100 });
    expect(movie).toMatchObject({ season: 0, episode: 0, positionSec: 100, finished: true, tmdbId: 603, imdbId: null });
    const series = normalizeProgress({ type: 'series', imdbId: 'tt0944947', season: 1, episode: 2, positionSec: 10, durationSec: 0 });
    expect(series).toMatchObject({ season: 1, episode: 2, positionSec: 10, durationSec: 0, finished: false });
  });

  it('continuer : limite respectée, films terminés ignorés', async () => {
    const row = (tmdbId: number, finished: boolean, updatedAt: string): ProgressItem => ({
      type: 'movie',
      tmdbId,
      imdbId: null,
      season: 0,
      episode: 0,
      positionSec: finished ? 100 : 10,
      durationSec: 100,
      updatedAt,
      finished,
      titleRef: titleRef(tmdbId, null),
    });
    const latest = [row(1, false, '2025-01-03T00:00:00.000Z'), row(2, true, '2025-01-02T00:00:00.000Z'), row(3, false, '2025-01-01T00:00:00.000Z')];
    const items = await continueWatching(latest, () => undefined, 1);
    expect(items.map((item) => item.tmdbId)).toEqual([1]);
    expect((await continueWatching(latest, () => undefined)).map((item) => item.tmdbId)).toEqual([1, 3]);
  });
});

describe('validation', () => {
  it('corps valide : renvoyé typé ; corps invalide : UserApiError 400 avec chemins seulement', () => {
    expect(parseWith(credentialsSchema, { username: 'Alice', password: 'mot-de-passe-1' })).toEqual({
      username: 'alice',
      password: 'mot-de-passe-1',
    });
    try {
      parseWith(z.object({ name: z.string().min(3) }), { name: 'ab' });
      expect.unreachable('une erreur de validation était attendue');
    } catch (err) {
      expect(err).toBeInstanceOf(UserApiError);
      expect((err as UserApiError).status).toBe(400);
      expect((err as UserApiError).issues).toEqual(['name:too_small']);
    }
  });
});
