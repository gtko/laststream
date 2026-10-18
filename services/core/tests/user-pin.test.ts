import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, mockUpstream, startApp } from './lt-harness.js';
import { type ErrorBody, loginAs, PASSWORD, request, createProfileVia } from './user-harness.js';

interface ProfileBody {
  id: string;
  hasPin: boolean;
  isKid: boolean;
  kidMaxAge: number | null;
  pinVersion?: number;
  pinHash?: string;
}

interface UnlockBody {
  token: string;
  expiresAt: string;
}

const PIN = '1111';
const WRONG = '0000';
const LOCK_MS = 5 * 60_000;

let app: RunningApp;
let token: string;
let protectedId: string;
let openId: string;
const T0 = Date.parse('2025-06-01T12:00:00.000Z');

beforeEach(async () => {
  app = await startApp({ fetch: mockUpstream({}).fetch });
  await request(app, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
  token = await loginAs(app, 'alice');
  // Le premier profil (sans PIN) est le principal : c'est lui qui crée les suivants.
  openId = (await createProfileVia(app, token, { name: 'Libre' })).body.id;
  protectedId = (await createProfileVia(app, token, { name: 'Protégé', pin: PIN })).body.id;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await app.close();
});

function setClock(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

async function unlock(pin: string, profileId = protectedId, bearer = token) {
  return request<UnlockBody | ErrorBody>(app, 'POST', `/user/profiles/${profileId}/unlock`, { token: bearer, body: { pin } });
}

async function unlockToken(): Promise<string> {
  const res = await unlock(PIN);
  expect(res.status).toBe(200);
  return (res.body as UnlockBody).token;
}

/** Appels de données d'un profil : chacun doit exiger le jeton de profil quand le profil est protégé. */
function dataCalls(id: string): { name: string; method: string; path: string; body?: unknown }[] {
  return [
    { name: 'library GET', method: 'GET', path: `/user/profiles/${id}/library` },
    { name: 'library PUT', method: 'PUT', path: `/user/profiles/${id}/library/movie/603`, body: { title: 'Matrix' } },
    { name: 'library DELETE', method: 'DELETE', path: `/user/profiles/${id}/library/movie/603` },
    { name: 'progress PUT', method: 'PUT', path: `/user/profiles/${id}/progress`, body: { type: 'movie', tmdbId: 603, positionSec: 1, durationSec: 10 } },
    { name: 'continue GET', method: 'GET', path: `/user/profiles/${id}/continue` },
    { name: 'progress GET', method: 'GET', path: `/user/profiles/${id}/progress/movie/603` },
    { name: 'settings GET', method: 'GET', path: `/user/profiles/${id}/settings` },
    { name: 'settings PUT', method: 'PUT', path: `/user/profiles/${id}/settings`, body: { theme: 'dark' } },
    { name: 'import', method: 'POST', path: `/user/profiles/${id}/import/stremio`, body: { email: 'a@b.test', password: 'x' } },
    { name: 'watched PUT', method: 'PUT', path: `/user/profiles/${id}/watched`, body: { type: 'movie', tmdbId: 603, watched: true } },
    { name: 'watched GET', method: 'GET', path: `/user/profiles/${id}/watched/movie/603` },
    { name: 'continue DELETE', method: 'DELETE', path: `/user/profiles/${id}/continue/movie/603` },
    { name: 'follows GET', method: 'GET', path: `/user/profiles/${id}/follows` },
    { name: 'follows PUT', method: 'PUT', path: `/user/profiles/${id}/follows/movie/603`, body: { title: 'Matrix' } },
    { name: 'follows DELETE', method: 'DELETE', path: `/user/profiles/${id}/follows/movie/603` },
    { name: 'ratings GET', method: 'GET', path: `/user/profiles/${id}/ratings` },
    { name: 'ratings PUT', method: 'PUT', path: `/user/profiles/${id}/ratings/movie/603`, body: { rating: 4 } },
    { name: 'ratings DELETE', method: 'DELETE', path: `/user/profiles/${id}/ratings/movie/603` },
  ];
}

describe('PIN : blocage après 5 échecs', () => {
  it('quatre échecs : 403 invalid_pin ; le cinquième bloque 5 minutes (429 pin_locked, Retry-After)', async () => {
    setClock(T0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await unlock(WRONG);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'invalid_pin' });
    }
    const fifth = await unlock(WRONG);
    expect(fifth.status).toBe(429);
    expect(fifth.body).toEqual({ error: 'pin_locked' });
    expect(Number(fifth.headers.get('retry-after'))).toBeGreaterThan(290);
    expect(Number(fifth.headers.get('retry-after'))).toBeLessThanOrEqual(300);
  });

  it('pendant le blocage, même le bon PIN est refusé sans vérification (429), et rien n est recompté', async () => {
    setClock(T0);
    for (let attempt = 0; attempt < 5; attempt += 1) await unlock(WRONG);
    setClock(T0 + 4 * 60_000);
    expect((await unlock(PIN)).status).toBe(429);
    expect((await unlock(WRONG)).status).toBe(429);
    // Après le blocage, une nouvelle série repart de zéro : un échec donne 403, pas 429.
    setClock(T0 + LOCK_MS + 1000);
    expect((await unlock(WRONG)).status).toBe(403);
  });

  it('bon PIN après la fin du blocage : jeton renvoyé, compteur remis à zéro', async () => {
    setClock(T0);
    for (let attempt = 0; attempt < 5; attempt += 1) await unlock(WRONG);
    setClock(T0 + LOCK_MS + 1000);
    expect((await unlock(PIN)).status).toBe(200);
    // Le succès a remis le compteur à zéro : quatre échecs ne bloquent plus.
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await unlock(WRONG)).status).toBe(403);
  });

  it('un bon PIN réinitialise les échecs : trois échecs, un succès, puis quatre échecs ne bloquent pas', async () => {
    setClock(T0);
    for (let attempt = 0; attempt < 3; attempt += 1) await unlock(WRONG);
    expect((await unlock(PIN)).status).toBe(200);
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await unlock(WRONG)).status).toBe(403);
    expect((await unlock(WRONG)).status).toBe(429);
  });

  it('le blocage est propre au profil : l autre profil reste déverrouillable par son propre code', async () => {
    setClock(T0);
    for (let attempt = 0; attempt < 5; attempt += 1) await unlock(WRONG);
    const other = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${openId}`, { token, headers: { 'x-profile-id': openId }, body: { pin: '2222' } });
    expect(other.status).toBe(200);
    expect((await unlock('2222', openId)).status).toBe(200);
  });

  it('profil sans PIN : 409 pin_not_set, et aucune tentative n est comptée', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await unlock(WRONG, openId);
      expect(res.status).toBe(409);
    }
  });
});

describe('PIN : toutes les routes de données exigent le jeton de profil', () => {
  it('sans jeton : 403 pin_required sur chaque route de données du profil protégé', async () => {
    for (const call of dataCalls(protectedId)) {
      const res = await request<ErrorBody>(app, call.method, call.path, { token, body: call.body });
      expect(res.status, call.name).toBe(403);
      expect(res.body, call.name).toEqual({ error: 'pin_required' });
    }
  });

  it('avec un jeton valide : toutes les routes répondent normalement ; le profil libre n exige rien', async () => {
    const pinToken = await unlockToken();
    for (const call of dataCalls(protectedId)) {
      const res = await request(app, call.method, call.path, { token, body: call.body, headers: { 'x-profile-token': pinToken } });
      expect(res.status, call.name).not.toBe(403);
    }
    for (const call of dataCalls(openId)) {
      const res = await request(app, call.method, call.path, { token, body: call.body });
      expect(res.status, call.name).not.toBe(403);
    }
  });

  it('jeton d un autre profil protégé : refusé', async () => {
    const otherId = (await createProfileVia(app, token, { name: 'Autre', pin: '2222' })).body.id;
    const otherToken = (await unlock('2222', otherId)).body as UnlockBody;
    const res = await request<ErrorBody>(app, 'GET', `/user/profiles/${protectedId}/library`, {
      token,
      headers: { 'x-profile-token': otherToken.token },
    });
    expect(res.body).toEqual({ error: 'pin_required' });
  });
});

describe('PIN : jeton lié à la session et à la version du PIN', () => {
  it('jeton émis pour une session : refusé avec une autre session du même compte', async () => {
    const pinToken = await unlockToken();
    const otherSession = await loginAs(app, 'alice');
    const res = await request<ErrorBody>(app, 'GET', `/user/profiles/${protectedId}/library`, {
      token: otherSession,
      headers: { 'x-profile-token': pinToken, 'x-profile-id': protectedId },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'pin_required' });
    const original = await request(app, 'GET', `/user/profiles/${protectedId}/library`, { token, headers: { 'x-profile-token': pinToken } });
    expect(original.status).toBe(200);
  });

  it('après déconnexion : la session et donc le jeton ne valent plus rien (401)', async () => {
    const pinToken = await unlockToken();
    await request(app, 'POST', '/user/logout', { token });
    const res = await request(app, 'GET', `/user/profiles/${protectedId}/library`, { token, headers: { 'x-profile-token': pinToken } });
    expect(res.status).toBe(401);
  });

  it('changement de PIN : les anciens jetons deviennent invalides, le nouveau PIN ouvre le profil', async () => {
    const oldToken = await unlockToken();
    const change = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${protectedId}`, {
      token,
      headers: { 'x-profile-token': oldToken, 'x-profile-id': protectedId },
      body: { pin: '3333' },
    });
    expect(change.status).toBe(200);
    const stale = await request<ErrorBody>(app, 'GET', `/user/profiles/${protectedId}/library`, {
      token,
      headers: { 'x-profile-token': oldToken, 'x-profile-id': protectedId },
    });
    expect(stale.body).toEqual({ error: 'pin_required' });
    expect((await unlock(PIN)).status).toBe(403);
    expect((await unlock('3333')).status).toBe(200);
  });

  it('jeton valable 30 jours, expiré ensuite', async () => {
    setClock(T0);
    const pinToken = await unlockToken();
    setClock(T0 + 10 * 60_000);
    expect((await request(app, 'GET', `/user/profiles/${protectedId}/library`, { token, headers: { 'x-profile-token': pinToken } })).status).toBe(200);
    setClock(T0 + 29 * 86_400_000);
    expect((await request(app, 'GET', `/user/profiles/${protectedId}/library`, { token, headers: { 'x-profile-token': pinToken } })).status).toBe(200);
    setClock(T0 + 30 * 86_400_000 + 1000);
    const res = await request<ErrorBody>(app, 'GET', `/user/profiles/${protectedId}/library`, { token, headers: { 'x-profile-token': pinToken } });
    expect(res.body).toEqual({ error: 'pin_required' });
  });

  it('verrouillage explicite : 204 pour un profil du compte, 404 pour un profil inconnu, 401 sans session', async () => {
    expect((await request(app, 'POST', `/user/profiles/${protectedId}/lock`, { token })).status).toBe(204);
    expect((await request(app, 'POST', `/user/profiles/${protectedId}/lock`)).status).toBe(401);
    expect((await request(app, 'POST', '/user/profiles/inconnu/lock', { token })).status).toBe(404);
  });

  it('retirer le PIN lève la protection des routes de données', async () => {
    const pinToken = await unlockToken();
    const removed = await request<ProfileBody>(app, 'PATCH', `/user/profiles/${protectedId}`, {
      token,
      headers: { 'x-profile-token': pinToken, 'x-profile-id': protectedId },
      body: { pin: null },
    });
    expect(removed.body.hasPin).toBe(false);
    expect((await request(app, 'GET', `/user/profiles/${protectedId}/library`, { token })).status).toBe(200);
  });
});

describe('GET /user/profiles : champs d affichage, sans secret', () => {
  it('expose hasPin, isKid et kidMaxAge ; aucun hash ni compteur', async () => {
    await createProfileVia(app, token, { name: 'Enfant', isKid: true, kidMaxAge: 10 });
    const res = await request<{ profiles: Record<string, unknown>[] }>(app, 'GET', '/user/profiles', { token });
    const byName = Object.fromEntries(res.body.profiles.map((profile) => [profile.name, profile]));
    expect(byName['Protégé']).toMatchObject({ hasPin: true, isKid: false, kidMaxAge: null });
    expect(byName['Enfant']).toMatchObject({ hasPin: false, isKid: true, kidMaxAge: 10 });
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['pinHash', 'pin_hash', 'pinVersion', 'pinFailures', 'pinLockedUntil', 'accountId']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
