/* eslint-disable @typescript-eslint/no-explicit-any -- corps JSON de tests */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATENCY_BOUNDS_MS, MemoryMetricsStore, MetricsAccumulator, latencyIndex, noopSink, type MetricsService } from '../src/metrics/core.js';
import { buildProviderHealth, DOWN_MIN_CALLS, HEALTH_WINDOW_HOURS, providerStatus } from '../src/metrics/health.js';
import { recordOutbound, metricsService } from '../src/metrics/index.js';
import { createMemoryMetrics } from '../src/metrics/memory.js';
import { HEALTH_HOURS, HOUR_MS, healthWindowStart, hourOf, providerOfUrl, type ProviderName } from '../src/metrics/providers.js';
import { createRemoteMetrics } from '../src/platform/workers/metrics.js';
import { fetchBytes, type FetchFn, SourceError } from '../src/sources/http.js';
import { type AdminRig, startAdmin } from './admin-harness.js';

/** 18 octobre 2026, 12 h 30 UTC : heure H = 12 h. */
const T0 = Date.UTC(2026, 9, 18, 12, 30, 0);
const H = hourOf(T0);

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Accumulateur et stockage pilotés par une horloge fixe ; `health()` versé au stockage puis calculé. */
function harness(start: number) {
  let now = start;
  const acc = new MetricsAccumulator(() => now);
  const store = new MemoryMetricsStore(() => now);
  return {
    at(next: number): void {
      now = next;
    },
    sink: acc,
    health() {
      store.ingest(acc.take());
      return buildProviderHealth(store.providerHours(), now);
    },
    rows() {
      store.ingest(acc.take());
      return store.providerHours();
    },
  };
}

describe('providerOfUrl : seuls les hôtes des API de fournisseurs sont mesurés', () => {
  it.each([
    ['https://api.themoviedb.org/3/tv/1?language=fr-FR', 'tmdb'],
    ['https://API.THEMOVIEDB.ORG/3/movie/1', 'tmdb'],
    ['https://api4.thetvdb.com/v4/login', 'tvdb'],
    ['https://api.thetvdb.com/login', 'tvdb'],
    ['https://openrouter.ai/api/v1/auth/key', 'openrouter'],
    ['https://v3-cinemeta.strem.io/meta/series/tt1.json', 'cinemeta'],
    ['https://api.mdblist.com/imdb/movie/tt0133093?apikey=x', 'mdblist'],
    ['https://webservice.fanart.tv/v3/movies/603?api_key=x', 'fanart'],
  ] as const)('%s -> %s', (url, provider) => {
    expect(providerOfUrl(url)).toBe(provider);
  });

  it('images, addons amont, URL illisible : non mesurés', () => {
    expect(providerOfUrl('https://image.tmdb.org/t/p/w500/a.jpg')).toBeUndefined();
    expect(providerOfUrl('https://addon.example/stream/movie/tt1.json')).toBeUndefined();
    expect(providerOfUrl('pas une url')).toBeUndefined();
  });
});

describe('statut : seuils et minimum d appels pour « down »', () => {
  it.each([
    [0, 0, 'unknown'],
    [50, 0, 'ok'],
    [49, 1, 'ok'], // 98 % pile
    [48, 2, 'degraded'], // 96 %
    [90, 10, 'degraded'], // 90 % pile
    [89, 11, 'down'], // 89 % avec 100 appels
    [0, DOWN_MIN_CALLS, 'down'], // 0 % avec 5 appels
    [0, 4, 'degraded'], // moins de 5 appels : jamais « down »
    [1, 3, 'degraded'], // 4 appels, 25 % : pas assez d'appels pour « down »
    [1, 4, 'down'], // 5 appels, 20 %
  ] as const)('%i réussis, %i échecs -> %s', (ok, fail, status) => {
    expect(providerStatus(ok, fail)).toBe(status);
  });
});

