// Console d'administration, espace Plateforme : tableau des sources (courbe 24 h à trous, tests, 429, « — »), test de plusieurs
// fournisseurs à la fois, stockage (null, « ≥ »), tâches (progression, rafraîchissement toutes les 5 s pendant une purge).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/data/adminApi';
import type { ProviderStatus, StorageReport } from '../src/data/adminApi';
import { fmtInt } from '../src/data/adminModel';
import { UserApiError } from '../src/data/userApi';
import { cachesHTML, fmtBytes, jobView, runProviderTests, sourcesHTML, sparkPath, syncTasksPoll, tasksHTML } from '../src/ui/admin/platform.js';

vi.mock('../src/data/adminApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/adminApi')>();
  return { ...actual, getTasks: vi.fn(async () => ({ tv: { lastCron: null, nextRunAt: null, overdue: false }, purges: [] })) };
});

const ready = <T>(value: T) => ({ status: 'ready', error: '', value });
const provider = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'tmdb', label: 'TMDB', successRate: 0.996, p95: 210, spark: Array.from({ length: 24 }, () => 0.99),
  lastFailureAt: null, status: 'ok', testable: true, ...over,
});
const sources = (providers: ProviderStatus[], extra: Record<string, unknown> = {}) => ({
  providers: ready({ providers }), providerTests: { rows: {}, note: '' }, srcPerf: { status: 'idle', value: null, error: '' }, ...extra,
}) as any;
const ctxOf = (S: any) => ({ S, isCurrent: () => true, paint: vi.fn() });
const ok = (id: string, latencyMs = 120) => ({ id, ok: true, status: 200, latencyMs });

beforeEach(() => { vi.mocked(api.getTasks).mockClear(); });

describe('sparkline 24 h', () => {
  it('un null coupe le tracé : pas d’interpolation sur une heure sans donnée', () => {
    expect(sparkPath([1, null, 0.5])).toBe('M0.00 1.00 l0.01 0 M100.00 12.00 l0.01 0');
    expect(sparkPath([0, 1])).toBe('M0.00 23.00 L100.00 1.00');
    expect(sparkPath([null, null])).toBe('');
  });
});

