import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, type Member } from './social-harness.js';
import { type ErrorBody, createProfileVia, loginAs, PASSWORD, request } from './user-harness.js';

/**
 * Durcissement des sessions verrouillées sur un profil invité (revue de sécurité de la partie A) : déconnexion de ce profil
 * seul, plafonds de sessions par (compte, profil), retrait de l'identifiant, passage en enfant, check anonyme réduit,
 * jeton mal formé refusé avant le mot de passe, et pas de PIN pour une session verrouillée. Le contrôle des salons
 * (/party) n'existe que sous Workers : voir tests-workers/party-locked.test.ts.
 */

interface CheckBody {
  state: string;
  backdrops: string[];
  inviter?: unknown;
  profile?: unknown;
  expiresAt?: unknown;
}

const HOUR = 3600 * 1000;
/** Les tests de plafond enchaînent les connexions (chacune calcule un scrypt) : délai généreux. */
const SLOW = 60_000;

let app: RunningApp;
let alice: Member;
/** Profil « Marie » du compte (adulte, non principal) : cible de l'invitation et de la session verrouillée. */
let marie: string;
/** Session verrouillée sur Marie (créée par l'inscription via le lien du foyer). */
let lockedToken: string;

const HEADERS = (profile: string) => ({ 'x-profile-id': profile });

/** Lien du foyer pour un profil du compte (créateur : `creator`, par défaut le profil principal d'Alice). */
async function householdLink(profile: string, body: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const res = await request<{ id: string; token: string } | ErrorBody>(app, 'POST', `/user/profiles/${profile}/household-invite`, {
    token: alice.token,
    headers: HEADERS(alice.profile),
    body,
  });
  if (res.status !== 201) throw new Error(`lien du foyer refusé (${res.status})`);
  return res.body as { id: string; token: string };
}

/** Consomme un lien du foyer : renvoie la session verrouillée (201). */
const redeem = (token: string, login: string) =>
  request<{ token: string; profileId: string } | ErrorBody>(app, 'POST', '/user/household-invites/redeem', {
    body: { token, login, password: PASSWORD },
  });

const me = (token: string) => request<{ lockedProfileId: string | null }>(app, 'GET', '/user/me', { token });
const alive = async (token: string): Promise<boolean> => (await me(token)).status === 200;
const login = (username: string) => request<{ token: string } | ErrorBody>(app, 'POST', '/user/login', { body: { username, password: PASSWORD } });

