import { env, exports as workerExports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDurableObjectUserBackend } from '../src/platform/workers/user-backend.js';
import type { WorkerEnv } from '../src/platform/workers/env.js';
import type { UserStoreDO } from '../src/platform/workers/user-store-do.js';

const workerEnv = env as unknown as WorkerEnv;
const worker = (workerExports as unknown as { default: { fetch(input: string, init?: RequestInit): Promise<Response> } }).default;

/** Dépôts d'un Durable Object neuf (donc d'une base vide). */
function freshBackend() {
  const name = `store-${crypto.randomUUID()}`;
  return { backend: createDurableObjectUserBackend(workerEnv.USER_STORE, name), stub: workerEnv.USER_STORE.getByName(name) };
}

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2027-01-01T00:00:00.000Z';

async function account(users: ReturnType<typeof freshBackend>['backend'] extends { users(): infer U } ? U : never, username = 'alice') {
  const result = await users.createAccount({ username, passwordHash: 'hash', allowSignup: true, now: NOW });
  if (!result.ok) throw new Error('compte non créé');
  return result.account;
}

const profileFields = { name: 'Greg', avatarColor: '#112233', isKid: false, kidMaxAge: null, pinHash: null, allowedCatalogs: [] };

describe('UserStore sur le SQLite d’un Durable Object', () => {
  it('migrations appliquées au premier appel : base vide', async () => {
    const { backend } = freshBackend();
    expect(await backend.users().countAccounts()).toBe(0);
  });

  it('premier compte propriétaire ; transaction : nom pris et inscription fermée refusés', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const first = await account(users);
    expect(first.isOwner).toBe(true);
    expect(await users.createAccount({ username: 'alice', passwordHash: 'h', allowSignup: true, now: NOW })).toEqual({ ok: false, reason: 'username_taken' });
    expect(await users.createAccount({ username: 'bob', passwordHash: 'h', allowSignup: false, now: NOW })).toEqual({ ok: false, reason: 'signup_disabled' });
    expect(await users.countAccounts()).toBe(1);
  });

  it('sessions : validité, rotation (changes()), plafond par compte, révocation', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.startSession(id, 'h1', NOW, LATER);
    expect((await users.accountForSession('h1', NOW))?.username).toBe('alice');
    expect(await users.accountForSession('h1', '2028-01-01T00:00:00.000Z')).toBeUndefined();
    expect(await users.rotateSession('h1', 'h2', id, NOW, LATER)).toBe(true);
    expect(await users.rotateSession('h1', 'h3', id, NOW, LATER)).toBe(false);
    expect(await users.accountForSession('h1', NOW)).toBeUndefined();
    expect((await users.accountForSession('h2', NOW))?.id).toBe(id);
    for (let i = 0; i < 25; i++) await users.startSession(id, `s${i}`, NOW, LATER);
    expect(await users.accountForSession('s0', NOW)).toBeUndefined();
    expect((await users.accountForSession('s24', NOW))?.id).toBe(id);
    await users.deleteAllSessions(id);
    expect(await users.accountForSession('s24', NOW)).toBeUndefined();
  });

  it('profils : insertion, mise à jour avec PIN en une transaction, suppression (changes())', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.insertProfile(id, 'p1', profileFields, NOW);
    await users.updateProfile(id, 'p1', { name: 'Gregoire', avatarColor: '#445566', isKid: true, kidMaxAge: 12, allowedCatalogs: ['a'] }, 'pin-hash');
    const profile = await users.findProfile(id, 'p1');
    expect(profile).toMatchObject({ name: 'Gregoire', isKid: true, kidMaxAge: 12, hasPin: true, pinVersion: 1, allowedCatalogs: ['a'] });
    expect(await users.deleteProfile(id, 'p1')).toBe(true);
    expect(await users.deleteProfile(id, 'p1')).toBe(false);
  });

  it('PIN : tentatives réservées et blocage', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.insertProfile(id, 'p1', { ...profileFields, pinHash: 'x' }, NOW);
    expect(await users.reservePinAttempt('p1', NOW, LATER, 2)).toBeNull();
    expect(await users.reservePinAttempt('p1', NOW, LATER, 2)).toBeNull();
    expect(await users.reservePinAttempt('p1', NOW, LATER, 2)).toBe(LATER);
    expect(await users.pinLockedUntil('p1', NOW)).toBe(LATER);
    await users.resetPinAttempts('p1');
    expect(await users.pinLockedUntil('p1', NOW)).toBeNull();
  });

  it('suppression du compte : cascade (clés étrangères actives) sur profils, bibliothèque et sessions', async () => {
    const { backend, stub } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.startSession(id, 'h1', NOW, LATER);
    await users.insertProfile(id, 'p1', profileFields, NOW);
    await users.upsertLibraryItem({ profileId: 'p1', type: 'movie', tmdbId: 603, imdbId: null, title: 'Matrix', poster: null, addedAt: NOW });
    await users.deleteAccount(id);
    const counts = await runInDurableObject(stub, (_instance: UserStoreDO, state) => {
      const count = (table: string): number => Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
      return { accounts: count('accounts'), sessions: count('sessions'), profiles: count('profiles'), library: count('library_items') };
    });
    expect(counts).toEqual({ accounts: 0, sessions: 0, profiles: 0, library: 0 });
  });

  it('transaction annulée en cas d’erreur : import partiel sans effet', async () => {
    const { backend, stub } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.insertProfile(id, 'p1', profileFields, NOW);
    const library = [{ profileId: 'p1', type: 'movie' as const, tmdbId: 1, imdbId: null, title: 'Un', poster: null, addedAt: NOW }];
    // Progression sans identifiant TMDB ni IMDb : titleRef lève, après l’écriture de la bibliothèque.
    const progress = [
      { profileId: 'p1', type: 'movie' as const, tmdbId: null, imdbId: null, season: 0, episode: 0, positionSec: 1, durationSec: 2, updatedAt: NOW, finished: false },
    ];
    // Appel dans le contexte du DO : l'erreur est attrapée sur place (le RPC la remonterait à l'appelant).
    await runInDurableObject(stub, (instance: UserStoreDO) => {
      expect(() => instance.user('importMany', [library, progress])).toThrow(/identifiant TMDB ou IMDb requis/);
    });
    expect(await users.listLibrary('p1', undefined, 'added')).toEqual([]);
  });

  it('progression : ignore une écriture plus ancienne, « continuer à regarder » (Map via RPC)', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.insertProfile(id, 'p1', profileFields, NOW);
    const write = { profileId: 'p1', type: 'series' as const, tmdbId: 10, imdbId: null, season: 1, episode: 2, durationSec: 100, finished: false };
    await users.upsertProgress({ ...write, positionSec: 50, updatedAt: LATER });
    await users.upsertProgress({ ...write, positionSec: 10, updatedAt: NOW });
    expect((await users.progressEpisode('p1', 'series', 'tmdb:10', 1, 2))?.positionSec).toBe(50);
    expect((await users.latestProgressPerTitle('p1')).map((item) => item.titleRef)).toEqual(['tmdb:10']);
    await users.hideContinue('p1', 'series', 'tmdb:10', LATER);
    const hidden = await users.hiddenContinue('p1');
    expect(hidden).toBeInstanceOf(Map);
    expect(hidden.get('series|tmdb:10')).toBe(LATER);
  });

  it('réglages : fusion, suppression par null, JSON relu', async () => {
    const { backend } = freshBackend();
    const users = backend.users();
    const { id } = await account(users);
    await users.insertProfile(id, 'p1', profileFields, NOW);
    await users.writeSettings('p1', [['lang', 'fr'], ['ui', { dark: true }]]);
    await users.writeSettings('p1', [['lang', null]]);
    expect(await users.listSettings('p1')).toEqual({ ui: { dark: true } });
  });
});

