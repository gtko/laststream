import { afterEach, describe, expect, it, vi } from 'vitest';
import { signLiveTicket, signTicket } from '../src/party/ticket.js';
import type { PartyBackend } from '../src/party/backend.js';
import { handlePartyWs } from '../src/party/ws.js';
import { createSharedLimiter, isolateId, type LimitBinding, SHARED_LIMITS, type SharedLimits, sharedLimitsFromEnv } from '../src/rate-limit-shared.js';
import { handleSocialLiveWs } from '../src/user/social-v2-live-ws.js';
import { connectionsToEvict, createSlidingWindow } from '../src/ws-limits.js';
import { type RunningApp, SECRET, startApp } from './lt-harness.js';

/** LAST-128 : limites de débit partagées entre instances (liaison Rate Limiting) avec repli sur la Map locale, et plafonds WebSocket. */

/** Liaison simulée : autorise `allowed` appels puis refuse ; enregistre les clés reçues. */
function fakeBinding(allowed: number): LimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: ({ key }) => {
      keys.push(key);
      return Promise.resolve({ success: keys.length <= allowed });
    },
  };
}

const failingBinding: LimitBinding = { limit: () => Promise.reject(new Error('panne de la liaison')) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('limiteur à deux barrières (createSharedLimiter)', () => {
  it('liaison absente : la Map locale seule refuse au-delà de la limite', async () => {
    const limiter = createSharedLimiter(undefined, 'config', 3, 60_000);
    const verdicts = [];
    for (let i = 0; i < 5; i += 1) verdicts.push((await limiter('1.2.3.4')).allowed);
    expect(verdicts).toEqual([true, true, true, false, false]);
  });

  it('liaison présente : refus partagé avec la période de la liaison, clé préfixée par le nom', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = fakeBinding(2);
    const limiter = createSharedLimiter({ config: binding }, 'config', 1000, 60_000);
    expect((await limiter('ip-a')).allowed).toBe(true);
    expect((await limiter('ip-a')).allowed).toBe(true);
    const refused = await limiter('ip-a');
    expect(refused).toEqual({ allowed: false, retryAfterSec: SHARED_LIMITS.config.periodSec });
    expect(binding.keys).toEqual(['config:ip-a', 'config:ip-a', 'config:ip-a']);
    // Journal : nom de la limite et identifiant d'isolat, jamais la clé (IP).
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('"limiter":"config"');
    expect(line).toContain(`"isolate":"${isolateId()}"`);
    expect(line).not.toContain('ip-a');
  });

  it("la Map locale refuse avant d'appeler la liaison", async () => {
    const binding = fakeBinding(100);
    const limiter = createSharedLimiter({ config: binding }, 'config', 1, 60_000);
    await limiter('k');
    expect((await limiter('k')).allowed).toBe(false);
    expect(binding.keys).toHaveLength(1);
  });

  it('liaison en panne : la Map locale reste la limite, aucune erreur', async () => {
    const limiter = createSharedLimiter({ config: failingBinding }, 'config', 2, 60_000);
    expect((await limiter('k')).allowed).toBe(true);
    expect((await limiter('k')).allowed).toBe(true);
    expect((await limiter('k')).allowed).toBe(false);
  });

  it("sharedLimitsFromEnv ne retient que les liaisons de limite de l'environnement", () => {
    const binding = fakeBinding(1);
    const limits = sharedLimitsFromEnv({ RL_30_PER_MIN: binding, RL_TYPING: 'pas une liaison', AUTRE: binding });
    expect(limits.config).toBe(binding);
    expect(limits.partyWrite).toBe(binding);
    expect(limits.typing).toBeUndefined();
    expect(limits.userRead).toBeUndefined();
  });

  it("isolateId : hexadécimal, stable dans l'isolat", () => {
    expect(isolateId()).toMatch(/^[0-9a-f]{8}$/);
    expect(isolateId()).toBe(isolateId());
  });
});

describe('routes sensibles refusées par la liaison partagée (429)', () => {
  let app: RunningApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('/config : 429 + Retry-After au-delà de la limite de la liaison, même sous la limite locale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = fakeBinding(2);
    app = await startApp({ extra: { sharedLimits: { config: binding } } });
    const call = () => fetch(`${app?.baseUrl}/config/encode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await call()).status).not.toBe(429);
    expect((await call()).status).not.toBe(429);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
  });

  it('/config sans liaison : repli sur la Map locale (30 par minute)', async () => {
    app = await startApp({});
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await fetch(`${app.baseUrl}/config/encode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('/user : lecture refusée par la liaison partagée (429), clé préfixée par le nom', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = fakeBinding(0);
    app = await startApp({ extra: { sharedLimits: { userRead: binding } } });
    const res = await fetch(`${app.baseUrl}/user/me`);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(binding.keys[0]).toMatch(/^userRead:/);
  });

  it('/admin : lecture refusée par la liaison partagée avant toute authentification', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    app = await startApp({ extra: { sharedLimits: { adminRead: fakeBinding(0) } } });
    expect((await fetch(`${app.baseUrl}/admin/stats`)).status).toBe(429);
  });
});

