import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/platform/workers/env.js';

/**
 * Alarme des soirées planifiées (LAST-198, lot L3) dans un vrai Durable Object : une écriture pose l'alarme au prochain réveil
 * utile, l'alarme marque le rappel T-15 min une seule fois (un réveil rejoué n'en émet pas un second) et se repose ensuite.
 * Les profils sont insérés en SQL brut (le store des soirées ne crée ni comptes ni amitiés).
 */

const workerEnv = env as unknown as WorkerEnv;
const MIN = 60_000;

const HOST = 'HOSTPIDAAAAAAAAA';
const GUEST = 'GUESTPIDAAAAAAAA';

interface Fresh {
  stub: ReturnType<WorkerEnv['USER_STORE']['getByName']>;
  /** Appelle une méthode d'EveningStore par la voie RPC du Worker. */
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
}

/** Durable Object neuf avec deux amis adultes de comptes différents. */
async function seeded(): Promise<Fresh> {
  const stub = workerEnv.USER_STORE.getByName(`evenings-${crypto.randomUUID()}`);
  await stub.healthPing();
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    for (const [id, username] of [
      ['acc-host', 'host'],
      ['acc-guest', 'guest'],
    ] as const) {
      sql.exec("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'h', 0, '2026-01-01')", id, username);
    }
    for (const [id, account, pid, name] of [
      ['p-host', 'acc-host', HOST, 'Host'],
      ['p-guest', 'acc-guest', GUEST, 'Guest'],
    ] as const) {
      sql.exec(
        `INSERT INTO profiles (id, account_id, name, avatar_color, is_kid, kid_max_age, allowed_catalogs, created_at, pid, handle_name, handle_key, handle_tag)
         VALUES (?, ?, ?, '#00ff00', 0, NULL, '[]', '2026-01-02T00:00:00.000Z', ?, ?, ?, 'T001')`,
        id,
        account,
        name,
        pid,
        name,
        name.toLowerCase(),
      );
    }
    const [low, high] = HOST < GUEST ? [HOST, GUEST] : [GUEST, HOST];
    sql.exec("INSERT INTO profile_friendships (low_pid, high_pid, requested_by, status, created_at) VALUES (?, ?, ?, 'accepted', ?)", low, high, HOST, Date.now());
  });
  return { stub, call: (method, ...args) => stub.socialEvenings(method, args) };
}

const alarmOf = (stub: Fresh['stub']): Promise<number | null> => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

const remindedAt = (stub: Fresh['stub']): Promise<(number | null)[]> =>
  runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT reminded_at FROM evenings ORDER BY starts_at').toArray().map((row) => row.reminded_at as number | null));

describe('alarme des soirées (Durable Object)', () => {
  it('une soirée créée pose l alarme à T-15 min ; sans soirée, aucune alarme', async () => {
    const { stub, call } = await seeded();
    expect(await alarmOf(stub)).toBeNull();
    const startsAt = Date.now() + 60 * MIN;
    const created = (await call('create', HOST, { title: 'Alarme', startsAt, tz: 'Europe/Paris', guests: [GUEST] }, Date.now())) as { result: string };
    expect(created.result).toBe('ok');
    const alarm = await alarmOf(stub);
    expect(alarm).not.toBeNull();
    expect(alarm).toBeLessThanOrEqual(startsAt - 15 * MIN);
    expect(alarm).toBeGreaterThan(Date.now());
  });

  it('l alarme marque le rappel une seule fois : un réveil rejoué ne le répète pas, et l alarme est reposée', async () => {
    const { stub, call } = await seeded();
    const startsAt = Date.now() + 10 * MIN;
    await call('create', HOST, { title: 'Bientôt', startsAt, tz: 'Europe/Paris', guests: [GUEST] }, Date.now());
    // Début dans 10 minutes : le rappel est déjà dû, l'alarme est posée tout de suite.
    expect(await remindedAt(stub)).toEqual([null]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const [first] = await remindedAt(stub);
    expect(first).toEqual(expect.any(Number));
    // Réveil rejoué : le rappel n'est pas marqué une seconde fois.
    await runDurableObjectAlarm(stub);
    expect(await remindedAt(stub)).toEqual([first]);
    // Prochain réveil : le début de la soirée (renouvellement de la fenêtre des séries).
    expect(await alarmOf(stub)).toBe(startsAt);
  });

  it('une soirée annulée n est jamais rappelée et libère l alarme', async () => {
    const { stub, call } = await seeded();
    const created = (await call('create', HOST, { title: 'Annulée', startsAt: Date.now() + 10 * MIN, tz: 'Europe/Paris', guests: [GUEST] }, Date.now())) as {
      evening: { id: string };
    };
    await call('cancel', HOST, created.evening.id, 'occurrence', Date.now());
    await runDurableObjectAlarm(stub);
    expect(await remindedAt(stub)).toEqual([null]);
    expect(await alarmOf(stub)).toBeNull();
  });
});