describe('sources et addons : tableau', () => {
  it('valeurs formatées ; null rendu « — » (succès, p95, dernier échec) ; courbe absente sans donnée', () => {
    const html = sourcesHTML(sources([
      provider(),
      provider({ id: 'mdblist', label: 'MDBList', successRate: null, p95: null, spark: [null, null], lastFailureAt: null, status: 'unknown' }),
    ]));
    expect(html).toContain('<td data-label="Succès" class="is-num">99,6 %</td>');
    expect(html).toContain('<td data-label="p95" class="is-num">210 ms</td>');
    expect(html).toContain('<td data-label="Succès" class="is-num">—</td>');
    expect(html).toContain('<td data-label="p95" class="is-num">—</td>');
    expect(html).toContain('<td data-label="Dernier échec">—</td>');
    expect(html).toContain('Aucun appel sur 24 h');
    expect(html).not.toContain('>Inconnu<');
    expect(html.match(/adm-curve is-ok/g)).toHaveLength(1);
    expect(html).not.toContain('adm-curve is-unknown');
  });

  it('un fournisseur non testable : bouton Tester désactivé avec explication ; « Tester tout » désactivé sans cible', () => {
    const html = sourcesHTML(sources([provider({ testable: false })]));
    expect(html).toMatch(/<button[^>]*data-adm-test="tmdb"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*data-adm-test="tmdb"[^>]*title="Clé non configurée"/);
    expect(html).toContain('<span class="adm-dim">Clé non configurée</span>');
    const none = sourcesHTML(sources([provider({ testable: false })]));
    expect(none).toMatch(/<button[^>]*data-adm-testall[^>]*disabled/);
  });

  it('fournisseur testable : pas d’explication « Clé non configurée », bouton actif', () => {
    const html = sourcesHTML(sources([provider({ testable: true })]));
    expect(html).not.toContain('Clé non configurée');
    expect(html).not.toMatch(/<button[^>]*data-adm-test="tmdb"[^>]*disabled/);
  });

  it('valeurs de fournisseur échappées', () => {
    const html = sourcesHTML(sources([provider({ label: '<img src=x onerror=alert(1)>' })]));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('bloc addons amont conservé (upstreams de getMetrics)', () => {
    const m = { upstreams: [{ host: 'addon.example', calls: 40, failures: 2, timeouts: 1, avgMs: 120 }] };
    const html = sourcesHTML(sources([provider()], { srcPerf: ready(m) }));
    expect(html).toContain('Santé des addons amont');
    expect(html).toContain('addon.example');
  });
});

describe('tests de fournisseurs', () => {
  it('succès : « OK · latence » sur la ligne', async () => {
    const ctx = ctxOf(sources([provider()]));
    await runProviderTests(ctx, ['tmdb'], async (id) => ok(id, 120));
    expect(ctx.S.providerTests.rows.tmdb.state).toBe('done');
    expect(sourcesHTML(ctx.S)).toContain('OK · 120 ms');
  });

  it('échec signalé par le fournisseur : statut HTTP, cause et latence', async () => {
    const ctx = ctxOf(sources([provider()]));
    await runProviderTests(ctx, ['tmdb'], async (id) => ({ id, ok: false, status: 503, latencyMs: 850, error: 'http' }));
    expect(sourcesHTML(ctx.S)).toContain('Échec · HTTP 503 · erreur HTTP · 850 ms');
  });

  it('429 : le message donne le délai, la série s’arrête et les tests restants ne partent pas', async () => {
    const ctx = ctxOf(sources([provider({ id: 'a', label: 'A' }), provider({ id: 'b', label: 'B' }), provider({ id: 'c', label: 'C' }), provider({ id: 'd', label: 'D' })]));
    const runner = vi.fn(async (id: string) => {
      if (id === 'a') throw new UserApiError(429, 'rate_limited', { retryAfterSec: 30 });
      return ok(id);
    });
    await runProviderTests(ctx, ['a', 'b', 'c', 'd'], runner);
    expect(runner.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(ctx.S.providerTests.rows.a).toEqual({ state: 'error', error: 'Trop de requêtes. Réessaie dans 30 s.' });
    expect(ctx.S.providerTests.rows.c.state).toBe('skipped');
    expect(ctx.S.providerTests.rows.d.state).toBe('skipped');
    expect(ctx.S.providerTests.note).toContain('Trop de requêtes. Réessaie dans 30 s.');
    const html = sourcesHTML(ctx.S);
    expect(html).toContain('Trop de requêtes. Réessaie dans 30 s.');
    expect(html).toContain('Non lancé : limite atteinte.');
  });

  it('au plus deux tests en parallèle', async () => {
    const ctx = ctxOf(sources([provider()]));
    let inFlight = 0;
    let max = 0;
    const runner = async (id: string) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return ok(id);
    };
    await runProviderTests(ctx, ['a', 'b', 'c', 'd', 'e'], runner);
    expect(max).toBe(2);
    expect(Object.values(ctx.S.providerTests.rows).every((r: any) => r.state === 'done')).toBe(true);
  });

  it('pendant un test : « Test en cours… » et bouton marqué occupé', () => {
    const html = sourcesHTML(sources([provider()], { providerTests: { rows: { tmdb: { state: 'running' } }, note: '' } }));
    expect(html).toContain('Test en cours…');
    expect(html).toMatch(/data-adm-test="tmdb"[^>]*aria-busy="true"/);
  });
});

describe('caches et stockage', () => {
  const storage = (over: Partial<StorageReport> = {}): StorageReport => ({
    kv: { prefixes: [{ prefix: 'meta:', keys: 1200, exact: true, hitRate: 0.87 }, { prefix: 'streams:', keys: 500, exact: false, hitRate: null }] },
    r2: [
      { bucket: 'TV', objects: 412, bytes: 1536 * 1024 * 1024, truncated: false },
      { bucket: 'META', objects: null, bytes: null, truncated: false },
      { bucket: 'AVATARS', objects: 1000, bytes: 5 * 1024 * 1024, truncated: true },
    ] as StorageReport['r2'],
    do: { sizeBytes: null, tables: [{ name: 'sessions', rows: 42 }, { name: 'messages', rows: null }] },
    cachedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  });
  const page = (st: unknown) => cachesHTML({ caches: ready({ caches: [] }), purges: {}, storage: ready(st) } as any);
  const pageLoading = () => cachesHTML({ caches: ready({ caches: [] }), purges: {}, storage: { status: 'loading', value: null, error: '' } } as any);

  it('KV : clés par préfixe avec « ≥ » si partiel, taux « — » si null', () => {
    const html = page(storage());
    expect(html).toContain('<td data-label="Clés" class="is-num">' + fmtInt(1200) + '</td>');
    expect(html).toContain('≥ ' + fmtInt(500));
    expect(html).toContain('87,0 %');
    expect(html).toContain('<td data-label="Taux de succès" class="is-num">—</td>');
  });

  it('R2 : taille formatée, « indisponible » si null, « ≥ » si tronqué', () => {
    const html = page(storage());
    expect(html).toContain('R2 · TV');
    expect(html).toContain('1,5 Go');
    expect(html).toContain('<td data-label="Objets" class="is-num">indisponible</td>');
    expect(html).toContain('<td data-label="Taille" class="is-num">indisponible</td>');
    expect(html).toContain('≥ ' + fmtInt(1000));
    expect(html).toContain('≥ 5,0 Mo');
  });

  it('Durable Object : taille et lignes « indisponible » si null', () => {
    const html = page(storage());
    expect(html).toContain('<dd>indisponible</dd>');
    expect(html).toContain('<td data-label="Lignes" class="is-num">' + fmtInt(42) + '</td>');
    expect(html).toContain('<td data-label="Lignes" class="is-num">indisponible</td>');
  });

  it('« mis à jour il y a … » d’après cachedAt ; date inconnue sans tomber en erreur', () => {
    expect(page(storage())).toContain('Mis à jour il y a 5 min');
    expect(page(storage({ cachedAt: 'n’importe quoi' }))).toContain('Date de mise à jour inconnue');
  });

  it('tailles lisibles', () => {
    expect(fmtBytes(null)).toBe('indisponible');
    expect(fmtBytes(512)).toBe('512 o');
    expect(fmtBytes(2048)).toBe('2,0 Ko');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5,0 Mo');
  });

  it('chargement du stockage en cours : pas d’erreur', () => {
    expect(pageLoading()).toContain('Chargement…');
  });
});

describe('tâches planifiées', () => {
  it('progression : pourcentage si connu (0 à 1), indéterminée si null, terminée à 100 %', () => {
    expect(jobView({ status: 'running', progress: 0.5 } as never)).toMatchObject({ pct: 50, label: 'En cours · 50 %' });
    expect(jobView({ status: 'running', progress: null } as never)).toMatchObject({ pct: null, label: 'En cours…' });
    expect(jobView({ status: 'done', progress: 1 } as never)).toMatchObject({ pct: 100, kind: 'ok' });
    expect(jobView({ status: 'failed', progress: null, error: 'boom' } as never).label).toBe('Échec : boom');
  });

  it('barre : valeur connue en aria-valuenow, indéterminée sinon', () => {
    const tasks = ready({
      tv: { lastCron: null, nextRunAt: '2026-10-20T06:00:00.000Z', overdue: true },
      purges: [
        { id: 'p1', prefix: 'meta:', status: 'running', deleted: 10, progress: 0.5 },
        { id: 'p2', prefix: 'streams:', status: 'running', deleted: 3, progress: null },
      ],
    });
    const html = tasksHTML({ tv: ready({ lastCron: { startedAt: '2026-10-19T06:00:00.000Z', ok: true, channels: 708 } }), tasks } as any);
    expect(html).toContain('En retard');
    expect(html).toContain('Prochain passage');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('class="is-indet"');
    expect(html.match(/aria-valuenow/g)).toHaveLength(1);
    expect(html).toContain('data-adm-tvrerun');
  });

  it('sans passage TV ni purge : messages neutres', () => {
    const html = tasksHTML({ tv: ready({ lastCron: null }), tasks: ready({ tv: { lastCron: null, nextRunAt: null, overdue: false }, purges: [] }) } as any);
    expect(html).toContain('Aucun passage enregistré.');
    expect(html).toContain('Aucune purge récente.');
    expect(html).not.toContain('En retard');
  });

  it('une purge en cours relance la lecture toutes les 5 s, puis s’arrête à la fin', async () => {
    vi.useFakeTimers();
    try {
      const running = ready({ tv: { lastCron: null, nextRunAt: null, overdue: false }, purges: [{ id: 'p1', prefix: 'meta:', status: 'running', deleted: 1, progress: null }] });
      const S: any = { tasks: running };
      const ctx = ctxOf(S);
      syncTasksPoll(ctx);
      expect(api.getTasks).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.getTasks).toHaveBeenCalledTimes(1);
      // La lecture suivante renvoie la purge terminée : plus de rafraîchissement.
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.getTasks).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('section quittée : pas de lecture programmée', () => {
    vi.useFakeTimers();
    try {
      const S: any = { tasks: ready({ tv: { lastCron: null, nextRunAt: null, overdue: false }, purges: [{ id: 'p1', prefix: 'meta:', status: 'running', deleted: 1, progress: null }] }) };
      syncTasksPoll({ S, isCurrent: () => false, paint: vi.fn() } as never);
      vi.advanceTimersByTime(5000);
      expect(api.getTasks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
