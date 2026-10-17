import { describe, expect, it } from 'vitest';
import {
  IndexerHealth,
  LATENCY_WINDOW,
  MAX_TRACKED_INDEXERS,
  SLOW_THRESHOLD_MS,
  getHealth,
  defaultIndexerHealth,
} from '../src/sources/indexer-health.js';

/** Horloge contrôlable : chaque lecture renvoie la valeur courante. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, set: (value: number) => (now = value) };
}

describe('IndexerHealth : états', () => {
  it('un indexeur jamais interrogé est absent', () => {
    const health = new IndexerHealth();
    expect(health.get('Prowlarr', 3)).toBeUndefined();
    expect(health.getHealth()).toEqual([]);
  });

  it('une requête réussie rapide donne ok, avec la latence moyenne arrondie', () => {
    const health = new IndexerHealth(clock().now);
    health.record('Prowlarr', 3, { ok: true, latencyMs: 200 });
    health.record('Prowlarr', 3, { ok: true, latencyMs: 301 });

    expect(health.get('Prowlarr', 3)).toMatchObject({
      source: 'Prowlarr',
      indexerId: '3',
      status: 'ok',
      count: 2,
      errorCount: 0,
      avgLatencyMs: 251,
    });
  });

  it('une moyenne au-delà de 5 s donne slow (et pas error)', () => {
    const health = new IndexerHealth(clock().now);
    health.record('P', 1, { ok: true, latencyMs: SLOW_THRESHOLD_MS + 1000 });
    expect(health.get('P', 1)?.status).toBe('slow');
    expect(SLOW_THRESHOLD_MS).toBe(5000);
  });

  it('une requête en échec donne error, avec le dernier code d’erreur et le compteur d’erreurs', () => {
    const health = new IndexerHealth(clock().now);
    health.record('P', 1, { ok: true, latencyMs: 100 });
    health.record('P', 1, { ok: false, latencyMs: 50, error: 'HTTP 503' });

    expect(health.get('P', 1)).toMatchObject({ status: 'error', errorCount: 1, count: 2, lastErrorCode: 'HTTP 503' });
  });

  it('un succès après un échec repasse en ok, le dernier code d’erreur reste visible', () => {
    const health = new IndexerHealth(clock().now);
    health.record('P', 1, { ok: false, latencyMs: 10, error: 'délai dépassé (10000 ms)' });
    health.record('P', 1, { ok: true, latencyMs: 120 });

    expect(health.get('P', 1)).toMatchObject({ status: 'ok', lastErrorCode: 'délai dépassé (10000 ms)' });
  });

  it('les échecs n’entrent pas dans la moyenne glissante', () => {
    const health = new IndexerHealth(clock().now);
    health.record('P', 1, { ok: true, latencyMs: 100 });
    health.record('P', 1, { ok: false, latencyMs: 9000, error: 'HTTP 500' });

    expect(health.get('P', 1)?.avgLatencyMs).toBe(100);
  });

  it('le code d’erreur est tronqué à 120 caractères', () => {
    const health = new IndexerHealth(clock().now);
    health.record('P', 1, { ok: false, latencyMs: 1, error: 'x'.repeat(500) });
    expect(health.get('P', 1)?.lastErrorCode).toHaveLength(120);
  });
});

describe('IndexerHealth : moyenne glissante', () => {
  it(`ne garde que les ${LATENCY_WINDOW} dernières latences réussies`, () => {
    const health = new IndexerHealth(clock().now);
    // Dix latences de 10 000 ms, puis dix de 100 ms : seule la fenêtre récente compte.
    for (let i = 0; i < LATENCY_WINDOW; i++) health.record('P', 1, { ok: true, latencyMs: 10_000 });
    for (let i = 0; i < LATENCY_WINDOW; i++) health.record('P', 1, { ok: true, latencyMs: 100 });

    expect(health.get('P', 1)).toMatchObject({ avgLatencyMs: 100, status: 'ok', count: 2 * LATENCY_WINDOW });
  });
});

describe('IndexerHealth : clés et filtres', () => {
  it('la clé est le couple (source, identifiant) : deux sources distinctes ne se mélangent pas', () => {
    const health = new IndexerHealth(clock().now);
    health.record('Alpha', 7, { ok: true, latencyMs: 10 });
    health.record('Beta', 7, { ok: false, latencyMs: 10, error: 'HTTP 401' });

    expect(health.get('Alpha', 7)?.status).toBe('ok');
    expect(health.get('Beta', 7)?.status).toBe('error');
  });

  it('l’identifiant numérique et textuel désignent le même indexeur', () => {
    const health = new IndexerHealth(clock().now);
    health.record('Jackett', '1337x', { ok: true, latencyMs: 10 });
    expect(health.get('Jackett', '1337x')?.count).toBe(1);
  });

  it('getHealth() renvoie tous les indexeurs, getHealth(source) seulement ceux de la source', () => {
    const health = new IndexerHealth(clock().now);
    health.record('Alpha', 1, { ok: true, latencyMs: 10 });
    health.record('Alpha', 2, { ok: true, latencyMs: 10 });
    health.record('Beta', 1, { ok: true, latencyMs: 10 });

    expect(health.getHealth()).toHaveLength(3);
    expect(health.getHealth('Alpha').map((s) => s.indexerId)).toEqual(['1', '2']);
  });

  it('plafonne le nombre d’indexeurs suivis en oubliant le plus anciennement créé', () => {
    const health = new IndexerHealth(clock().now);
    for (let i = 0; i <= MAX_TRACKED_INDEXERS; i++) health.record('P', i, { ok: true, latencyMs: 1 });

    expect(health.getHealth()).toHaveLength(MAX_TRACKED_INDEXERS);
    expect(health.get('P', 0)).toBeUndefined();
    expect(health.get('P', MAX_TRACKED_INDEXERS)).toBeDefined();
  });

  it('clear() vide la table ; getHealth() exporté lit la table par défaut', () => {
    defaultIndexerHealth.clear();
    defaultIndexerHealth.record('Defaut', 9, { ok: true, latencyMs: 5 });
    expect(getHealth('Defaut')).toMatchObject([{ source: 'Defaut', indexerId: '9', status: 'ok' }]);
    defaultIndexerHealth.clear();
    expect(getHealth()).toEqual([]);
  });

  it('lastCheckedAt suit l’horloge injectée', () => {
    const time = clock(1_000);
    const health = new IndexerHealth(time.now);
    time.set(4_242);
    health.record('P', 1, { ok: true, latencyMs: 1 });
    expect(health.get('P', 1)?.lastCheckedAt).toBe(4_242);
  });
});
