/* Côté hôte : sert des plages d'une source (le lien débridé, lu sur l'appareil de l'hôte) à un invité, par un DataChannel.
 * Les requêtes sont découpées en morceaux de 64 Ko ; le flux est freiné quand le tampon d'envoi dépasse le seuil haut
 * (reprise à l'événement `bufferedamountlow`). Limites : requêtes concurrentes, taille par requête, annulation par l'invité.
 * Aucune URL, aucun contenu d'erreur n'est envoyé ni journalisé : seulement des codes (RANGE_ERROR_CODES). */

import {
  CHUNK_BYTES, MAX_RANGE_BYTES, RANGE_ERROR_CODES, RelayError, decodeFrame, encodeData, encodeErr, encodeInfo, isValidRange,
  toBytes, type ChannelLike, type RangeErrorCode,
} from './protocol';
import { RateMeter, STATS_EVERY_MS } from './stats';

export interface RangeSource {
  /** Taille du fichier, en octets. */
  size(): Promise<number>;
  /** Octets [start, end) (end exclu) ; doit rendre exactement end - start octets. */
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Type MIME, si connu. */
  mime?: string;
}

export interface UploadStats {
  bytesSent: number;
  /** Débit montant moyen (octets/s) sur quelques secondes. */
  rateBps: number;
  /** Requêtes en cours. */
  active: number;
}

export interface RangeServerOptions {
  /** Requêtes de plage simultanées acceptées ; au-delà, ERR busy. */
  maxConcurrent?: number;
  /** Taille maximale d'une requête REQ, en octets ; au-delà, ERR too_large. */
  maxRangeBytes?: number;
  /** Tampon d'envoi au-delà duquel l'envoi attend. */
  highWaterBytes?: number;
  /** Seuil de reprise (bufferedamountlow). */
  lowWaterBytes?: number;
  /** Lecture de la source par blocs de cette taille (les morceaux de 64 Ko en sont extraits). */
  readBlockBytes?: number;
  onStats?: (stats: UploadStats) => void;
  now?: () => number;
}

const MIB = 1024 * 1024;

