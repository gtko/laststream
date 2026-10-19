/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metricsService } from '../src/metrics/index.js';
import { platform } from '../src/platform/index.js';
import { AllDebridClient } from '../src/sources/alldebrid.js';
import { fetchUpstream } from '../src/sources/upstream.js';
import { startAdmin } from './admin-harness.js';

// Mode serveur AllDebrid explicitement activé (opt-in) : le client AllDebrid est appelé depuis le serveur.
beforeEach(() => vi.stubEnv('LASTADDON_DEBRID_SERVER_SIDE', '1'));
afterEach(() => vi.unstubAllEnvs());

const metrics = () => {
  const service = metricsService();
  if (service === undefined) throw new Error('métriques absentes');
  return service;
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('points de mesure (plateforme Node)', () => {
  it('addon amont : appels, échecs et délais par hôte, sans chemin ni jeton', async () => {
    const host = 'sante-addon.example';
    const source = { name: 'A', url: `https://${host}/TOKENSECRET1234567890/manifest.json` };
    const ref = { type: 'movie', id: 'tt0133093', imdbId: 'tt0133093' } as const;
    const before = (await metrics().report('1h')).upstreams.find((entry) => entry.host === host);
    await fetchUpstream(source, ref, { fetch: () => Promise.resolve(jsonResponse({ streams: [] })) });
    await expect(fetchUpstream(source, ref, { fetch: () => Promise.resolve(jsonResponse({}, 500)) })).rejects.toThrow();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(fetchUpstream(source, ref, { fetch: () => Promise.reject(abort) })).rejects.toThrow();
    const report = await metrics().report('1h');
    const entry = report.upstreams.find((item) => item.host === host);
    expect(entry).toBeDefined();
    expect((entry?.calls ?? 0) - (before?.calls ?? 0)).toBe(3);
    expect((entry?.failures ?? 0) - (before?.failures ?? 0)).toBe(1);
    expect((entry?.timeouts ?? 0) - (before?.timeouts ?? 0)).toBe(1);
    expect(JSON.stringify(report.upstreams)).not.toContain('TOKENSECRET');
  });

  it('AllDebrid : succès et erreurs par code, par opération', async () => {
    const before = (await metrics().report('1h')).alldebrid;
    const answers: Response[] = [
      jsonResponse({ status: 'success', data: { link: 'https://x' } }),
      jsonResponse({ status: 'error', error: { code: 'LINK_HOST_NOT_SUPPORTED', message: 'non' } }),
      jsonResponse({ status: 'error', error: { code: 'MAGNET_INVALID_URI', message: 'non' } }),
    ];
    const client = new AllDebridClient('cle-de-test-123456', { fetch: () => Promise.resolve(answers.shift() as Response) });
    await client.call('POST', '/v4/link/unlock', new URLSearchParams([['link', 'https://hoster/x']]));
    await expect(client.call('POST', '/v4/link/unlock', new URLSearchParams([['link', 'https://hoster/y']]))).rejects.toThrow();
    await expect(client.call('POST', '/v4/magnet/upload', new URLSearchParams([['magnets[]', 'a'.repeat(40)]]))).rejects.toThrow();
    const after = (await metrics().report('1h')).alldebrid;
    expect(after.unlock.ok - before.unlock.ok).toBe(1);
    expect(Object.values(after.unlock.errors).reduce((a, b) => a + b, 0) - Object.values(before.unlock.errors).reduce((a, b) => a + b, 0)).toBe(1);
    expect(Object.values(after.magnet.errors).reduce((a, b) => a + b, 0) - Object.values(before.magnet.errors).reduce((a, b) => a + b, 0)).toBe(1);
    expect(JSON.stringify(after)).not.toContain('cle-de-test');
  });

  it('caches : succès et échecs de lecture comptés par préfixe', async () => {
    const before = (await metrics().report('1h')).caches.find((entry) => entry.prefix === 'packs');
    const cache = platform().createKvCache('packs');
    await cache.get('absent');
    await cache.set('present', '1');
    await cache.get('present');
    await cache.get('present');
    const after = (await metrics().report('1h')).caches.find((entry) => entry.prefix === 'packs');
    expect((after?.hits ?? 0) - (before?.hits ?? 0)).toBe(2);
    expect((after?.misses ?? 0) - (before?.misses ?? 0)).toBe(1);
  });
});

describe('/admin sous Node', () => {
  it('administration des caches : 501 propre (pas de KV), métriques en mémoire disponibles', async () => {
    const rig = await startAdmin();
    try {
      const caches = await rig.call<{ error: string }>('GET', '/admin/caches');
      expect(caches.status).toBe(501);
      expect(caches.body.error).toBe('cache_admin_unavailable');
      expect((await rig.call('POST', '/admin/caches/packs/purge', { elevation: await rig.elevate() })).status).toBe(501);
      const report = await rig.call<any>('GET', '/admin/metrics?range=1h');
      expect(report.status).toBe(200);
      expect(report.body.totals.requests).toBeGreaterThan(0);
      expect((await rig.call('GET', '/admin/party/rooms')).status).toBe(501);
    } finally {
      await rig.app.close();
    }
  });
});