describe('registre horaire : succès, échecs, latence, rétention', () => {
  it('compte les succès et les échecs ; la latence ne vient que des appels réussis ; dernier échec daté', () => {
    const h = harness(T0);
    h.sink.outbound('tmdb', 'ok', 7);
    h.sink.outbound('tmdb', 'ok', 4000);
    h.sink.outbound('tmdb', 'fail', 12_000);
    const [row] = h.rows();
    expect(row).toMatchObject({ hour: H, provider: 'tmdb', ok: 2, fail: 1, lastFailAt: T0 });
    expect(row?.latency.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(row?.latency[latencyIndex(7)]).toBe(1);
    expect(row?.latency[latencyIndex(4000)]).toBe(1);
  });

  it('un appel après minuit UTC va dans l heure suivante', () => {
    const h = harness(Date.UTC(2026, 9, 18, 23, 59, 59));
    h.sink.outbound('tvdb', 'ok', 10);
    h.at(Date.UTC(2026, 9, 19, 0, 0, 0));
    h.sink.outbound('tvdb', 'ok', 10);
    expect(h.rows().map((row) => row.hour)).toEqual([Date.UTC(2026, 9, 18, 23), Date.UTC(2026, 9, 19, 0)]);
  });

  it('fournisseur hors liste, issue inconnue : rien n entre dans le registre', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.outbound('inconnu' as ProviderName, 'ok', 5);
    acc.outbound('tmdb', 'timeout' as 'ok', 5);
    expect(acc.isEmpty()).toBe(true);
    expect(acc.take().health).toBeUndefined();
  });

  it('un lot non envoyé est remis avec ses compteurs, additionnés à ceux du suivant', () => {
    const acc = new MetricsAccumulator(() => T0);
    acc.outbound('mdblist', 'ok', 30);
    const failed = acc.take();
    acc.outbound('mdblist', 'fail', 30);
    acc.restore(failed);
    expect(acc.take().health).toEqual([expect.objectContaining({ provider: 'mdblist', ok: 1, fail: 1, lastFailAt: T0 })]);
  });

  it('rétention de 8 jours, heure courante incluse : la 192e heure est retirée du stockage', () => {
    let now = T0 + (HEALTH_HOURS - 1) * HOUR_MS;
    const acc = new MetricsAccumulator(() => T0);
    const store = new MemoryMetricsStore(() => now);
    acc.outbound('cinemeta', 'ok', 20);
    store.ingest(acc.take());
    expect(store.providerHours()).toHaveLength(1);
    now = T0 + HEALTH_HOURS * HOUR_MS;
    expect(store.providerHours()).toHaveLength(0);
    expect(healthWindowStart(now)).toBe(H + HOUR_MS);
  });
});

describe('santé : taux sur 24 h, p95, sparkline, dernier échec', () => {
  it('taux de succès, statut, et absence de donnée (null, unknown)', () => {
    const h = harness(T0);
    for (let i = 0; i < 8; i += 1) h.sink.outbound('tmdb', 'ok', 30);
    for (let i = 0; i < 2; i += 1) h.sink.outbound('tmdb', 'fail', 30);
    for (let i = 0; i < 97; i += 1) h.sink.outbound('cinemeta', 'ok', 30);
    for (let i = 0; i < 3; i += 1) h.sink.outbound('cinemeta', 'fail', 30);
    const health = h.health();
    expect(health.tmdb).toMatchObject({ successRate: 0.8, status: 'down' });
    expect(health.cinemeta).toMatchObject({ successRate: 0.97, status: 'degraded' });
    expect(health.openrouter).toEqual({ successRate: null, p95: null, spark: Array(HEALTH_WINDOW_HOURS).fill(null), lastFailureAt: null, status: 'unknown' });
    // Le registre ne compte jamais « rows » : fournisseur toujours sans donnée.
    expect(health.rows.status).toBe('unknown');
  });

  it('p95 : estimation sur l histogramme des appels réussis (95 % à 7 ms, 5 % à 4 s -> 10 ms)', () => {
    const h = harness(T0);
    for (let i = 0; i < 95; i += 1) h.sink.outbound('fanart', 'ok', 7);
    for (let i = 0; i < 5; i += 1) h.sink.outbound('fanart', 'ok', 4000);
    expect(h.health().fanart.p95).toBe(LATENCY_BOUNDS_MS[1]);
  });

  it('les appels de plus de 24 h ne comptent ni dans le taux ni dans le p95, mais le dernier échec reste daté', () => {
    const h = harness(T0);
    h.sink.outbound('mdblist', 'fail', 10);
    h.at(T0 + 30 * HOUR_MS);
    h.sink.outbound('mdblist', 'ok', 40);
    const health = h.health();
    expect(health.mdblist).toMatchObject({ successRate: 1, status: 'ok', lastFailureAt: new Date(T0).toISOString() });
    expect(health.mdblist.spark.filter((point) => point !== null)).toEqual([1]);
  });

  it('sparkline : 24 points, du plus ancien (H - 23 h) à l heure courante ; null là où il n y a pas d appel', () => {
    const h = harness(T0 - 23 * HOUR_MS);
    h.sink.outbound('openrouter', 'ok', 10); // H - 23 h : premier point
    h.at(T0 - 2 * HOUR_MS);
    h.sink.outbound('openrouter', 'ok', 10);
    h.sink.outbound('openrouter', 'fail', 10); // H - 2 h : 1 réussi sur 2 -> 0.5 (point 21)
    h.at(T0);
    const spark = h.health().openrouter.spark;
    expect(spark).toHaveLength(24);
    expect(spark[0]).toBe(1);
    expect(spark[21]).toBe(0.5);
    expect(spark.filter((point) => point !== null)).toHaveLength(2);
    expect(spark[23]).toBeNull();
  });

  it('un fournisseur dont les échecs sont tous anciens (hors fenêtre) : taux null, statut unknown, dernier échec présent', () => {
    const h = harness(T0);
    h.sink.outbound('tvdb', 'fail', 10);
    h.at(T0 + 3 * 24 * HOUR_MS);
    const health = h.health();
    expect(health.tvdb).toMatchObject({ successRate: null, p95: null, status: 'unknown', lastFailureAt: new Date(T0).toISOString() });
  });
});

