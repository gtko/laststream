/* Morceaux du maillage : le fichier est découpé en morceaux de taille fixe (1 Mio) identifiés par leur index. Outils purs :
 * bornes d'un morceau, hachage SHA-256 (crypto.subtle), intervalles d'index (annonces HAVE) et cache LRU borné en octets. */

import type { PieceInterval } from '../protocol';

export const PIECE_SHIFT = 20;
export const PIECE_BYTES = 1 << PIECE_SHIFT;
/** Cache de morceaux d'un invité (octets). */
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

export function pieceCount(size: number, pieceBytes = PIECE_BYTES): number {
  return Math.ceil(size / pieceBytes);
}

/** Octets [start, end) du morceau `index` (le dernier est plus court), ou null s'il est hors du fichier. */
export function pieceBounds(index: number, size: number, pieceBytes = PIECE_BYTES): { start: number; end: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= pieceCount(size, pieceBytes)) return null;
  return { start: index * pieceBytes, end: Math.min(size, (index + 1) * pieceBytes) };
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const view = bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice();
  return new Uint8Array(await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>));
}

export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Index triés → intervalles contigus. */
export function toIntervals(indexes: Iterable<number>): PieceInterval[] {
  const sorted = [...indexes].sort((a, b) => a - b);
  const out: PieceInterval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i === last.start + last.len) last.len += 1;
    else if (!last || i > last.start + last.len) out.push({ start: i, len: 1 });
  }
  return out;
}

/** Ensemble d'index d'intervalles (plafonné pour qu'une annonce hostile ne coûte pas de mémoire). */
export function fromIntervals(ranges: readonly PieceInterval[], maxIndex: number): Set<number> {
  const out = new Set<number>();
  for (const r of ranges) {
    for (let i = r.start; i < r.start + r.len && i < maxIndex; i += 1) out.add(i);
  }
  return out;
}

/** Cache LRU de morceaux, borné en octets. `onChange` est appelé quand l'ensemble détenu change. */
export class PieceCache {
  private readonly items = new Map<number, Uint8Array>();
  private total = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly onChange?: () => void,
  ) {}

  has(index: number): boolean {
    return this.items.has(index);
  }

  /** Octets du morceau (le plus récemment utilisé passe en tête), ou null. */
  get(index: number): Uint8Array | null {
    const bytes = this.items.get(index);
    if (!bytes) return null;
    this.items.delete(index);
    this.items.set(index, bytes);
    return bytes;
  }

  put(index: number, bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || bytes.byteLength > this.limitBytes) return;
    const old = this.items.get(index);
    if (old) this.total -= old.byteLength;
    this.items.delete(index);
    this.items.set(index, bytes);
    this.total += bytes.byteLength;
    while (this.total > this.limitBytes) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined || oldest === index) break;
      this.total -= this.items.get(oldest)?.byteLength ?? 0;
      this.items.delete(oldest);
    }
    this.onChange?.();
  }

  get bytes(): number {
    return this.total;
  }

  indexes(): number[] {
    return [...this.items.keys()];
  }

  clear(): void {
    this.items.clear();
    this.total = 0;
  }
}