describe('mises à niveau WebSocket', () => {
  const upgrade = (url: string): Request => new Request(url, { headers: { upgrade: 'websocket' } });
  const party = { room: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }) } as unknown as PartyBackend;
  const ROOM = 'room-0123456789abcdef';
  const identity = { accountId: 'compte-1', username: 'alice', avatarColor: '#aa5500' };

  it('salon : 429 par IP au-delà de la liaison, avant toute vérification du ticket', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const shared: SharedLimits = { partyUpgrade: fakeBinding(0) };
    const res = await handlePartyWs(upgrade(`https://worker.test/party/${ROOM}/ws?ticket=x`), { party, secret: SECRET, ip: '10.1.0.1', shared });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it("salon : plafond par compte, indépendant de l'IP (la liaison refuse la clé du compte)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = Date.now();
    const keys: string[] = [];
    const shared: SharedLimits = {
      partyUpgrade: {
        limit: ({ key }) => {
          keys.push(key);
          return Promise.resolve({ success: !key.includes(':account:') });
        },
      },
    };
    const { ticket } = signTicket(ROOM, identity, now, SECRET);
    const res = await handlePartyWs(upgrade(`https://worker.test/party/${ROOM}/ws?ticket=${ticket}`), { party, secret: SECRET, ip: '10.1.0.2', now, shared });
    expect(res.status).toBe(429);
    expect(keys).toEqual(['partyUpgrade:ip:10.1.0.2', 'partyUpgrade:account:compte-1']);
  });

  it('salon sans liaison : la Map locale refuse au-delà de 60 mises à niveau par minute et par IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      statuses.push((await handlePartyWs(upgrade(`https://worker.test/party/${ROOM}/ws?ticket=x`), { party, secret: SECRET, ip: '10.1.0.3' })).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('flux social : 429 par IP, puis par profil, au-delà de la liaison', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = Date.now();
    const { ticket } = signLiveTicket('ABCDEFGHIJKLMNOP', 'compte-1', now, SECRET);
    const forward = () => Promise.resolve(new Response(null, { status: 204 }));
    const url = `https://worker.test/user/social/live?ticket=${ticket}`;
    const byIp = await handleSocialLiveWs(upgrade(url), { secret: SECRET, ip: '10.2.0.1', now, forward, shared: { socialUpgrade: fakeBinding(0) } });
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get('retry-after')).toBe('60');
    // IP admise (premier appel de la liaison), profil refusé (deuxième appel).
    const byProfile = await handleSocialLiveWs(upgrade(url), { secret: SECRET, ip: '10.2.0.2', now, forward, shared: { socialUpgrade: fakeBinding(1) } });
    expect(byProfile.status).toBe(429);
  });

  it('flux social sans liaison : admis sous la limite locale', async () => {
    const now = Date.now();
    const { ticket } = signLiveTicket('ABCDEFGHIJKLMNOP', 'compte-1', now, SECRET);
    const res = await handleSocialLiveWs(upgrade(`https://worker.test/user/social/live?ticket=${ticket}`), {
      secret: SECRET,
      ip: '10.2.0.3',
      now,
      forward: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    expect(res.status).toBe(204);
  });
});

describe('plafonds des WebSockets des Durable Objects (ws-limits)', () => {
  it('messages : refus au-delà du plafond sur la fenêtre glissante, par clé, puis reprise', () => {
    let clock = 0;
    const allow = createSlidingWindow(3, 1000, () => clock);
    expect([allow('a'), allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false, false]);
    // Une autre connexion n'est pas affectée.
    expect(allow('b')).toBe(true);
    // Les messages refusés comptent aussi : à 999 ms, la fenêtre contient encore tout.
    clock = 999;
    expect(allow('a')).toBe(false);
    clock = 2500;
    expect(allow('a')).toBe(true);
  });

  it('connexions : les plus anciennes sont évincées pour garder le plafond, ordre stable à la milliseconde près', () => {
    const open = [
      { id: 'c', openedAt: 5, seq: 3 },
      { id: 'a', openedAt: 1, seq: 1 },
      { id: 'b', openedAt: 5, seq: 2 },
    ];
    expect(connectionsToEvict(open, 5)).toEqual([]);
    expect(connectionsToEvict(open, 3).map((entry) => entry.id)).toEqual(['a']);
    expect(connectionsToEvict(open, 2).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(connectionsToEvict(open, 1).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
