/**
 * Cache en mémoire des résultats de sonde média : TTL de 30 jours, borne de 5000 entrées avec éviction LRU,
 * et partage des appels concurrents pour une même clé. Le temps est injectable (tests).
 *
 * Les valeurs null/undefined ne sont jamais mises en cache : un échec transitoire est retenté au prochain appel.
 * Pas de persistance pour l'instant ; l'interface get/set/size reste celle d'un futur stockage.
 */

import type { MediaProbe } from './probe.js';

/** Durée de vie d'une entrée : 30 jours. */
export const PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Nombre maximal d'entrées conservées ; au-delà, la moins récemment utilisée est évincée. */
export const PROBE_CACHE_MAX_ENTRIES = 5000;

/** Options du cache. */
export interface ProbeCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Horloge en millisecondes (défaut : Date.now). */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Clé de cache d'une sonde : `${infoHash}:${fileIdx ?? 'x'}`. L'infoHash est normalisé en minuscules. */
export function probeCacheKey(infoHash: string, fileIdx?: number): string {
  return `${infoHash.toLowerCase()}:${fileIdx ?? 'x'}`;
}

/** Cache générique à TTL, borné en taille (LRU), avec partage des appels concurrents. */
export class ProbeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T | null>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ProbeCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? PROBE_TTL_MS;
    this.maxEntries = options.maxEntries ?? PROBE_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Valeur mise en cache, ou undefined si absente ou expirée. Un accès réussi la marque comme récente. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Enregistre une valeur (renouvelle le TTL) et évince les entrées les moins récentes au-delà de la borne. */
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Nombre d'entrées vivantes. Les entrées expirées sont retirées au passage. */
  size(): number {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    return this.entries.size;
  }

  /** Vide le cache (les appels en cours ne sont pas annulés). */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Renvoie la valeur en cache si elle existe, sinon exécute `fn`. Un appel concurrent pour la même clé attend le
   * résultat de l'appel en cours au lieu d'en lancer un second. Un résultat null n'est pas mis en cache.
   */
  async probe(key: string, fn: () => Promise<T | null>): Promise<T | null> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<T | null> => {
      try {
        const value = await fn();
        if (value !== null && value !== undefined) this.set(key, value);
        return value ?? null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, run);
    return run;
  }
}

/** Cache partagé par défaut pour les sondes média. */
export const probeCache = new ProbeCache<MediaProbe>();

/** Renvoie la sonde en cache pour `key`, ou exécute `fn` (appels concurrents partagés) et met le résultat en cache. */
export function probeWithCache(
  key: string,
  fn: () => Promise<MediaProbe | null>,
  cache: ProbeCache<MediaProbe> = probeCache,
): Promise<MediaProbe | null> {
  return cache.probe(key, fn);
}