/** Sert les requêtes de plage reçues sur `channel`. Un serveur par canal ; `close()` coupe tout sans fermer le canal. */
export class RangeServer {
  private readonly maxConcurrent: number;
  private readonly maxRangeBytes: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly readBlock: number;
  private readonly onStats: ((stats: UploadStats) => void) | undefined;
  private readonly now: () => number;
  private readonly meter: RateMeter;
  private readonly active = new Map<number, AbortController>();
  private readonly onMessage = (ev: { data?: unknown }): void => this.handle(ev.data);
  private readonly onClose = (): void => this.close();
  private sizeP: Promise<number> | null = null;
  private bytesSent = 0;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    private readonly source: RangeSource,
    private readonly channel: ChannelLike,
    options: RangeServerOptions = {},
  ) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxRangeBytes = options.maxRangeBytes ?? MAX_RANGE_BYTES;
    this.highWater = options.highWaterBytes ?? MIB;
    this.lowWater = options.lowWaterBytes ?? 256 * 1024;
    this.readBlock = options.readBlockBytes ?? MIB;
    this.onStats = options.onStats;
    this.now = options.now ?? (() => Date.now());
    this.meter = new RateMeter(this.now);
    channel.bufferedAmountLowThreshold = this.lowWater;
    channel.addEventListener('message', this.onMessage);
    channel.addEventListener('close', this.onClose);
  }

  stats(): UploadStats {
    return { bytesSent: this.bytesSent, rateBps: this.meter.rate(), active: this.active.size };
  }

  /** Arrête le service : annule les requêtes en cours (plus rien n'est envoyé). Le canal reste à la charge de l'appelant. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('close', this.onClose);
    for (const ctl of this.active.values()) ctl.abort();
    this.active.clear();
    this.emit(true);
  }

  private handle(data: unknown): void {
    if (this.closed) return;
    const bytes = toBytes(data);
    const frame = bytes ? decodeFrame(bytes) : null;
    if (!frame) return;
    switch (frame.t) {
      case 'req':
        void this.serve(frame.reqId, frame.start, frame.end);
        break;
      case 'info_req':
        void this.info(frame.reqId);
        break;
      case 'cancel':
        this.active.get(frame.reqId)?.abort();
        break;
      default:
        break;
    }
  }

  private async info(reqId: number): Promise<void> {
    try {
      const size = await this.sizeOf();
      this.sendFrame(encodeInfo(reqId, size, this.source.mime));
    } catch {
      this.fail(reqId, 'source');
    }
  }

  private async serve(reqId: number, start: number, end: number): Promise<void> {
    if (!isValidRange(start, end) || this.active.has(reqId)) return this.fail(reqId, 'bad_request');
    if (end - start > this.maxRangeBytes) return this.fail(reqId, 'too_large');
    if (this.active.size >= this.maxConcurrent) return this.fail(reqId, 'busy');
    const ctl = new AbortController();
    this.active.set(reqId, ctl);
    try {
      const size = await this.sizeOf();
      if (end > size) throw new RelayError('out_of_range');
      await this.pump(reqId, start, end, ctl.signal);
    } catch (err) {
      if (!ctl.signal.aborted) {
        const known = err instanceof RelayError && (RANGE_ERROR_CODES as readonly string[]).includes(err.code);
        this.fail(reqId, known ? (err as RelayError).code as RangeErrorCode : 'source');
      }
    } finally {
      this.active.delete(reqId);
      this.emit(true);
    }
  }

  /** Lit la plage par blocs et envoie des morceaux de 64 Ko, en freinant quand le tampon d'envoi est plein. */
  private async pump(reqId: number, start: number, end: number, signal: AbortSignal): Promise<void> {
    for (let off = start; off < end; ) {
      const blockEnd = Math.min(end, off + this.readBlock);
      const block = await this.source.read(off, blockEnd, signal);
      if (signal.aborted) return;
      if (!block || block.byteLength !== blockEnd - off) throw new RelayError('source');
      for (let p = 0; p < block.byteLength; p += CHUNK_BYTES) {
        while (!signal.aborted && this.channel.bufferedAmount > this.highWater) await this.waitLow(signal);
        if (signal.aborted) return;
        const part = block.subarray(p, Math.min(p + CHUNK_BYTES, block.byteLength));
        const at = off + p;
        this.sendFrame(encodeData(reqId, at, part, at + part.byteLength === end));
        this.bytesSent += part.byteLength;
        this.meter.add(part.byteLength);
        this.emit(false);
      }
      off = blockEnd;
    }
  }

  /** Attend `bufferedamountlow` (ou l'annulation). */
  private waitLow(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.channel.removeEventListener('bufferedamountlow', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', done);
      signal.addEventListener('abort', done);
    });
  }

  private sizeOf(): Promise<number> {
    if (!this.sizeP) {
      this.sizeP = Promise.resolve()
        .then(() => this.source.size())
        .then((n) => {
          if (!Number.isSafeInteger(n) || n < 0) throw new RelayError('source');
          return n;
        })
        .catch((err: unknown) => {
          this.sizeP = null;
          throw err;
        });
    }
    return this.sizeP;
  }

  private sendFrame(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.channel.readyState !== 'open') {
      this.close();
      return;
    }
    try {
      this.channel.send(frame);
    } catch {
      this.close();
    }
  }

  private fail(reqId: number, code: RangeErrorCode): void {
    this.sendFrame(encodeErr(reqId, code));
  }

  private emit(force: boolean): void {
    const cb = this.onStats;
    if (!cb) return;
    const t = this.now();
    if (!force && t - this.lastEmit < STATS_EVERY_MS) return;
    this.lastEmit = t;
    cb(this.stats());
  }
}
