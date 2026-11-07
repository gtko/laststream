import type { RangeReader } from '../../relay/player/types';

/* Lecteur de plages avec préchargement borné : le moteur audio de repli lit la piste son d'un fichier entrelacé avec la vidéo
 * (mediabunny demande de petites plages éparses). Les octets sont rangés par blocs alignés dans un cache à mémoire bornée, et
 * les blocs qui suivent la position de lecture sont chargés d'avance (en tâche de fond, 2 requêtes au plus) jusqu'à `aheadBytes`.
 * Aucune URL ici : le lecteur interne la porte. */

export interface PrefetchOptions {
  blockSize?: number;
  /** Mémoire maximale du cache (octets). */
  maxBytes?: number;
  /** Octets à tenir prêts en avant de la dernière lecture. */
  aheadBytes?: number;
  concurrency?: number;
}

export interface PrefetchStats {
  cachedBytes: number;
  /** Octets contigus déjà en cache juste après la dernière lecture. */
  aheadBytes: number;
  inflight: number;
  requests: number;
}

const MIB = 1024 * 1024;

export class PrefetchReader implements RangeReader {
  private readonly block: number;
  private readonly maxBytes: number;
  private ahead: number;
  private readonly concurrency: number;
  private readonly blocks = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private sizeP: Promise<number> | null = null;
  private total = -1;
  private pos = 0;
  private cached = 0;
  private requests = 0;
  private closed = false;
  private pumping = false;

  constructor(private readonly inner: RangeReader, opts: PrefetchOptions = {}) {
    this.block = opts.blockSize ?? MIB;
    this.maxBytes = opts.maxBytes ?? 48 * MIB;
    this.ahead = Math.min(opts.aheadBytes ?? 24 * MIB, Math.max(0, this.maxBytes - 8 * MIB));
    this.concurrency = opts.concurrency ?? 2;
  }

  /** Règle l'avance à précharger (ex. 30 s de fichier d'après son débit moyen), bornée par la mémoire. */
  setAheadBytes(bytes: number): void {
    this.ahead = Math.max(0, Math.min(bytes, this.maxBytes - 8 * MIB));
  }

  size(): Promise<number> {
    if (!this.sizeP) {
      this.sizeP = this.inner.size().then((n) => { this.total = n; return n; }, (e: unknown) => { this.sizeP = null; throw e; });
    }
    return this.sizeP;
  }

  stats(): PrefetchStats {
    let run = 0;
    if (this.total >= 0) {
      for (let b = Math.floor(this.pos / this.block); b * this.block < this.total && this.blocks.has(b); b++) {
        run += Math.min(this.block, this.total - b * this.block) - (b === Math.floor(this.pos / this.block) ? this.pos - b * this.block : 0);
      }
    }
    return { cachedBytes: this.cached, aheadBytes: run, inflight: this.inflight.size, requests: this.requests };
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (this.closed) throw new Error('lecteur fermé');
    const total = await this.size();
    const to = Math.min(end, total);
    if (start >= to) return new Uint8Array(0);
    const first = Math.floor(start / this.block);
    const last = Math.floor((to - 1) / this.block);
    this.pos = to;
    const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.getBlock(first + i, total)));
    const out = new Uint8Array(to - start);
    for (let i = 0; i < parts.length; i++) {
      const blockStart = (first + i) * this.block;
      const from = Math.max(start, blockStart);
      const upTo = Math.min(to, blockStart + parts[i].byteLength);
      out.set(parts[i].subarray(from - blockStart, upTo - blockStart), from - start);
    }
    this.pump(total);
    return out;
  }

  close(): void {
    this.closed = true;
    this.blocks.clear();
    this.inflight.clear();
    this.cached = 0;
  }

  private getBlock(index: number, total: number): Promise<Uint8Array> {
    const hit = this.blocks.get(index);
    if (hit) {
      // Récemment utilisé : réinséré en fin de Map.
      this.blocks.delete(index);
      this.blocks.set(index, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(index);
    if (pending) return pending;
    const from = index * this.block;
    const to = Math.min(from + this.block, total);
    this.requests++;
    const p = this.inner.read(from, to).then(
      (data) => {
        this.inflight.delete(index);
        if (!this.closed) this.store(index, data);
        return data;
      },
      (e: unknown) => {
        this.inflight.delete(index);
        throw e;
      },
    );
    this.inflight.set(index, p);
    return p;
  }

  private store(index: number, data: Uint8Array): void {
    const prev = this.blocks.get(index);
    if (prev) this.cached -= prev.byteLength;
    this.blocks.set(index, data);
    this.cached += data.byteLength;
    // Mémoire bornée : d'abord les blocs derrière la position de lecture (les plus anciens), puis les plus éloignés devant.
    const cur = Math.floor(this.pos / this.block);
    while (this.cached > this.maxBytes) {
      let victim = -1;
      for (const k of this.blocks.keys()) {
        if (k === index) continue;
        if (k < cur) { victim = k; break; }
        if (victim < 0 || k > victim) victim = k;
      }
      if (victim < 0) break;
      this.cached -= this.blocks.get(victim)?.byteLength ?? 0;
      this.blocks.delete(victim);
    }
  }

  /** Charge d'avance les blocs qui suivent la dernière lecture (tâche de fond, erreurs ignorées : la vraie lecture réessaiera). */
  private pump(total: number): void {
    if (this.pumping || this.closed || this.ahead <= 0) return;
    this.pumping = true;
    const run = async (): Promise<void> => {
      try {
        for (;;) {
          if (this.closed) return;
          const cur = Math.floor(this.pos / this.block);
          const lastWanted = Math.min(Math.floor((total - 1) / this.block), Math.floor((this.pos + this.ahead) / this.block));
          const todo: number[] = [];
          for (let b = cur + 1; b <= lastWanted && todo.length < this.concurrency; b++) {
            if (!this.blocks.has(b) && !this.inflight.has(b)) todo.push(b);
          }
          if (!todo.length) return;
          await Promise.all(todo.map((b) => this.getBlock(b, total).catch(() => undefined)));
          if (todo.every((b) => !this.blocks.has(b))) return; // échec réseau : on s'arrête, la lecture suivante relancera
        }
      } finally {
        this.pumping = false;
      }
    };
    void run();
  }
}