describe('appels réels : fetchBytes mesure les fournisseurs (sans clé, sans bloquer)', () => {
  const service = (): MetricsService => {
    const found = metricsService();
    if (found === undefined) throw new Error('métriques absentes');
    return found;
  };
  /** Compteurs cumulés (succès, échecs) d'un fournisseur sur la rétention, dans le service de la plateforme de test. */
  async function countsOf(provider: ProviderName): Promise<{ ok: number; fail: number }> {
    const rows = (await service().providerHours?.()) ?? [];
    return rows.filter((row) => row.provider === provider).reduce((sum, row) => ({ ok: sum.ok + row.ok, fail: sum.fail + row.fail }), { ok: 0, fail: 0 });
  }
  const scripted = (respond: () => Response | Promise<Response>): FetchFn => (() => Promise.resolve(respond())) as unknown as FetchFn;

  it('réponse 2xx et 4xx : succès ; 5xx : échec ; la réponse reste celle du fournisseur', async () => {
    const before = await countsOf('tmdb');
    const ok = await fetchBytes(scripted(() => new Response('{}', { status: 200 })), 'https://api.themoviedb.org/3/tv/1');
    const notFound = await fetchBytes(scripted(() => new Response('{}', { status: 404 })), 'https://api.themoviedb.org/3/tv/2');
    const broken = await fetchBytes(scripted(() => new Response('oops', { status: 503 })), 'https://api.themoviedb.org/3/tv/3');
    expect([ok.status, notFound.status, broken.status]).toEqual([200, 404, 503]);
    const after = await countsOf('tmdb');
    expect(after.ok - before.ok).toBe(2);
    expect(after.fail - before.fail).toBe(1);
  });

  it('erreur réseau et délai dépassé : échecs, et l erreur de la requête est inchangée', async () => {
    const before = await countsOf('openrouter');
    const network = fetchBytes(
      scripted(() => {
        throw new TypeError('fetch failed');
      }),
      'https://openrouter.ai/api/v1/auth/key',
    );
    await expect(network).rejects.toBeInstanceOf(SourceError);
    const hanging: FetchFn = ((_input: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('annulée', 'AbortError')));
      })) as unknown as FetchFn;
    await expect(fetchBytes(hanging, 'https://openrouter.ai/api/v1/auth/key', {}, 20)).rejects.toThrow('délai dépassé');
    const after = await countsOf('openrouter');
    expect(after.fail - before.fail).toBe(2);
    expect(after.ok - before.ok).toBe(0);
  });

  it('hôte non mesuré ou URL refusée avant envoi : aucun compteur', async () => {
    const before = await countsOf('tmdb');
    await fetchBytes(scripted(() => new Response('x', { status: 200 })), 'https://image.tmdb.org/t/p/w500/a.jpg');
    await expect(fetchBytes(scripted(() => new Response('x')), 'ftp://api.themoviedb.org/3/tv/1')).rejects.toBeInstanceOf(SourceError);
    expect(await countsOf('tmdb')).toEqual(before);
  });

  it('la clé d une requête ne sort jamais dans les lignes de santé', async () => {
    const secret = 'CLE-SECRETE-MDBLIST-0123456789';
    await fetchBytes(scripted(() => new Response('{}', { status: 200 })), `https://api.mdblist.com/imdb/movie/tt0133093?apikey=${secret}`);
    const dump = JSON.stringify(await service().providerHours?.());
    expect(dump).toContain('mdblist');
    expect(dump).not.toContain(secret);
  });

  it('mesure sans effet : recordOutbound n échoue jamais, même avec une latence incohérente', () => {
    expect(() => recordOutbound('tmdb', 'ok', Number.NaN)).not.toThrow();
    expect(() => recordOutbound('tmdb', 'ok', -5)).not.toThrow();
    expect(() => recordOutbound('inconnu' as ProviderName, 'fail', 1)).not.toThrow();
  });
});