describe('SkipSegmentStore sur le SQLite d’un Durable Object', () => {
  const proposal = { imdbId: 'tt0000001', season: 1, episode: 1, kind: 'intro' as const, start: 10, end: 50, duration: 1200 };

  it('propositions, vote négatif (transaction) et segments agrégés', async () => {
    const { backend } = freshBackend();
    const skips = backend.skips();
    await skips.propose(proposal, NOW);
    await skips.propose({ ...proposal, start: 12, end: 52 }, NOW);
    expect(await skips.segmentsFor('tt0000001', 1, 1)).toHaveLength(1);
    expect(await skips.dispute(proposal)).toBe(2);
    expect(await skips.dispute(proposal)).toBe(2);
    // Deux voix contre, une pour chacune : les propositions disparaissent.
    expect(await skips.segmentsFor('tt0000001', 1, 1)).toEqual([]);
    expect(await skips.durationOf('tt0000001', 1, 1)).toBe(1200);
  });

  it('segments détectés : remplacés seulement si la confiance ne baisse pas', async () => {
    const { backend } = freshBackend();
    const skips = backend.skips();
    const auto = { kind: 'intro' as const, start: 5, end: 40, confidence: 0.8, method: 'fingerprint' as const };
    expect(await skips.saveAuto('tt0000002', 1, 1, 1300, auto, NOW)).toBe(true);
    expect(await skips.saveAuto('tt0000002', 1, 1, 1300, { ...auto, confidence: 0.5 }, NOW)).toBe(false);
    expect(await skips.saveAuto('tt0000002', 1, 1, 1300, { ...auto, start: 6, confidence: 0.95, method: 'chapters' }, NOW)).toBe(true);
    expect(await skips.autoSegmentsFor('tt0000002', 1, 1)).toEqual([{ kind: 'intro', start: 6, end: 40, confidence: 0.95, method: 'chapters' }]);
  });

  it('empreintes (BLOB) : aller-retour octet pour octet', async () => {
    const { backend } = freshBackend();
    const skips = backend.skips();
    const points = new Uint32Array([1, 2, 0xdeadbeef, 4_000_000_000]);
    await skips.saveFingerprint('tt0000003', 1, { kind: 'intro', method: 'spectral', points }, NOW);
    const [found] = await skips.fingerprintsFor('tt0000003', 1, 'spectral');
    expect(found?.kind).toBe('intro');
    expect([...(found?.points ?? [])]).toEqual([...points]);
  });
});

