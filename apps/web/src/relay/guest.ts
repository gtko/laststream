/* Côté invité : lit des plages du fichier de l'hôte par un DataChannel. Chaque plage est demandée par morceaux de requête
 * (4 Mo par défaut), avec délai d'inactivité, reprise sur erreur (hôte occupé, source momentanée, délai) qui repart de
 * l'octet reçu, annulation côté hôte, cache LRU de plages et statistiques de réception.
 * Les erreurs sont des `RelayError` au message fixe : aucune URL n'y figure. */

import {
  MAX_RANGE_BYTES, RelayError, decodeFrame, encodeCancel, encodeInfoReq, encodeReq, isValidRange, toBytes,
  type ChannelLike, type RelayFrame,
} from './protocol';
import { RateMeter, STATS_EVERY_MS } from './stats';

export interface RangeInfo {
  size: number;
  mime?: string;
}

export interface DownloadStats {
  bytesReceived: number;
  /** Débit descendant moyen (octets/s) sur quelques secondes. */
  rateBps: number;
}

export interface RangeClientOptions {
  /** Délai sans trame de l'hôte avant abandon de la requête (ms). */
  timeoutMs?: number;
  /** Reprises par requête après busy, source ou délai. */
  retries?: number;
  /** Attente avant la n-ième reprise : n × retryDelayMs. */
  retryDelayMs?: number;
  /** Taille d'une requête REQ (≤ 8 Mo). */
  requestBytes?: number;
  /** Taille du cache de plages (octets). */
  cacheBytes?: number;
  onStats?: (stats: DownloadStats) => void;
  now?: () => number;
}

interface Waiter {
  onFrame(frame: RelayFrame): void;
  abort(err: RelayError): void;
}

/** Cache LRU de plages : une plage couverte par une entrée est servie depuis elle. */
class RangeCache {
  private readonly items = new Map<number, { start: number; end: number; bytes: Uint8Array }>();
  private seq = 0;
  private total = 0;

  constructor(private readonly limit: number) {}

  get(start: number, end: number): Uint8Array | null {
    for (const [key, item] of this.items) {
      if (item.start <= start && end <= item.end) {
        this.items.delete(key);
        this.items.set(key, item);
        return item.bytes.subarray(start - item.start, end - item.start).slice();
      }
    }
    return null;
  }

  put(start: number, end: number, bytes: Uint8Array): void {
    if (bytes.byteLength === 0 || bytes.byteLength > this.limit) return;
    this.seq += 1;
    this.items.set(this.seq, { start, end, bytes });
    this.total += bytes.byteLength;
    while (this.total > this.limit) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.total -= this.items.get(oldest)?.bytes.byteLength ?? 0;
      this.items.delete(oldest);
    }
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RelayError('cancelled'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RelayError('cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RangeClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly requestBytes: number;
  private readonly cache: RangeCache;
  private readonly onStats: ((stats: DownloadStats) => void) | undefined;
  private readonly now: () => number;
  private readonly meter: RateMeter;
  private readonly waiters = new Map<number, Waiter>();
  private readonly onMessage = (ev: { data?: unknown }): void => {
    const bytes = toBytes(ev.data);
    const frame = bytes ? decodeFrame(bytes) : null;
    if (frame && (frame.t === 'data' || frame.t === 'info' || frame.t === 'err')) this.waiters.get(frame.reqId)?.onFrame(frame);
  };
  private readonly onClose = (): void => this.close();
  private infoP: Promise<RangeInfo> | null = null;
  private nextId = 1;
  private bytesReceived = 0;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(private readonly channel: ChannelLike, options: RangeClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.requestBytes = Math.min(options.requestBytes ?? 4 * 1024 * 1024, MAX_RANGE_BYTES);
    this.cache = new RangeCache(options.cacheBytes ?? 16 * 1024 * 1024);
    this.onStats = options.onStats;
    this.now = options.now ?? (() => Date.now());
    this.meter = new RateMeter(this.now);
    channel.addEventListener('message', this.onMessage);
    channel.addEventListener('close', this.onClose);
  }

  /** Taille et type du fichier (une seule requête INFO, mise en cache). */
  info(): Promise<RangeInfo> {
    if (!this.infoP) {
      this.infoP = this.retry(() => this.askInfo()).catch((err: unknown) => {
        this.infoP = null;
        throw err;
      });
    }
    return this.infoP;
  }

  size(): Promise<number> {
    return this.info().then((i) => i.size);
  }

  /** Octets [start, end) du fichier (end exclu). Annulable par `signal`. */
  async read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!isValidRange(start, end)) throw new RelayError('bad_request');
    if (this.closed) throw new RelayError('closed');
    const hit = this.cache.get(start, end);
    if (hit) return hit;
    const out = new Uint8Array(end - start);
    for (let p = start; p < end; p += this.requestBytes) {
      const pe = Math.min(end, p + this.requestBytes);
      const part = await this.fetchPiece(p, pe, signal);
      out.set(part, p - start);
      this.cache.put(p, pe, part);
    }
    return out;
  }

