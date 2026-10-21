import type { DurableObjectStub } from '@cloudflare/workers-types';
import { env, exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDurableObjectUserBackend, USER_STORE_NAME } from '../src/platform/workers/user-backend.js';
import { durableObjectSql } from '../src/platform/workers/sql.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import type { UserStoreDO } from '../src/platform/workers/user-store-do.js';
import { migrate } from '../src/user/migrations.js';
import { nowIso } from '../src/user/session.js';

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;
const PASSWORD = 'mot-de-passe-test-1';
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Base de production : schéma des migrations 1 à 23 (social v3), puis code actuel au démarrage du Durable Object. Les
 * objets des migrations 24 à 30 (annonces, boîte écartée, invitations révoquées, sessions UA, invitations du foyer,
 * billets de parrainage, marquage « vu » manuel, compte Molotov) sont retirés, la table des versions est ramenée à 23,
 * puis `migrate` est rejoué comme au constructeur du Durable Object.
 */
function rollBackTo23(stub: DurableObjectStub<UserStoreDO>): Promise<void> {
  return runInDurableObject(stub, (_instance: UserStoreDO, state) => {
    const sql = state.storage.sql;
    sql.exec('DROP TABLE IF EXISTS announcements');
    sql.exec('DROP TABLE IF EXISTS inbox_dismissed');
    sql.exec('ALTER TABLE invites DROP COLUMN revoked_at');
    sql.exec('ALTER TABLE sessions DROP COLUMN user_agent');
    sql.exec('ALTER TABLE sessions DROP COLUMN last_seen_at');
    sql.exec('DROP TABLE IF EXISTS profile_logins');
    sql.exec('DROP TABLE IF EXISTS household_invites');
    sql.exec('ALTER TABLE sessions DROP COLUMN profile_id');
    sql.exec('ALTER TABLE invites DROP COLUMN auto_friend');
    sql.exec('ALTER TABLE invites DROP COLUMN expires_at');
    sql.exec('ALTER TABLE invites DROP COLUMN picks');
    sql.exec('ALTER TABLE invites DROP COLUMN message');
    sql.exec('ALTER TABLE progress DROP COLUMN manual');
    sql.exec('DROP TABLE IF EXISTS molotov_accounts');
    sql.exec('DELETE FROM schema_migrations WHERE version >= 24');
  });
}

function restartWithCurrentCode(stub: DurableObjectStub<UserStoreDO>): Promise<void> {
  return runInDurableObject(stub, (_instance: UserStoreDO, state) => {
    migrate(durableObjectSql(state.storage));
  });
}

function versionsApplied(stub: DurableObjectStub<UserStoreDO>): Promise<number[]> {
  return runInDurableObject(stub, (_instance: UserStoreDO, state) =>
    state.storage.sql
      .exec('SELECT version FROM schema_migrations ORDER BY version')
      .toArray()
      .map((row) => Number(row.version)),
  ) as Promise<number[]>;
}

describe('base migrée jusqu’à 23 (social v3), puis code actuel : annonces sous Workers', () => {
  it('GET /announcements répond 200 avec une liste vide, sans erreur', async () => {
    const username = `ann-${crypto.randomUUID().slice(0, 8)}`;
    const register = await worker.fetch('https://core.test/user/register', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(register.status).toBe(201);
    const login = await worker.fetch('https://core.test/user/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(login.status).toBe(200);

    const stub = workerEnv.USER_STORE.getByName(USER_STORE_NAME);
    await rollBackTo23(stub);
    await restartWithCurrentCode(stub);
    expect(await versionsApplied(stub)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    // Diagnostic direct de la méthode RPC : son erreur réelle (message) apparaît ici si elle échoue.
    const backend = createDurableObjectUserBackend(workerEnv.USER_STORE, USER_STORE_NAME);
    expect(await backend.admin().listActiveAnnouncements(nowIso())).toEqual([]);

    const res = await worker.fetch('https://core.test/announcements', { headers: { origin: 'capacitor://localhost' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ announcements: [] });
  });
});
