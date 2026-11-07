import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type AccountBody, type ErrorBody, type LoginBody, PASSWORD, request } from './user-harness.js';

let app: RunningApp;

beforeEach(async () => {
  app = await startApp({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await app.close();
});

async function register(username: string, password = PASSWORD) {
  return request<AccountBody | ErrorBody>(app, 'POST', '/user/register', { body: { username, password } });
}

async function login(username: string, password = PASSWORD) {
  return request<LoginBody | ErrorBody>(app, 'POST', '/user/login', { body: { username, password } });
}

describe('inscription', () => {
  it('le premier compte est créé comme propriétaire, sans renvoyer le mot de passe', async () => {
    const res = await register('Alice');
    expect(res.status).toBe(201);
    const body = res.body as AccountBody;
    expect(body.account).toMatchObject({ username: 'alice', isOwner: true });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('un second compte est refusé tant que LASTADDON_ALLOW_SIGNUP n est pas à 1', async () => {
    await register('alice');
    const res = await register('bob');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'signup_disabled' });
  });

  it('avec LASTADDON_ALLOW_SIGNUP=1, un second compte est créé sans les droits de propriétaire', async () => {
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    await register('alice');
    const res = await register('bob');
    expect(res.status).toBe(201);
    expect((res.body as AccountBody).account.isOwner).toBe(false);
  });

  it('un nom déjà pris renvoie 409 username_taken (inscriptions ouvertes)', async () => {
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    await register('alice');
    const res = await register('ALICE');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'username_taken' });
  });

  it('nom ou mot de passe invalides : 400, chemins des champs seulement, jamais la valeur', async () => {
    const res = await register('a!', 'court');
    expect(res.status).toBe(400);
    const body = res.body as ErrorBody;
    expect(body.error).toBe('invalid_body');
    expect(body.issues).toEqual(expect.arrayContaining([expect.stringMatching(/^username:/), expect.stringMatching(/^password:/)]));
    expect(JSON.stringify(res.body)).not.toContain('court');
  });
});

describe('connexion et sessions', () => {
  it('login valide : jeton de 32 octets (base64url) et expiration à 180 jours', async () => {
    await register('alice');
    const now = Date.now();
    const res = await login('alice');
    expect(res.status).toBe(200);
    const body = res.body as LoginBody;
    expect(Buffer.from(body.token, 'base64url')).toHaveLength(32);
    const days = (Date.parse(body.expiresAt) - now) / 86_400_000;
    expect(days).toBeGreaterThan(179.9);
    expect(days).toBeLessThan(180.1);
  });

  it('mauvais mot de passe et compte inconnu : même réponse 401 invalid_credentials', async () => {
    await register('alice');
    const wrong = await login('alice', 'mauvais-mot-de-passe');
    const unknown = await login('personne-inconnue');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_credentials' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('GET /user/me : compte de la session, 401 sans jeton ou avec un jeton mal formé', async () => {
    await register('alice');
    const token = (await login('alice')).body as LoginBody;
    const me = await request<AccountBody>(app, 'GET', '/user/me', { token: token.token });
    expect(me.status).toBe(200);
    expect(me.body.account.username).toBe('alice');
    expect((await request(app, 'GET', '/user/me')).status).toBe(401);
    const malformed = await request(app, 'GET', '/user/me', { headers: { authorization: 'Basic abc' } });
    expect(malformed.status).toBe(401);
    expect(malformed.body).toEqual({ error: 'unauthorized' });
  });

  it('logout invalide la session', async () => {
    await register('alice');
    const { token } = (await login('alice')).body as LoginBody;
    const out = await request(app, 'POST', '/user/logout', { token });
    expect(out.status).toBe(204);
    expect((await request(app, 'GET', '/user/me', { token })).status).toBe(401);
  });

  it('une session expire après 180 jours', async () => {
    await register('alice');
    const { token } = (await login('alice')).body as LoginBody;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 179 * 86_400_000);
    expect((await request(app, 'GET', '/user/me', { token })).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect((await request(app, 'GET', '/user/me', { token })).status).toBe(401);
  });

  it('refresh : nouveau jeton, ancien jeton refusé immédiatement', async () => {
    await register('alice');
    const first = (await login('alice')).body as LoginBody;
    const renewed = await request<LoginBody>(app, 'POST', '/user/refresh', { token: first.token });
    expect(renewed.status).toBe(200);
    expect(renewed.body.token).not.toBe(first.token);
    expect((await request(app, 'GET', '/user/me', { token: first.token })).status).toBe(401);
    expect((await request(app, 'GET', '/user/me', { token: renewed.body.token })).status).toBe(200);
    expect((await request(app, 'POST', '/user/refresh', { token: first.token })).status).toBe(401);
  });
});

describe('stockage des secrets', () => {
  it('jetons de session hachés, mots de passe en scrypt, aucun secret en clair dans la base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lastaddon-auth-'));
    const file = join(dir, 'laststream.db');
    const fileApp = await startApp({ userDbPath: file });
    try {
      await request(fileApp, 'POST', '/user/register', { body: { username: 'alice', password: PASSWORD } });
      const { token } = (await request<LoginBody>(fileApp, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).body;
      const db = new DatabaseSync(file);
      try {
        const sessions = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(sessions[0]?.token_hash).not.toBe(token);
        const account = db.prepare('SELECT password_hash FROM accounts').get() as { password_hash: string };
        expect(account.password_hash.startsWith('scrypt$')).toBe(true);
        expect(account.password_hash).not.toContain(PASSWORD);
        const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all()) + JSON.stringify(db.prepare('SELECT * FROM accounts').all());
        expect(dump).not.toContain(token);
        expect(dump).not.toContain(PASSWORD);
      } finally {
        db.close();
      }
    } finally {
      await fileApp.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aucun mot de passe ni jeton n est écrit sur la console pendant inscription et connexion', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    try {
      await register('alice');
      await login('alice', 'mauvais-mot-de-passe');
      const ok = (await login('alice')).body as LoginBody;
      await request(app, 'GET', '/user/me', { token: 'jeton-inexistant-0123456789' });
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('mauvais-mot-de-passe');
      expect(logged).not.toContain(ok.token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
