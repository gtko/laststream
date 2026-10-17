import { createHash } from 'node:crypto';

/** Options d'un cache LRU : nombre maximal d'entrées, durée de vie par défaut, horloge injectable. */
export interface LruOptions {
  max: number;
  ttlMs: number;
  now?: () => number;
}

/** Entrée dump : clé, valeur et durée de vie restante en millisecondes (> 0). */
export interface LruDumpEntry<V> {
  key: string;
  value: V;
  remainingMs: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Cache en mémoire à éviction LRU (la moins récemment consultée part en premier) et à expiration (TTL).
 * Une entrée expirée n'est jamais renvoyée. `get` renouvelle la récence ; `set` évince au-delà de `max`.
 * Les valeurs ne doivent pas être `undefined` (get renvoie undefined pour une clé absente ou expirée).
 */
export class LruCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry<V>>();

  constructor(opts: LruOptions) {
    if (!Number.isInteger(opts.max) || opts.max < 1) throw new RangeError('max doit être un entier >= 1');
    if (!(opts.ttlMs > 0)) throw new RangeError('ttlMs doit être > 0');
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** Valeur de la clé si présente et non expirée ; renouvelle sa récence. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Stocke une valeur (la plus récente). `ttlMs` remplace la durée par défaut pour cette entrée.
   * Au-delà de `max`, les entrées expirées partent d'abord, puis la moins récemment consultée.
   */
  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    if (!(ttlMs > 0)) throw new RangeError('ttlMs doit être > 0');
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.map.size <= this.max) return;
    this.prune();
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
  }

  /** Supprime une clé. Renvoie vrai si elle était présente. */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /** Vide le cache. */
  clear(): void {
    this.map.clear();
  }

  /** Nombre d'entrées vivantes (les entrées expirées sont retirées au passage). */
  get size(): number {
    this.prune();
    return this.map.size;
  }

  /** Retire les entrées expirées. Renvoie leur nombre. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Entrées vivantes, de la moins récente à la plus récente, avec leur durée de vie restante. */
  dump(): LruDumpEntry<V>[] {
    const now = this.now();
    const out: LruDumpEntry<V>[] = [];
    for (const [key, entry] of this.map) {
      const remainingMs = entry.expiresAt - now;
      if (remainingMs > 0) out.push({ key, value: entry.value, remainingMs });
    }
    return out;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Forme canonique d'une valeur JSON : clés d'objet triées, valeurs non JSON retirées (comme JSON.stringify). */
function canonical(value: unknown, stack: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') throw new TypeError('valeur BigInt non sérialisable');
  if (typeof value !== 'object') return undefined;
  if (stack.has(value)) throw new TypeError('référence circulaire non sérialisable');
  stack.add(value);
  try {
    const withToJson = value as { toJSON?: unknown };
    if (typeof withToJson.toJSON === 'function') {
      return canonical((withToJson.toJSON as () => unknown).call(value), stack);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => {
        const normalized = canonical(item, stack);
        return normalized === undefined ? null : normalized;
      });
    }
    if (!isPlainObject(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = canonical(value[key], stack);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/**
 * JSON déterministe : clés d'objet triées récursivement, mêmes règles que JSON.stringify
 * (undefined, fonctions et symboles omis ; NaN et infinis en null). Lève TypeError sur BigInt ou cycle.
 */
export function stableStringify(value: unknown): string {
  const normalized = canonical(value, new Set());
  return JSON.stringify(normalized === undefined ? null : normalized);
}

/**
 * Clé de cache haschée (sha256 hexadécimal) pour une configuration et un identifiant.
 * La configuration (et donc toute clé API qu'elle contient) n'apparaît jamais en clair dans le résultat :
 * l'ordre des clés n'influe pas sur le hash.
 */
export function hashConfigKey(config: unknown, id: string): string {
  return createHash('sha256').update(stableStringify({ id, config }), 'utf8').digest('hex');
}