  stats(): DownloadStats {
    return { bytesReceived: this.bytesReceived, rateBps: this.meter.rate() };
  }

  /** Arrête le client : les requêtes en cours échouent avec `closed`. Le canal reste à la charge de l'appelant. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('close', this.onClose);
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of waiters) w.abort(new RelayError('closed'));
  }

  private askInfo(): Promise<RangeInfo> {
    return this.call<RangeInfo>(encodeInfoReq, (f, done, fail) => {
      if (f.t === 'info') done(f.mime === undefined ? { size: f.size } : { size: f.size, mime: f.mime });
      else if (f.t === 'err') fail(new RelayError(f.code));
      else fail(new RelayError('protocol'), true);
    });
  }

  private async fetchPiece(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    const buf = new Uint8Array(end - start);
    const progress = { next: start };
    await this.retry(() => (progress.next < end ? this.pull(progress, end, buf, start, signal) : Promise.resolve()), signal);
    return buf;
  }

  /** Une tentative : demande [p.next, end) et recopie les morceaux reçus à la suite. */
  private pull(progress: { next: number }, end: number, buf: Uint8Array, base: number, signal?: AbortSignal): Promise<void> {
    return this.call<void>((id) => encodeReq(id, progress.next, end), (f, done, fail) => {
      if (f.t === 'err') return fail(new RelayError(f.code));
      const last = progress.next + (f.t === 'data' ? f.payload.byteLength : 0) === end;
      if (f.t !== 'data' || f.offset !== progress.next || progress.next + f.payload.byteLength > end || f.fin !== last) {
        return fail(new RelayError('protocol'), true);
      }
      buf.set(f.payload, progress.next - base);
      progress.next += f.payload.byteLength;
      this.account(f.payload.byteLength);
      if (f.fin) done();
      return undefined;
    }, signal);
  }

  /** Reprises : seules les erreurs réessayables (busy, source, timeout) sont rejouées, avec attente croissante. */
  private async retry<T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let n = 0; ; n += 1) {
      try {
        return await attempt();
      } catch (err) {
        if (!(err instanceof RelayError) || !err.retryable || n >= this.retries || this.closed || signal?.aborted) throw err;
        await pause(this.retryDelayMs * (n + 1), signal);
      }
    }
  }

  /**
   * Envoie une requête et traite les trames de même reqId jusqu'à `done` ou `fail`. Délai d'inactivité, annulation par
   * `signal` ; `notify` envoie CANCEL à l'hôte pour qu'il arrête d'envoyer.
   */
  private call<T>(
    request: (reqId: number) => Uint8Array,
    onFrame: (f: RelayFrame, done: (v: T) => void, fail: (e: RelayError, notify?: boolean) => void) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new RelayError('closed'));
        return;
      }
      if (signal?.aborted) {
        reject(new RelayError('cancelled'));
        return;
      }
      const reqId = this.nextReqId();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => finish(new RelayError('cancelled'), undefined, true);
      const finish = (err: RelayError | null, value?: T, notify = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(reqId);
        signal?.removeEventListener('abort', onAbort);
        if (notify && !this.closed) this.sendQuiet(encodeCancel(reqId));
        if (err) reject(err);
        else resolve(value as T);
      };
      const arm = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new RelayError('timeout'), undefined, true), this.timeoutMs);
      };
      this.waiters.set(reqId, {
        onFrame: (f) => {
          if (settled) return;
          arm();
          onFrame(f, (v) => finish(null, v), (e, notify) => finish(e, undefined, notify === true));
        },
        abort: (e) => finish(e),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
      try {
        this.channel.send(request(reqId));
      } catch {
        finish(new RelayError('closed'));
      }
    });
  }

  private sendQuiet(frame: Uint8Array): void {
    try {
      this.channel.send(frame);
    } catch {
      /* canal déjà fermé : rien à annuler */
    }
  }

  private nextReqId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return id;
  }

  private account(bytes: number): void {
    this.bytesReceived += bytes;
    this.meter.add(bytes);
    const cb = this.onStats;
    if (!cb) return;
    const t = this.now();
    if (t - this.lastEmit < STATS_EVERY_MS) return;
    this.lastEmit = t;
    cb(this.stats());
  }
}