beforeEach(async () => {
  app = await startApp({
    userRateLimits: { read: 1000, write: 1000, sensitive: 1000, loginPerUsername: 1000, authPerIp: 1000 },
  });
  alice = await bootstrapOwner(app);
  marie = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Marie' })).body.id;
  const link = await householdLink(marie);
  const redeemed = await redeem(link.token, 'marie.hub');
  if (redeemed.status !== 201) throw new Error(`consommation refusée (${redeemed.status})`);
  lockedToken = (redeemed.body as { token: string }).token;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('POST /user/logout-all', () => {
  it('depuis une session verrouillée : ne révoque que les sessions de ce profil ; l’hôte garde les siennes', async () => {
    const second = (await login('marie.hub')).body as { token: string };
    expect(await alive(second.token)).toBe(true);

    const res = await request(app, 'POST', '/user/logout-all', { token: lockedToken });
    expect(res.status).toBe(204);
    expect(await alive(lockedToken)).toBe(false);
    expect(await alive(second.token)).toBe(false);
    expect(await alive(alice.token)).toBe(true);
  });

  it('depuis une session libre : toutes les sessions du compte tombent, verrouillées comprises', async () => {
    const other = await loginAs(app, 'alice');
    expect((await request(app, 'POST', '/user/logout-all', { token: alice.token })).status).toBe(204);
    expect(await alive(alice.token)).toBe(false);
    expect(await alive(other)).toBe(false);
    expect(await alive(lockedToken)).toBe(false);
  });
});

describe('plafond de sessions : 20 par compte (libres) et 20 par profil verrouillé', () => {
  it('les sessions libres évincent la plus ancienne au-delà de 20, sans toucher aux sessions verrouillées', async () => {
    expect(await alive(alice.token)).toBe(true);
    for (let n = 0; n < 19; n += 1) await loginAs(app, 'alice');
    // 20 sessions libres : toutes vivantes.
    expect(await alive(alice.token)).toBe(true);
    const newest = await loginAs(app, 'alice');
    // 21 : la plus ancienne (celle de l'inscription de test) tombe, la plus récente vit, la verrouillée aussi.
    expect(await alive(alice.token)).toBe(false);
    expect(await alive(newest)).toBe(true);
    expect(await alive(lockedToken)).toBe(true);
  }, SLOW);

  it('les sessions verrouillées ont leur propre plafond, et une session libre n’en évince aucune', async () => {
    // 1 verrouillée (lockedToken) + 19 : 20, toutes vivantes.
    for (let n = 0; n < 19; n += 1) await login('marie.hub');
    expect(await alive(lockedToken)).toBe(true);
    // Vingt sessions libres ne touchent pas le plafond verrouillé.
    for (let n = 0; n < 20; n += 1) await loginAs(app, 'alice');
    expect(await alive(lockedToken)).toBe(true);
    // Une vingt-et-unième verrouillée évince la plus ancienne verrouillée, et seulement elle.
    const newestLocked = (await login('marie.hub')).body as { token: string };
    expect(await alive(lockedToken)).toBe(false);
    expect(await alive(newestLocked.token)).toBe(true);
    // La session libre de test tombe dès la 21e session libre (la sienne compte) : indépendant des verrouillées.
    expect(await alive(alice.token)).toBe(false);
  }, SLOW);
});

describe('DELETE /user/profiles/:id/login', () => {
  it('depuis une session verrouillée : 403 profile_locked', async () => {
    const res = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${marie}/login`, { token: lockedToken, headers: HEADERS(marie) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('profile_locked');
  });

  it('sans profil adulte en X-Profile-Id : 403 adult_profile_required', async () => {
    const res = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${marie}/login`, { token: alice.token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('adult_profile_required');
  });

  it('retire l’identifiant et ses sessions verrouillées (204) ; ensuite 404 no_login', async () => {
    const res = await request(app, 'DELETE', `/user/profiles/${marie}/login`, { token: alice.token, headers: HEADERS(alice.profile) });
    expect(res.status).toBe(204);
    expect(await alive(lockedToken)).toBe(false);
    expect((await login('marie.hub')).status).toBe(401);
    // Le profil reste dans le compte.
    const profiles = await request<{ profiles: { id: string }[] }>(app, 'GET', '/user/profiles', { token: alice.token });
    expect(profiles.body.profiles.map((p) => p.id)).toContain(marie);

    const again = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${marie}/login`, { token: alice.token, headers: HEADERS(alice.profile) });
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('no_login');
  });

  it('profil sans identifiant : 404 no_login', async () => {
    const res = await request<ErrorBody>(app, 'DELETE', `/user/profiles/${alice.profile}/login`, { token: alice.token, headers: HEADERS(alice.profile) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_login');
  });
});

describe('PATCH /user/profiles/:id : passer en enfant', () => {
  it('isKid=true retire l’identifiant d’invité et les sessions verrouillées', async () => {
    const res = await request(app, 'PATCH', `/user/profiles/${marie}`, { token: alice.token, headers: HEADERS(alice.profile), body: { isKid: true } });
    expect(res.status).toBe(200);
    expect(await alive(lockedToken)).toBe(false);
    expect((await login('marie.hub')).status).toBe(401);
  });
});

describe('GET /user/household-invites/check : sans détails hors état utilisable', () => {
  it('utilisé : seul l’état et backdrops:[] sont renvoyés', async () => {
    const sam = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Sam' })).body.id;
    const link = await householdLink(sam);
    expect((await redeem(link.token, 'sam.hub')).status).toBe(201);
    const res = await request<CheckBody>(app, 'GET', `/user/household-invites/check?token=${encodeURIComponent(link.token)}`);
    expect(res.body).toEqual({ state: 'used', backdrops: [] });
  });

  it('révoqué : seul l’état et backdrops:[] sont renvoyés', async () => {
    const lea = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Léa' })).body.id;
    const link = await householdLink(lea);
    expect((await request(app, 'DELETE', `/user/household-invites/${link.id}`, { token: alice.token, headers: HEADERS(alice.profile) })).status).toBe(204);
    const res = await request<CheckBody>(app, 'GET', `/user/household-invites/check?token=${encodeURIComponent(link.token)}`);
    expect(res.body).toEqual({ state: 'revoked', backdrops: [] });
  });

  it('expiré : seul l’état et backdrops:[] sont renvoyés', async () => {
    const tom = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Tom' })).body.id;
    const link = await householdLink(tom, { ttlHours: 24 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * HOUR);
    const res = await request<CheckBody>(app, 'GET', `/user/household-invites/check?token=${encodeURIComponent(link.token)}`);
    expect(res.body).toEqual({ state: 'expired', backdrops: [] });
  });

  it('ok : inviter, profil et échéance, et seules les affiches des hôtes autorisés (TMDB, fanart)', async () => {
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/movie/603`, {
      token: alice.token,
      headers: HEADERS(alice.profile),
      body: { title: 'Matrix', poster: 'https://image.tmdb.org/t/p/w500/matrix.jpg' },
    });
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/movie/550`, {
      token: alice.token,
      headers: HEADERS(alice.profile),
      body: { title: 'Fight Club', poster: 'https://img.example.com/fight.jpg' },
    });
    await request(app, 'PUT', `/user/profiles/${alice.profile}/library/movie/13`, {
      token: alice.token,
      headers: HEADERS(alice.profile),
      body: { title: 'Forrest', poster: 'https://assets.fanart.tv/forrest.jpg' },
    });
    const lea = (await createProfileVia<{ id: string }>(app, alice.token, { name: 'Lea' })).body.id;
    const link = await householdLink(lea);
    const res = await request<CheckBody>(app, 'GET', `/user/household-invites/check?token=${encodeURIComponent(link.token)}`);
    expect(res.body.state).toBe('ok');
    expect(res.body.inviter).toBeDefined();
    expect(res.body.profile).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    expect([...res.body.backdrops].sort()).toEqual(['https://assets.fanart.tv/forrest.jpg', 'https://image.tmdb.org/t/p/w500/matrix.jpg']);
  });
});

describe('POST /user/household-invites/redeem : forme du jeton vérifiée avant le mot de passe', () => {
  it('un jeton mal formé répond 404 unknown et ne crée aucun identifiant', async () => {
    const res = await redeem('pas-un-jeton', 'mauvais.hub');
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('unknown');
    expect((await login('mauvais.hub')).status).toBe(401);
  });
});

describe('session verrouillée : pas de PIN à saisir (social v2, actorOf)', () => {
  it('un profil protégé par PIN reste accessible à sa session verrouillée sans X-Profile-Token', async () => {
    const before = await request(app, 'GET', '/user/social/me', { token: lockedToken, headers: HEADERS(marie) });
    expect(before.status).toBe(200);
    expect((await request(app, 'PATCH', `/user/profiles/${marie}`, { token: alice.token, headers: HEADERS(alice.profile), body: { pin: '1234' } })).status).toBe(200);
    const after = await request(app, 'GET', '/user/social/me', { token: lockedToken, headers: HEADERS(marie) });
    expect(after.status).toBe(200);
  });
});
