import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, personaOf } from './social-v2-harness.js';
import { bootstrapOwner, inviteAndRegister } from './social-harness.js';
import { request } from './user-harness.js';

/** Durcissement Social v2 par l'API : quota des demandes d'ami, bibliothèque legacy après retrait v2 (Node et Workers). */

describe('API', () => {
  let app: RunningApp;
  let cast: Cast;

  beforeEach(async () => {
    app = await startApp({});
    cast = await castOf(app);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await app.close();
  });

  it('demandes d ami : 20 par heure et par profil, puis 429 rate_limited', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/requests', { body: { handle: 'Inconnu#2222' } });
      expect(res.status).toBe(404);
    }
    const res = await as<ErrorBodyV2>(app, cast.bob, 'POST', '/user/social/requests', { body: { handle: 'Inconnu#2222' } });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    // Handle mal formé : refusé avant le limiteur.
    expect((await as<ErrorBodyV2>(app, cast.carol, 'POST', '/user/social/requests', { body: { handle: 'x' } })).status).toBe(400);
  });
});

describe('API : bibliothèque legacy après retrait v2', () => {
  let app: RunningApp;

  beforeEach(async () => {
    app = await startApp({});
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await app.close();
  });

  it('l ex-ami ne lit plus la bibliothèque par GET /user/friends/:username/library', async () => {
    const alice = await bootstrapOwner(app, 'alice');
    const bob = await inviteAndRegister(app, alice, 'bob');
    const a = await personaOf(app, alice.token, alice.profile, 'alice');
    const b = await personaOf(app, bob.token, bob.profile, 'bob');
    expect((await request(app, 'GET', '/user/friends/alice/library', { token: bob.token })).status).toBe(200);
    expect((await as(app, b, 'DELETE', `/user/social/friends/${a.pid}`)).status).toBe(204);
    expect((await request(app, 'GET', '/user/friends/alice/library', { token: bob.token })).status).toBe(404);
    expect((await request(app, 'GET', '/user/friends/bob/library', { token: alice.token })).status).toBe(404);
  });
});
