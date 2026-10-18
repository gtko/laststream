import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { type AccountBody, type ErrorBody, loginAs, PASSWORD, request } from './user-harness.js';

const NEW_PASSWORD = 'nouveau-mot-de-passe-2';
const BOOTSTRAP = 'jeton-amorcage-test-0123456789';

let app: RunningApp | undefined;
let dir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close().catch(() => undefined);
  app = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function registerRequest(username: string, headers: Record<string, string> = {}) {
  return request<AccountBody | ErrorBody>(app as RunningApp, 'POST', '/user/register', {
    body: { username, password: PASSWORD },
    headers,
  });
}

describe('amorçage du premier compte', () => {
  it('LASTADDON_BOOTSTRAP_TOKEN défini : premier compte refusé sans le bon en-tête X-Bootstrap-Token', async () => {
    vi.stubEnv('LASTADDON_BOOTSTRAP_TOKEN', BOOTSTRAP);
    app = await startApp({});
    const none = await registerRequest('alice');
    expect(none.status).toBe(403);
    expect(none.body).toEqual({ error: 'bootstrap_token_invalid' });
    const wrong = await registerRequest('alice', { 'x-bootstrap-token': 'mauvais-jeton' });
    expect(wrong.status).toBe(403);
    const right = await registerRequest('alice', { 'x-bootstrap-token': BOOTSTRAP });
    expect(right.status).toBe(201);
    expect((right.body as AccountBody).account.isOwner).toBe(true);
  });

  it('jeton d amorçage exigé seulement pour le premier compte, pas pour les suivants', async () => {
    vi.stubEnv('LASTADDON_BOOTSTRAP_TOKEN', BOOTSTRAP);
    vi.stubEnv('LASTADDON_ALLOW_SIGNUP', '1');
    app = await startApp({});
    await registerRequest('alice', { 'x-bootstrap-token': BOOTSTRAP });
    const second = await registerRequest('bob');
    expect(second.status).toBe(201);
    expect((second.body as AccountBody).account.isOwner).toBe(false);
  });

  it('LASTADDON_BOOTSTRAP_TOKEN absent : premier compte sans jeton (propriétaire au premier arrivé)', async () => {
    vi.stubEnv('LASTADDON_BOOTSTRAP_TOKEN', '');
    app = await startApp({});
    const first = await registerRequest('alice');
    expect(first.status).toBe(201);
    expect((first.body as AccountBody).account.isOwner).toBe(true);
  });
});

describe('mot de passe, sessions et suppression de compte', () => {
  it('changement de mot de passe : mot de passe actuel exigé, autres sessions révoquées, session courante conservée', async () => {
    app = await startApp({});
    await registerRequest('alice');
    const current = await loginAs(app, 'alice');
    const other = await loginAs(app, 'alice');

    const wrong = await request<ErrorBody>(app, 'POST', '/user/password', { token: current, body: { current: 'mauvais', next: NEW_PASSWORD } });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'invalid_password' });

    const ok = await request(app, 'POST', '/user/password', { token: current, body: { current: PASSWORD, next: NEW_PASSWORD } });
    expect(ok.status).toBe(204);
    expect((await request(app, 'GET', '/user/me', { token: other })).status).toBe(401);
    expect((await request(app, 'GET', '/user/me', { token: current })).status).toBe(200);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).status).toBe(401);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: NEW_PASSWORD } })).status).toBe(200);
  });

  it('nouveau mot de passe trop court : 400', async () => {
    app = await startApp({});
    await registerRequest('alice');
    const token = await loginAs(app, 'alice');
    const res = await request<ErrorBody>(app, 'POST', '/user/password', { token, body: { current: PASSWORD, next: 'court' } });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(['next:too_small']);
  });

  it('au plus 20 sessions par compte : la plus ancienne est supprimée à la 21e connexion', async () => {
    app = await startApp({});
    await registerRequest('alice');
    const tokens: string[] = [];
    for (let index = 0; index < 21; index += 1) tokens.push(await loginAs(app, 'alice'));
    expect((await request(app, 'GET', '/user/me', { token: tokens[0] })).status).toBe(401);
    expect((await request(app, 'GET', '/user/me', { token: tokens[1] })).status).toBe(200);
    expect((await request(app, 'GET', '/user/me', { token: tokens[20] })).status).toBe(200);
  });

  it('logout-all : toutes les sessions du compte sont révoquées, y compris la courante', async () => {
    app = await startApp({});
    await registerRequest('alice');
    const first = await loginAs(app, 'alice');
    const second = await loginAs(app, 'alice');
    const out = await request(app, 'POST', '/user/logout-all', { token: first });
    expect(out.status).toBe(204);
    expect((await request(app, 'GET', '/user/me', { token: first })).status).toBe(401);
    expect((await request(app, 'GET', '/user/me', { token: second })).status).toBe(401);
  });

  it('suppression de compte : mot de passe exigé ; ensuite le compte et ses données disparaissent (cascade)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lastaddon-account-'));
    const file = join(dir, 'laststream.db');
    app = await startApp({ userDbPath: file });
    await registerRequest('alice');
    const token = await loginAs(app, 'alice');
    const profileId = (await request<{ id: string }>(app, 'POST', '/user/profiles', { token, body: { name: 'Greg' } })).body.id;
    await request(app, 'PUT', `/user/profiles/${profileId}/library/movie/603`, { token, body: { title: 'Matrix' } });
    await request(app, 'PUT', `/user/profiles/${profileId}/settings`, { token, body: { theme: 'dark' } });

    const denied = await request<ErrorBody>(app, 'DELETE', '/user/account', { token, body: { password: 'mauvais-mot-de-passe' } });
    expect(denied.status).toBe(403);
    expect((await request(app, 'GET', '/user/me', { token })).status).toBe(200);

    const removed = await request(app, 'DELETE', '/user/account', { token, body: { password: PASSWORD } });
    expect(removed.status).toBe(204);
    expect((await request(app, 'GET', '/user/me', { token })).status).toBe(401);
    expect((await request(app, 'POST', '/user/login', { body: { username: 'alice', password: PASSWORD } })).status).toBe(401);

    await app.close();
    app = undefined;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const table of ['accounts', 'sessions', 'profiles', 'library_items', 'settings']) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, table).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});
