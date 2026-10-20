import { FLUSH_INTERVAL_MS, MemoryMetricsStore, MetricsAccumulator, type MetricsService } from './core.js';

/** Métriques en mémoire du processus (mode Node, tests) : l'accumulateur est versé au stockage à chaque lecture. */
export function createMemoryMetrics(now: () => number = Date.now): MetricsService {
  const sink = new MetricsAccumulator(now);
  const store = new MemoryMetricsStore(now);
  let lastFlush = now();
  return {
    sink,
    report: (range, endAt) => {
      store.ingest(sink.take());
      return Promise.resolve(store.report(range, endAt));
    },
    providerHours: () => {
      store.ingest(sink.take());
      return Promise.resolve(store.providerHours());
    },
    // Compactage périodique : l'accumulateur ne grossit pas si personne ne lit le rapport (rétention appliquée au passage).
    flushIfDue: () => {
      if (now() - lastFlush < FLUSH_INTERVAL_MS) return;
      lastFlush = now();
      store.ingest(sink.take());
    },
    flush: () => {
      store.ingest(sink.take());
      return Promise.resolve();
    },
  };
}
