// Console d'administration, page Performance : tableau « Appels par fournisseur » (totaux 30 j), absent sans `providers`, valeurs échappées.
import { describe, expect, it } from 'vitest';
import { performanceHTML } from '../src/ui/admin-views.js';

const stats = { requests: 10, status: { '2xx': 10, '3xx': 0, '4xx': 0, '5xx': 0 }, p50: 40, p95: 90, avgMs: 45 };
const metrics = {
  range: '24h', from: '2026-10-18T10:00:00.000Z', to: '2026-10-19T10:00:00.000Z', stepSec: 3600,
  totals: stats, groups: { ui: stats },
  series: [{ t: '2026-10-18T10:00:00.000Z', requests: 4, errors5xx: 0, p95: 80 }, { t: '2026-10-18T11:00:00.000Z', requests: 6, errors5xx: 0, p95: 90 }],
  upstreams: [], alldebrid: {}, caches: [], errors: [],
};
const entry = (provider: string, over: Record<string, number | null>) => ({
  provider, calls: 0, l1Hits: 0, l2Hits: 0, stale: 0, coalesced: 0, r2Hits: 0, r2Misses: 0, notModified: 0, hitRate: null, r2HitRate: null, ...over,
});
const providers = (totals: unknown[]) => ({ windowDays: 30, from: '2026-09-20', to: '2026-10-19', byDay: [], totals });
const render = (m: object) => performanceHTML({ range: '24h', updatedAt: 0, perf: { status: 'ready', value: m, error: '' } });

describe('page Performance : appels par fournisseur', () => {
  it('sans `providers` : pas de tableau, le reste de la page s’affiche', () => {
    const html = render(metrics);
    expect(html).not.toContain('Appels par fournisseur');
    expect(html).toContain('Groupes de routes');
    expect(html).toContain('Détail par groupe de routes');
  });

  it('avec `providers` : totaux 30 j par fournisseur et taux de hit', () => {
    const html = render({
      ...metrics,
      providers: providers([
        entry('tmdb', { calls: 20, l1Hits: 50, l2Hits: 10, stale: 2, coalesced: 3, r2Hits: 4, notModified: 6, hitRate: 0.8 }),
        entry('fanart', { hitRate: null }),
      ]),
    });
    expect(html).toContain('Appels par fournisseur');
    expect(html).toContain('30 derniers jours (UTC)');
    expect(html).toContain('>TMDB<');
    expect(html).toContain('<td data-label="Appels" class="is-num">20</td>');
    expect(html).toContain('<td data-label="Taux de hit" class="is-num">80,0 %</td>');
    expect(html).toContain('>Fanart.tv<');
    expect(html).toContain('<td data-label="Taux de hit" class="is-num">—</td>');
  });

  it('valeurs de fournisseur échappées (pas de balise injectée)', () => {
    const html = render({ ...metrics, providers: providers([entry('<img src=x onerror=alert(1)>', { calls: 1 })]) });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('`providers` sans fournisseur : message vide, la carte reste visible', () => {
    const html = render({ ...metrics, providers: providers([]) });
    expect(html).toContain('Appels par fournisseur');
    expect(html).toContain('Aucun appel fournisseur sur les 30 derniers jours.');
  });
});
