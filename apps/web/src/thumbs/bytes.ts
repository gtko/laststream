/* Lecture d'un fichier distant par plages d'octets. Une plage = une requête ; aucune ne dépasse MAX_CHUNK.
 * Le début du fichier est lu une fois (HEAD_BYTES) et gardé : il suffit à la plupart des en-têtes MKV et à tous les « ftyp ». */

export const MAX_CHUNK = 4 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

export interface RangeResponse {
  data: Uint8Array;
  /** Taille totale du fichier (Content-Range), null si inconnue. */
  total: number | null;
}

/** Lit les octets [start, endInclusive]. Renvoie `data` vide (et `total`) quand `start` dépasse la fin du fichier. */
export type FetchRange = (start: number, endInclusive: number, signal?: AbortSignal) => Promise<RangeResponse>;

export interface ByteSourceOptions {
  maxChunk?: number;
  headBytes?: number;
}

export class ByteSource {
  size: number | null = null;
  requests = 0;
  bytes = 0;
  private head: Uint8Array | null = null;
  private readonly maxChunk: number;
  private readonly headBytes: number;

  constructor(private readonly fetchRange: FetchRange, options: ByteSourceOptions = {}) {
    this.maxChunk = Math.min(options.maxChunk ?? MAX_CHUNK, MAX_CHUNK);
    this.headBytes = options.headBytes ?? HEAD_BYTES;
  }

  private async raw(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const r = await this.fetchRange(start, end, signal);
    this.requests += 1;
    this.bytes += r.data.length;
    if (r.total !== null) this.size = r.total;
    return r.data;
  }

  /** Premier appel : lit le début du fichier et apprend sa taille. */
  async open(signal?: AbortSignal): Promise<number | null> {
    this.head = await this.raw(0, this.headBytes - 1, signal);
    if (this.size === null && this.head.length < this.headBytes) this.size = this.head.length;
    return this.size;
  }

  /** Lit `length` octets depuis `start` (moins en fin de fichier). Découpe en plages de MAX_CHUNK au plus. */
  async read(start: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.size !== null) length = Math.min(length, this.size - start);
    if (length <= 0 || start < 0) return new Uint8Array(0);
    if (this.head !== null && start + length <= this.head.length) return this.head.subarray(start, start + length);
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < length) {
      const n = Math.min(this.maxChunk, length - got);
      const data = await this.raw(start + got, start + got + n - 1, signal);
      if (data.length === 0) break;
      parts.push(data);
      got += data.length;
      if (data.length < n) break;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Fenêtre glissante sur une ByteSource : les lectures voisines (en-têtes d'éléments) ne coûtent qu'une requête. */
export class Cursor {
  private base = 0;
  private buf: Uint8Array = new Uint8Array(0);

  constructor(private readonly src: ByteSource, private readonly minFetch = 128 * 1024) {}

  /** `len` octets depuis `off` (moins en fin de fichier). Prolonge la fenêtre plutôt que de relire ce qu'elle contient. */
  async bytes(off: number, len: number, signal?: AbortSignal): Promise<Uint8Array> {
    const end = off + len;
    const have = this.base + this.buf.length;
    if (off >= this.base && end <= have) return this.buf.subarray(off - this.base, end - this.base);
    if (off >= this.base && off <= have && this.buf.length > 0) {
      const extra = await this.src.read(have, Math.max(end - have, this.minFetch), signal);
      const merged = new Uint8Array(this.buf.length + extra.length);
      merged.set(this.buf, 0);
      merged.set(extra, this.buf.length);
      this.buf = merged;
    } else {
      this.buf = await this.src.read(off, Math.max(len, this.minFetch), signal);
      this.base = off;
    }
    return this.buf.subarray(off - this.base, Math.min(end, this.base + this.buf.length) - this.base);
  }
}
