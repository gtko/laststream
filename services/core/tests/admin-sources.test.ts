/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { R2_MAX_PAGES, R2_PAGE_LIMIT, nextTvRun, r2UsageOf, sqlStatsOf, tvOverdue, type R2Listing, type R2Page } from '../src/admin/ops-stats.js';
import type { TvCronState } from '../src/admin/cache-types.js';
import { createMemoryMetrics } from '../src/metrics/memory.js';
import type { SqlDb } from '../src/user/sql.js';
import { fakeCacheAdmin, inviteAndRegister, request, startAdmin, type AdminRig } from './admin-harness.js';

let rig: AdminRig | undefined;
afterEach(async () => {
  await rig?.app.close();
  rig = undefined;
  vi.unstubAllEnvs();
});

const SIX_HOURS = 6 * 3600_000;

/** Fetch simulé : enregistre chaque appel et répond par `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const options = init ?? {};
    calls.push({ url, init: options });
    return respond(url, options);
  }) as typeof fetch;
  return { fn, calls };
}

/** Fetch qui ne répond jamais avant l'annulation du signal (délai dépassé). */
const hangingFetch = (): typeof fetch =>
  ((_input: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('annulée', 'AbortError')));
    })) as typeof fetch;

/** Bucket R2 simulé : pages de `size` octets, `pages` pages (0 = objets absents), ou une erreur. */
function fakeBucket(options: { objects?: number; size?: number; endless?: boolean; broken?: boolean }): R2Listing & { calls: number } {
  const state = { calls: 0 };
  return Object.assign(state, {
    list: (): Promise<R2Page> => {
      state.calls += 1;
      if (options.broken === true) return Promise.reject(new Error('r2 indisponible'));
      if (options.endless === true) {
        return Promise.resolve({ objects: Array.from({ length: R2_PAGE_LIMIT }, () => ({ size: 1 })), truncated: true, cursor: `c${state.calls}` });
      }
      return Promise.resolve({ objects: Array.from({ length: options.objects ?? 0 }, () => ({ size: options.size ?? 1 })), truncated: false });
    },
  });
}

describe('/admin/providers', () => {
  it('liste fixe sans AllDebrid ; statistiques absentes (null) ; testabilité selon les clés du serveur', async () => {
    vi.stubEnv('TVDB_API_KEY', 'tvdb-cle-test-0001');
    rig = await startAdmin();
    const res = await rig.call<any>('GET', '/admin/providers');
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p: any) => p.id)).toEqual(['tmdb', 'tvdb', 'openrouter', 'cinemeta', 'mdblist', 'fanart', 'rows']);
    const byId = new Map(res.body.providers.map((p: any) => [p.id, p]));
    expect(byId.get('tvdb')).toMatchObject({ label: 'TheTVDB', testable: true });
    expect(byId.get('tmdb')).toMatchObject({ testable: false });
    expect(byId.get('cinemeta')).toMatchObject({ testable: true });
    expect(byId.get('rows')).toMatchObject({ testable: false });
    for (const provider of res.body.providers) {
      expect(provider).toMatchObject({ successRate: null, p95: null, lastFailureAt: null, status: 'unknown' });
      expect(provider.spark).toHaveLength(24);
      expect(provider.spark.every((point: unknown) => point === null)).toBe(true);
    }
    expect(JSON.stringify(res.body)).not.toContain('tvdb-cle-test-0001');
  });

  it('401 sans session, 403 pour un autre compte et sans profil administrateur, sur toutes les routes', async () => {
    rig = await startAdmin();
    const bob = await inviteAndRegister(rig.app, rig.owner, 'bob');
    for (const path of ['/admin/providers', '/admin/storage', '/admin/tasks']) {
      expect((await request(rig.app, 'GET', path)).status).toBe(401);
      expect((await request(rig.app, 'GET', path, { token: bob.token, headers: { 'x-profile-id': bob.profile } })).status).toBe(403);
      expect((await request(rig.app, 'GET', path, { token: rig.owner.token })).status).toBe(403);
    }
    expect((await request(rig.app, 'POST', '/admin/providers/cinemeta/test')).status).toBe(401);
    expect((await request(rig.app, 'POST', '/admin/providers/cinemeta/test', { token: bob.token, headers: { 'x-profile-id': bob.profile } })).status).toBe(403);
  });
});

