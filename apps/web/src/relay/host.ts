/* Côté hôte : sert des plages d'une source (le lien débridé, lu sur l'appareil de l'hôte) à un invité, par un DataChannel.
 * Les requêtes sont découpées en morceaux de 64 Ko ; le flux est freiné quand le tampon d'envoi dépasse le seuil haut
 * (reprise à l'événement `bufferedamountlow`). Limites : requêtes concurrentes, taille par requête, annulation par l'invité.
 * Aucune URL, aucun contenu d'erreur n'est envoyé ni journalisé : seulement des codes (RANGE_ERROR_CODES). */

import {
  CHUNK_BYTES, MAX_RANGE_BYTES, RANGE_ERROR_CODES, RelayError, decodeFrame, encodeData, encodeErr, encodeInfo, isValidRange,
  toBytes, type ChannelLike, type RangeErrorCode, type RelayFrame,
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
  /** Délai d'inactivité du lien (ms) : sans message de l'invité pendant ce temps, `onIdle` est appelé (défaut 2 min). */
  idleTimeoutMs?: number;
  onIdle?: () => void;
  /** Erreurs envoyées d'affilée avant `onAbuse` (défaut 20) ; une requête servie remet le compte à zéro. */
  maxConsecutiveErrors?: number;
  onAbuse?: () => void;
  /** Plafond de débit montant partagé par tous les liens d'un même hôte. */
  budget?: UploadBudget;
  /** Trames que le serveur de plages ne traite pas (maillage entre invités) ; elles comptent comme de l'activité. */
  onOther?: (frame: RelayFrame) => void;
}

/** Délai d'inactivité d'un lien (2 min) et erreurs consécutives tolérées (20) avant coupure. */
export const IDLE_TIMEOUT_MS = 120_000;
export const MAX_CONSECUTIVE_ERRORS = 20;
/** Débit montant par défaut de l'hôte, tous liens confondus, en mégabits par seconde. */
export const DEFAULT_UPLOAD_MBPS = 60;

export function mbpsToBytesPerSec(mbps: number): number {
  return (mbps * 1_000_000) / 8;
}

/** Seau à jetons : plafond de débit partagé. `reserve(n)` rend le délai (ms) à attendre avant d'envoyer `n` octets. */
export class UploadBudget {
  private tokens: number;
  private last: number;

  constructor(
    private readonly bytesPerSec: number,
    private readonly now: () => number = () => Date.now(),
    private readonly burst: number = Math.max(CHUNK_BYTES, bytesPerSec / 4),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  reserve(bytes: number): number {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.bytesPerSec);
    this.last = t;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.bytesPerSec) * 1000);
  }
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
  private readonly idleTimeout: number;
  private readonly maxErrors: number;
  private readonly onIdle: (() => void) | undefined;
  private readonly onAbuse: (() => void) | undefined;
  private readonly budget: UploadBudget | undefined;
  private readonly onOther: ((frame: RelayFrame) => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private errorStreak = 0;

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
    this.idleTimeout = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.maxErrors = options.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;
    this.onIdle = options.onIdle;
    this.onAbuse = options.onAbuse;
    this.budget = options.budget;
    this.onOther = options.onOther;
    this.meter = new RateMeter(this.now);
    channel.bufferedAmountLowThreshold = this.lowWater;
    channel.addEventListener('message', this.onMessage);
    channel.addEventListener('close', this.onClose);
    this.touch();
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
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.emit(true);
  }

  /** Remet à zéro le délai d'inactivité du lien. */
  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.onIdle?.();
    }, this.idleTimeout);
  }

  private handle(data: unknown): void {
    if (this.closed) return;
    this.touch();
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
        this.onOther?.(frame);
        break;
    }
  }

  private async info(reqId: number): Promise<void> {
    try {
      const size = await this.sizeOf();
      this.sendFrame(encodeInfo(reqId, size, this.source.mime));
      this.errorStreak = 0;
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
      this.errorStreak = 0;
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
        const wait = this.budget?.reserve(part.byteLength) ?? 0;
        if (wait > 0) {
          await this.sleep(wait, signal);
          if (signal.aborted) return;
        }
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
    this.errorStreak += 1;
    if (this.errorStreak === this.maxErrors) this.onAbuse?.();
  }

  /** Pause de `ms`, interrompue par l'annulation. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
    });
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