describe('Durable Object : surface RPC', () => {
  it('seules les méthodes des stores sont appelables (pas de transaction, close ni interne)', async () => {
    const { stub } = freshBackend();
    // Appels faits dans le contexte du DO : l'erreur est attrapée sur place (le RPC la remonterait à l'appelant).
    await runInDurableObject(stub, (instance: UserStoreDO) => {
      for (const method of ['transaction', 'close', 'constructor', 'createSession', 'updateProfileFields', 'inconnue']) {
        expect(() => instance.user(method, [])).toThrow(/méthode inconnue/);
      }
      expect(() => instance.skip('close', [])).toThrow(/méthode inconnue/);
      expect(() => instance.skip('constructor', [])).toThrow(/méthode inconnue/);
    });
  });

  it('chaque nom de Durable Object a sa propre base', async () => {
    const a = freshBackend();
    const b = freshBackend();
    await account(a.backend.users());
    expect(await a.backend.users().countAccounts()).toBe(1);
    expect(await b.backend.users().countAccounts()).toBe(0);
  });

  it('Worker complet : /user/register puis /user/login sur le Durable Object « users »', async () => {
    const register = await worker.fetch('https://core.test/user/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'mot-de-passe-test-1' }),
    });
    expect(register.status).toBe(201);
    const login = await worker.fetch('https://core.test/user/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'mot-de-passe-test-1' }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ token: expect.any(String) });
  });
});
