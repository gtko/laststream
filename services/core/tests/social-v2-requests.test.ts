import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Cast, castOf, HOOK_TIMEOUT_MS, type Persona } from './social-v2-harness.js';

/** Refus et annulation de demande : l'autre profil est prévenu pour retirer la demande de sa liste. */

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const emitted: Emitted[] = [];

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  emitted.length = 0;
  app = await startApp({
    extra: {
      socialEvents: (pids, event) => {
        emitted.push({ pids: [...pids], event });
      },
    },
  });
  cast = await castOf(app);
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const ask = (from: Persona, to: Persona) => as(app, from, 'POST', '/user/social/requests', { body: { handle: to.full } });
const withdraw = (who: Persona, otherPid: string) => as(app, who, 'DELETE', `/user/social/requests/${otherPid}`);

describe('refus et annulation (DELETE /user/social/requests/:pid)', () => {
  it('refus : le demandeur reçoit unfriend avec le pid de celui qui refuse, et lui seul', async () => {
    expect((await ask(cast.alice, cast.bob)).status).toBe(201);
    emitted.length = 0;
    expect((await withdraw(cast.bob, cast.alice.pid)).status).toBe(204);
    expect(emitted).toEqual([{ pids: [cast.alice.pid], event: { t: 'unfriend', pid: cast.bob.pid } }]);
  });

  it('annulation : le destinataire reçoit unfriend avec le pid de celui qui annule, et lui seul', async () => {
    expect((await ask(cast.alice, cast.carol)).status).toBe(201);
    emitted.length = 0;
    expect((await withdraw(cast.alice, cast.carol.pid)).status).toBe(204);
    expect(emitted).toEqual([{ pids: [cast.carol.pid], event: { t: 'unfriend', pid: cast.alice.pid } }]);
  });

  it('demande inexistante : 404 et aucun événement', async () => {
    const res = await withdraw(cast.bob, cast.carol.pid);
    expect(res.status).toBe(404);
    expect(emitted).toEqual([]);
  });
});