describe('POST /admin/providers/:id/test : gardes et refus', () => {
  it('propriétaire sans élévation (ou jeton invalide) : 403 elevation_required, aucun appel fournisseur ni audit', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    const missing = await rig.call<any>('POST', '/admin/providers/cinemeta/test');
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('elevation_required');
    const forged = await rig.call<any>('POST', '/admin/providers/cinemeta/test', { elevation: 'jeton-invente' });
    expect(forged.body.error).toBe('elevation_required');
    expect(fake.calls).toHaveLength(0);
    expect((await rig.call<any>('GET', '/admin/audit?action=provider.test')).body.entries).toEqual([]);
  });

  it('fournisseur inconnu 404 ; AllDebrid et fournisseurs sans clé refusés 400, sans aucun appel', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    expect((await rig.call<any>('POST', '/admin/providers/inconnu/test', { elevation: await rig.elevate() })).body.error).toBe('provider_not_found');
    expect((await rig.call('POST', '/admin/providers/inconnu/test', { elevation: await rig.elevate() })).status).toBe(404);
    const alldebrid = await rig.call<any>('POST', '/admin/providers/alldebrid/test', { elevation: await rig.elevate() });
    expect(alldebrid.status).toBe(400);
    expect(alldebrid.body.error).toBe('not_testable');
    expect((await rig.call('POST', '/admin/providers/rows/test', { elevation: await rig.elevate() })).status).toBe(400);
    expect((await rig.call('POST', '/admin/providers/tmdb/test', { elevation: await rig.elevate() })).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('requête légère avec la clé du serveur, réponse {id, ok, status, latencyMs}, audit, rien de secret en retour', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'or-cle-secrete-abcdef123456');
    const fake = fakeFetch(() => new Response('{"data":{"label":"or-cle-secrete-abcdef123456"}}', { status: 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    const res = await rig.call<any>('POST', '/admin/providers/openrouter/test', { elevation: await rig.elevate() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'openrouter', ok: true, status: 200, latencyMs: expect.any(Number) });
    expect(JSON.stringify(res.body)).not.toContain('or-cle-secrete');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe('https://openrouter.ai/api/v1/auth/key');
    expect((fake.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer or-cle-secrete-abcdef123456');
    const audit = await rig.call<any>('GET', '/admin/audit?action=provider.test');
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0]).toMatchObject({ target: 'openrouter', actor: 'alice' });
  });

  it('cinemeta (public) sans clé : requête GET vers Cinemeta', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    const res = await rig.call<any>('POST', '/admin/providers/cinemeta/test', { elevation: await rig.elevate() });
    expect(res.body).toMatchObject({ id: 'cinemeta', ok: true, status: 200 });
    expect(fake.calls[0]?.url).toBe('https://v3-cinemeta.strem.io/meta/movie/tt0133093.json');
    expect(fake.calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  it('clé refusée (401) : rejected ; autre erreur : http ; sans réponse : network', async () => {
    vi.stubEnv('FANART_API_KEY', 'fanart-cle-test-0000001');
    let status = 401;
    const fake = fakeFetch(() => {
      if (status === -1) throw new TypeError('fetch failed');
      return new Response('', { status });
    });
    rig = await startAdmin({ fetch: fake.fn });
    expect((await rig.call<any>('POST', '/admin/providers/fanart/test', { elevation: await rig.elevate() })).body).toMatchObject({ ok: false, status: 401, error: 'rejected' });
    status = 500;
    expect((await rig.call<any>('POST', '/admin/providers/fanart/test', { elevation: await rig.elevate() })).body).toMatchObject({ ok: false, status: 500, error: 'http' });
    status = -1;
    const network = await rig.call<any>('POST', '/admin/providers/fanart/test', { elevation: await rig.elevate() });
    expect(network.body).toMatchObject({ ok: false, status: null, error: 'network' });
    expect(JSON.stringify(network.body)).not.toContain('fanart-cle');
  });

  it('TheTVDB : v4 refusée (clé legacy) puis repli sur v3 ; une seule requête si v4 accepte', async () => {
    vi.stubEnv('TVDB_API_KEY', 'tvdb-legacy-0123456789abcdef');
    vi.stubEnv('TVDB_PIN', '1234');
    let v4Status = 401;
    const fake = fakeFetch((url) => new Response('{}', { status: url.includes('api4.') ? v4Status : 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    const legacy = await rig.call<any>('POST', '/admin/providers/tvdb/test', { elevation: await rig.elevate() });
    expect(legacy.body).toMatchObject({ id: 'tvdb', ok: true, status: 200 });
    expect(fake.calls.map((call) => call.url)).toEqual(['https://api4.thetvdb.com/v4/login', 'https://api.thetvdb.com/login']);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).toEqual({ apikey: 'tvdb-legacy-0123456789abcdef', pin: '1234' });
    expect(JSON.parse(String(fake.calls[1]?.init.body))).toEqual({ apikey: 'tvdb-legacy-0123456789abcdef' });
    v4Status = 200;
    fake.calls.length = 0;
    const v4 = await rig.call<any>('POST', '/admin/providers/tvdb/test', { elevation: await rig.elevate() });
    expect(v4.body).toMatchObject({ ok: true, status: 200 });
    expect(fake.calls).toHaveLength(1);
  });

  it('délai dépassé (4 s) : timeout, sans statut', async () => {
    rig = await startAdmin({ fetch: hangingFetch() });
    const res = await rig.call<any>('POST', '/admin/providers/cinemeta/test', { elevation: await rig.elevate() });
    expect(res.body).toMatchObject({ id: 'cinemeta', ok: false, status: null, error: 'timeout' });
    expect(res.body.latencyMs).toBeGreaterThanOrEqual(3900);
    expect(res.body.latencyMs).toBeLessThan(8000);
  }, 20_000);

  it('10 tests par minute et par IP, le 11e répond 429', async () => {
    const fake = fakeFetch(() => new Response('{}', { status: 200 }));
    rig = await startAdmin({ fetch: fake.fn });
    for (let i = 0; i < 10; i += 1) expect((await rig.call('POST', '/admin/providers/cinemeta/test', { elevation: await rig.elevate() })).status).toBe(200);
    const limited = await rig.call<any>('POST', '/admin/providers/cinemeta/test', { elevation: await rig.elevate() });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(fake.calls).toHaveLength(10);
  });
});

describe('/admin/storage', () => {
  it('KV par préfixe avec taux de succès ; R2 et base indisponibles (null) ; sans administration de cache : vide', async () => {
    const metrics = createMemoryMetrics();
    const cache = fakeCacheAdmin({ packs: 12, issued: 3 });
    rig = await startAdmin({ metrics, cacheAdmin: cache });
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', true);
    metrics.sink.cache('packs', false);
    const res = await rig.call<any>('GET', '/admin/storage');
    expect(res.status).toBe(200);
    expect(res.body.kv.prefixes.find((p: any) => p.prefix === 'packs')).toEqual({ prefix: 'packs', keys: 12, exact: true, hitRate: 0.75 });
    expect(res.body.kv.prefixes.find((p: any) => p.prefix === 'hosts')).toMatchObject({ keys: 0, hitRate: null });
    expect(res.body.r2).toEqual([
      { bucket: 'TV', objects: null, bytes: null, truncated: false },
      { bucket: 'META', objects: null, bytes: null, truncated: false },
      { bucket: 'AVATARS', objects: null, bytes: null, truncated: false },
    ]);
    expect(res.body.do).toEqual({ sizeBytes: null, tables: [] });
    expect(Number.isNaN(Date.parse(res.body.cachedAt))).toBe(false);

    // Résultat gardé 5 minutes : un changement côté KV n'apparaît pas tout de suite.
    cache.counts.packs = 99;
    const again = await rig.call<any>('GET', '/admin/storage');
    expect(again.body).toEqual(res.body);
  });

  it('sans ports d’exploitation : base et buckets indisponibles (null), réponse valide', async () => {
    rig = await startAdmin();
    const res = await rig.call<any>('GET', '/admin/storage');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.kv.prefixes)).toBe(true);
    expect(res.body.do).toEqual({ sizeBytes: null, tables: [] });
    expect(res.body.r2.map((b: any) => b.bucket)).toEqual(['TV', 'META', 'AVATARS']);
    expect(res.body.r2.every((b: any) => b.objects === null && b.bytes === null)).toBe(true);
  });

  it('R2 : objets et octets cumulés ; plafond atteint = truncated ; erreur = null ; base SQLite comptée', async () => {
    const tv = fakeBucket({ objects: 3, size: 10 });
    const meta = fakeBucket({ endless: true });
    const avatars = fakeBucket({ broken: true });
    rig = await startAdmin({
      ops: {
        r2: { TV: tv, META: meta, AVATARS: avatars },
        sqlStats: () => Promise.resolve({ sizeBytes: 4096, tables: [{ name: 'users', rows: 5 }, { name: 'casse', rows: null }] }),
      },
    });
    const res = await rig.call<any>('GET', '/admin/storage');
    expect(res.body.r2).toEqual([
      { bucket: 'TV', objects: 3, bytes: 30, truncated: false },
      { bucket: 'META', objects: R2_MAX_PAGES * R2_PAGE_LIMIT, bytes: R2_MAX_PAGES * R2_PAGE_LIMIT, truncated: true },
      { bucket: 'AVATARS', objects: null, bytes: null, truncated: false },
    ]);
    expect(meta.calls).toBe(R2_MAX_PAGES);
    expect(res.body.do).toEqual({ sizeBytes: 4096, tables: [{ name: 'users', rows: 5 }, { name: 'casse', rows: null }] });
  });
});

describe('/admin/tasks', () => {
  it('dernier cron TV, prochain passage à heure fixe (6 h, UTC), purges avec progression', async () => {
    const lastCron: TvCronState = {
      startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 2 * 3600_000 + 252_000).toISOString(),
      durationMs: 252_000,
      ok: true,
      channels: 708,
      programmes: 15_230,
      epgOk: true,
      error: null,
    };
    const cache = fakeCacheAdmin({ packs: 7 });
    rig = await startAdmin({ tvAdmin: { lastCron: () => Promise.resolve(lastCron), rerun: () => Promise.resolve(undefined) }, cacheAdmin: cache });
    const elevation = await rig.elevate();
    const before = (await rig.call<any>('GET', '/admin/tasks')).body;
    expect(before.tv.lastCron).toEqual(lastCron);
    expect(before.tv.overdue).toBe(false);
    const next = Date.parse(before.tv.nextRunAt);
    expect(next % SIX_HOURS).toBe(0);
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(SIX_HOURS);
    expect(before.purges).toEqual([]);

    const started = await rig.call<any>('POST', '/admin/caches/packs/purge', { elevation });
    expect((await rig.call<any>('GET', '/admin/tasks')).body.purges[0]).toMatchObject({ id: started.body.id, status: 'running', progress: null });
    cache.finish(started.body.id);
    expect((await rig.call<any>('GET', '/admin/tasks')).body.purges[0]).toMatchObject({ status: 'done', deleted: 7, progress: 1 });
  });

  it('retard : cron absent ou dernier passage vieux de plus de 7 h', async () => {
    const old: TvCronState = {
      startedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      finishedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      durationMs: 1000,
      ok: true,
      channels: 1,
      programmes: 1,
      epgOk: true,
      error: null,
    };
    rig = await startAdmin({ tvAdmin: { lastCron: () => Promise.resolve(old), rerun: () => Promise.resolve(undefined) } });
    expect((await rig.call<any>('GET', '/admin/tasks')).body.tv.overdue).toBe(true);
    await rig.app.close();
    rig = await startAdmin({ tvAdmin: { lastCron: () => Promise.resolve(null), rerun: () => Promise.resolve(undefined) } });
    expect((await rig.call<any>('GET', '/admin/tasks')).body.tv).toMatchObject({ lastCron: null, overdue: true });
  });

  it('sans API TV (Node) : cron absent, prochain passage null, pas de retard', async () => {
    rig = await startAdmin();
    const res = await rig.call<any>('GET', '/admin/tasks');
    expect(res.body).toEqual({ tv: { lastCron: null, nextRunAt: null, overdue: false }, purges: [] });
  });
});

describe('fonctions pures : stockage, R2, cron', () => {
  it('nextTvRun : premier multiple de 6 h UTC strictement après maintenant', () => {
    expect(nextTvRun(Date.UTC(2026, 9, 20, 7, 30))).toBe('2026-10-20T12:00:00.000Z');
    expect(nextTvRun(Date.UTC(2026, 9, 20, 12, 0))).toBe('2026-10-20T18:00:00.000Z');
    expect(nextTvRun(Date.UTC(2026, 9, 20, 23, 59, 59))).toBe('2026-10-21T00:00:00.000Z');
  });

  it('tvOverdue : absence de trace = retard ; passage récent = à jour ; au-delà de 7 h = retard', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const cron = (startedAt: number): TvCronState => ({ startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(startedAt).toISOString(), durationMs: 0, ok: true, channels: 0, programmes: 0, epgOk: true, error: null });
    expect(tvOverdue(null, now)).toBe(true);
    expect(tvOverdue(cron(now - 5 * 3600_000), now)).toBe(false);
    expect(tvOverdue(cron(now - 7 * 3600_000), now)).toBe(false);
    expect(tvOverdue(cron(now - 8 * 3600_000), now)).toBe(true);
  });

  it('r2UsageOf : pages successives jusqu’au bout ; liste en erreur ou absente = null', async () => {
    const pages: R2Page[] = [
      { objects: [{ size: 5 }, { size: 6 }], truncated: true, cursor: 'suite' },
      { objects: [{ size: 7 }], truncated: false },
    ];
    const seen: unknown[] = [];
    const bucket: R2Listing = { list: (options) => { seen.push(options); return Promise.resolve(pages.shift() as R2Page); } };
    expect(await r2UsageOf(bucket)).toEqual({ objects: 3, bytes: 18, truncated: false });
    expect(seen).toEqual([{ limit: 1000 }, { limit: 1000, cursor: 'suite' }]);
    expect(await r2UsageOf(undefined)).toEqual({ objects: null, bytes: null, truncated: false });
    expect(await r2UsageOf(fakeBucket({ broken: true }))).toEqual({ objects: null, bytes: null, truncated: false });
  });

  it('sqlStatsOf : lignes par table (COUNT), tables internes exclues, nom entre guillemets échappé, erreur = null', () => {
    // Base simulée (node:sqlite n'existe pas sous Workers) : répond au schéma et aux COUNT(*) des tables connues.
    const counts: Record<string, number | 'broken'> = { a: 2, 'b"q': 0, casse: 'broken' };
    const schema = ['_cf_KV', 'a', 'b"q', 'casse', 'sqlite_sequence'];
    const queries: string[] = [];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        if (sql.includes('sqlite_master')) return { get: () => undefined, all: () => schema.map((name) => ({ name })), run: () => ({ changes: 0 }) };
        const quoted = /FROM "((?:[^"]|"")*)"/.exec(sql)?.[1] ?? '';
        const name = quoted.replace(/""/g, '"');
        return {
          get: () => {
            const value = counts[name];
            if (value === undefined || value === 'broken') throw new Error('table illisible');
            return { n: value };
          },
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      },
      exec: () => undefined,
      transaction: <T>(work: () => T) => work(),
      close: () => undefined,
    } as unknown as SqlDb;
    const stats = sqlStatsOf(db, 8192);
    expect(stats).toEqual({
      sizeBytes: 8192,
      tables: [
        { name: 'a', rows: 2 },
        { name: 'b"q', rows: 0 },
        { name: 'casse', rows: null },
      ],
    });
    expect(queries).toContain('SELECT COUNT(*) AS n FROM "b""q"');
  });
});
