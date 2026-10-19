import { env, exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDurableObjectUserBackend, USER_STORE_NAME } from '../src/platform/workers/user-backend.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import type { UserStoreDO } from '../src/platform/workers/user-store-do.js';
import type { ProfileFields, ProgressWrite } from '../src/user/store.js';
import { shiftDay } from '../src/user/title-starts.js';

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;

/** Dépôts d'un Durable Object neuf (donc d'une base vide, migrations appliquées). */
function freshBackend() {
  const name = `starts-${crypto.randomUUID()}`;
  return { backend: createDurableObjectUserBackend(workerEnv.USER_STORE, name), stub: workerEnv.USER_STORE.getByName(name) };
}

const NOW = '2026-01-01T10:00:00.000Z';
const DAY = '2026-01-01';

const fields: ProfileFields = { name: 'Greg', avatarColor: '#112233', avatar: null, isKid: false, kidMaxAge: null, pinHash: null, allowedCatalogs: [] };

async function account(backend: ReturnType<typeof freshBackend>['backend'], username: string, profileId: string): Promise<string> {
  const users = backend.users();
  const result = await users.createAccount({ username, passwordHash: 'hash', allowSignup: true, now: NOW });
  if (!result.ok) throw new Error('compte non créé');
  await users.insertProfile(result.account.id, profileId, fields, NOW);
  return profileId;
}

function progress(overrides: Partial<ProgressWrite> & Pick<ProgressWrite, 'profileId'>): ProgressWrite {
  return {
    type: 'movie',
    tmdbId: 550,
    imdbId: null,
    season: 0,
    episode: 0,
    positionSec: 10,
    durationSec: 100,
    updatedAt: NOW,
    finished: false,
    country: 'CH',
    ...overrides,
  };
}

interface StartRow {
  day: string;
  country: string;
  key: string;
  n: number;
}

/** Lignes de l'agrégat, lues dans le SQLite du Durable Object. */
function startRows(stub: ReturnType<typeof freshBackend>['stub']): Promise<StartRow[]> {
  return runInDurableObject(stub, (_instance: UserStoreDO, state) =>
    state.storage.sql.exec('SELECT day, country, key, n FROM title_starts ORDER BY day, country, key').toArray(),
  ) as Promise<StartRow[]>;
}

describe('lancements de titres sur le SQLite d’un Durable Object', () => {
  it('première progression : n = 1 ; autre épisode du même compte : toujours 1 ; deuxième compte : 2', async () => {
    const { backend, stub } = freshBackend();
    const users = backend.users();
    const alice = await account(backend, 'alice', 'alice-p1');
    const bob = await account(backend, 'bob', 'bob-p1');
    const series = { type: 'series' as const, tmdbId: 1399 };
    await users.upsertProgress(progress({ profileId: alice, ...series, season: 1, episode: 1 }));
    await users.upsertProgress(progress({ profileId: alice, ...series, season: 1, episode: 2, updatedAt: '2026-01-01T11:00:00.000Z' }));
    expect(await startRows(stub)).toEqual([{ day: DAY, country: 'CH', key: 'series|tmdb:1399', n: 1 }]);
    await users.upsertProgress(progress({ profileId: bob, ...series, season: 1, episode: 1 }));
    expect(await startRows(stub)).toEqual([{ day: DAY, country: 'CH', key: 'series|tmdb:1399', n: 2 }]);
  });

  it('topStarts : seuil de 3 comptes, cumul sur la fenêtre, tri décroissant, pays filtré', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const [a1, a2, a3] = [
      await account(backend, 'a1', 'a1-p1'),
      await account(backend, 'a2', 'a2-p1'),
      await account(backend, 'a3', 'a3-p1'),
    ];
    const yesterday = shiftDay(DAY, -1);
    // movie:1 : 3 comptes aujourd’hui. movie:2 : 2 comptes hier, 1 aujourd’hui (3 sur la fenêtre). movie:3 en FR : 2 comptes.
    for (const profileId of [a1, a2, a3]) await users.upsertProgress(progress({ profileId, tmdbId: 1 }));
    await users.upsertProgress(progress({ profileId: a1, tmdbId: 2, updatedAt: `${yesterday}T10:00:00.000Z` }));
    await users.upsertProgress(progress({ profileId: a2, tmdbId: 2, updatedAt: `${yesterday}T11:00:00.000Z` }));
    await users.upsertProgress(progress({ profileId: a3, tmdbId: 2 }));
    await users.upsertProgress(progress({ profileId: a1, tmdbId: 3, country: 'FR' }));
    await users.upsertProgress(progress({ profileId: a2, tmdbId: 3, country: 'FR' }));
    expect(await users.topStarts('CH', yesterday, 10)).toEqual([
      { key: 'movie|tmdb:1', n: 3 },
      { key: 'movie|tmdb:2', n: 3 },
    ]);
    expect(await users.topStarts('CH', DAY, 10)).toEqual([{ key: 'movie|tmdb:1', n: 3 }]);
    expect(await users.topStarts('FR', yesterday, 10)).toEqual([]);
  });

  it('rétention : lignes de plus de 90 jours retirées à l’écriture d’un lancement', async () => {
    const { backend, stub } = freshBackend();
    const users = backend.users();
    const alice = await account(backend, 'alice', 'alice-p1');
    await runInDurableObject(stub, (_instance: UserStoreDO, state) => {
      for (const [day, key] of [
        ['2025-10-02', 'movie|tmdb:9'],
        ['2025-10-03', 'movie|tmdb:8'],
        ['2025-12-01', 'movie|tmdb:7'],
      ] as const) {
        state.storage.sql.exec('INSERT INTO title_starts (day, country, key, n) VALUES (?, ?, ?, ?)', day, 'CH', key, 5);
      }
    });
    await users.upsertProgress(progress({ profileId: alice, tmdbId: 550 }));
    expect((await startRows(stub)).map((row) => row.key).sort()).toEqual(['movie|tmdb:550', 'movie|tmdb:7', 'movie|tmdb:8']);
  });
});

describe('Worker complet : progression sans pays de l’hôte', () => {
  it('PUT /user/profiles/:id/progress sans request.cf : lancement compté sous XX', async () => {
    const username = `starts-${crypto.randomUUID().slice(0, 8)}`;
    const jsonHeaders = { 'content-type': 'application/json' };
    const register = await worker.fetch('https://core.test/user/register', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ username, password: 'mot-de-passe-test-1' }),
    });
    expect(register.status).toBe(201);
    const login = await worker.fetch('https://core.test/user/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ username, password: 'mot-de-passe-test-1' }),
    });
    const { token } = (await login.json()) as { token: string };
    const authorized = { ...jsonHeaders, authorization: `Bearer ${token}` };
    const created = await worker.fetch('https://core.test/user/profiles', { method: 'POST', headers: authorized, body: JSON.stringify({ name: 'Greg' }) });
    const { id } = (await created.json()) as { id: string };
    const put = await worker.fetch(`https://core.test/user/profiles/${id}/progress`, {
      method: 'PUT',
      headers: authorized,
      body: JSON.stringify({ type: 'movie', tmdbId: 550, positionSec: 10, durationSec: 100 }),
    });
    expect(put.status).toBe(200);
    const rows = await startRows(workerEnv.USER_STORE.getByName(USER_STORE_NAME));
    expect(rows.filter((row) => row.key === 'movie|tmdb:550')).toEqual([{ day: expect.any(String), country: 'XX', key: 'movie|tmdb:550', n: 1 }]);
  });
});