describe('stockage en échec : l instrumentation ne fait pas échouer la requête', () => {
  it('un envoi refusé par le Durable Object est remis dans l accumulateur, sans exception', async () => {
    const batches: any[] = [];
    let attempts = 0;
    const namespace = {
      getByName: () => ({
        ingest: (batch: unknown) => {
          attempts += 1;
          batches.push(batch);
          return attempts === 1 ? Promise.reject(new Error('DO indisponible')) : Promise.resolve();
        },
        providerHours: () => Promise.resolve([]),
      }),
    };
    const service = createRemoteMetrics(namespace as any, () => undefined);
    service.sink.outbound('tmdb', 'fail', 10);
    await expect(service.flush?.()).resolves.toBeUndefined();
    service.sink.outbound('tmdb', 'ok', 10);
    await expect(service.flush?.()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(batches[1].health).toEqual([expect.objectContaining({ provider: 'tmdb', ok: 1, fail: 1 })]);
  });

  it('la lecture de santé échoue : la route répond quand même, avec des statuts unknown', async () => {
    const metrics = {
      sink: noopSink,
      report: () => Promise.reject(new Error('x')),
      providerHours: () => Promise.reject(new Error('DO indisponible')),
    } as unknown as MetricsService;
    const rig: AdminRig = await startAdmin({ metrics });
    try {
      const res = await rig.call<any>('GET', '/admin/providers');
      expect(res.status).toBe(200);
      expect(res.body.providers.every((provider: any) => provider.status === 'unknown' && provider.successRate === null)).toBe(true);
    } finally {
      await rig.app.close();
    }
  });
});

describe('GET /admin/providers : santé mesurée, sans fuite de clé', () => {
  it('statuts, taux, p95, sparkline et dernier échec viennent du registre ; aucune clé en réponse', async () => {
    vi.stubEnv('TMDB_TOKEN', 'TOKEN-TMDB-SECRET-ABCDEFGH123456');
    const metrics = createMemoryMetrics();
    for (let i = 0; i < 8; i += 1) metrics.sink.outbound('tmdb', 'ok', 30);
    for (let i = 0; i < 2; i += 1) metrics.sink.outbound('tmdb', 'fail', 30);
    for (let i = 0; i < 50; i += 1) metrics.sink.outbound('mdblist', 'ok', 40);
    const rig = await startAdmin({ metrics });
    try {
      const res = await rig.call<any>('GET', '/admin/providers');
      expect(res.status).toBe(200);
      const byId = new Map(res.body.providers.map((p: any) => [p.id, p]));
      expect(byId.get('tmdb')).toMatchObject({ successRate: 0.8, status: 'down', testable: true });
      expect((byId.get('tmdb') as any).spark).toHaveLength(24);
      expect((byId.get('tmdb') as any).spark[23]).toBe(0.8);
      expect((byId.get('tmdb') as any).lastFailureAt).toEqual(expect.any(String));
      expect(byId.get('mdblist')).toMatchObject({ successRate: 1, status: 'ok' });
      expect(typeof (byId.get('mdblist') as any).p95).toBe('number');
      expect(byId.get('openrouter')).toMatchObject({ successRate: null, p95: null, lastFailureAt: null, status: 'unknown' });
      expect(JSON.stringify(res.body)).not.toContain('TOKEN-TMDB-SECRET');
    } finally {
      await rig.app.close();
    }
  });

  it('la forme des compteurs existants (/admin/metrics) est inchangée', async () => {
    const metrics = createMemoryMetrics();
    metrics.sink.outbound('tmdb', 'ok', 30);
    const rig = await startAdmin({ metrics });
    try {
      const res = await rig.call<any>('GET', '/admin/metrics?range=1h');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ['alldebrid', 'caches', 'errors', 'from', 'groups', 'providers', 'range', 'series', 'stepSec', 'to', 'totals', 'upstreams'].sort(),
      );
      expect(res.body.providers.totals).toEqual([]);
    } finally {
      await rig.app.close();
    }
  });
});

describe('constantes', () => {
  it('fenêtre de 24 h, 8 jours de rétention en heures, tranche d une heure', () => {
    expect(HEALTH_WINDOW_HOURS).toBe(24);
    expect(HEALTH_HOURS).toBe(192);
    expect(HOUR_MS).toBe(3_600_000);
  });
});
