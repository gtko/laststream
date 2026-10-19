/* Côté hôte : état du maillage d'un fichier partagé.
 *  - identifiant de fichier opaque (aléatoire, jamais lié à l'URL) annoncé aux invités qui le demandent (MESH?) ;
 *  - hachage SHA-256 de chaque morceau, calculé à la lecture de la source (`wrap`) : l'hôte ne lit jamais la source pour
 *    répondre à un LOCATE, un morceau dont le hachage est inconnu n'est donc proposé à aucun pair ;
 *  - ce que chaque invité annonce détenir (HAVE) ; LOCATE rend les détenteurs et le hachage du morceau, de sorte que les
 *    morceaux déjà chez un invité sont demandés à des invités : un morceau rare part de l'hôte vers un seul invité, qui le propage ;
 *  - morceau en cours chez un invité (premier à le demander) : les suivants attendent un court instant plutôt que de le
 *    redemander à l'hôte (drapeau « pending »). */

import { MAX_ID_BYTES, decodeFrame, encodeLocated, encodeMesh, toBytes, type ChannelLike, type RelayFrame } from '../protocol';
import type { RangeSource } from '../host';
import { PIECE_BYTES, PIECE_SHIFT, fromIntervals, pieceBounds, pieceCount, sha256 } from './pieces';

export interface MeshHostOptions {
  /** Identifiant opaque du fichier (défaut : 128 bits aléatoires). */
  fileId?: string;
  /** Durée pendant laquelle un morceau en cours chez un invité fait patienter les autres (ms). */
  pendingMs?: number;
  /** Détenteurs proposés au plus par réponse. */
  maxHolders?: number;
  now?: () => number;
  random?: () => number;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class MeshHostState {
  readonly fileId: string;
  private readonly hashes = new Map<number, Uint8Array>();
  private readonly have = new Map<string, Set<number>>();
  private readonly inflight = new Map<number, { guest: string; at: number }>();
  private readonly pendingMs: number;
  private readonly maxHolders: number;
  private readonly now: () => number;
  private readonly random: () => number;
  /** Octets servis depuis l'hôte vers des invités, et nombre de LOCATE répondus avec au moins un détenteur. */
  redirected = 0;

  constructor(opts: MeshHostOptions = {}) {
    this.fileId = opts.fileId ?? randomId();
    if (new TextEncoder().encode(this.fileId).byteLength > MAX_ID_BYTES) throw new Error('identifiant trop long');
    this.pendingMs = opts.pendingMs ?? 3000;
    this.maxHolders = opts.maxHolders ?? 4;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  /** Source qui hache chaque morceau complet lu (alignés sur PIECE_BYTES), pour les réponses LOCATE. */
  wrap(inner: RangeSource): RangeSource {
    return {
      mime: inner.mime,
      size: () => inner.size(),
      read: async (start, end, signal) => {
        const bytes = await inner.read(start, end, signal);
        const size = await inner.size();
        for (let i = Math.ceil(start / PIECE_BYTES); ; i += 1) {
          const b = pieceBounds(i, size);
          if (!b || b.end > end || b.start < start) break;
          if (this.hashes.has(i) || bytes.byteLength !== end - start) continue;
          const piece = bytes.subarray(b.start - start, b.end - start);
          void sha256(piece).then((h) => this.hashes.set(i, h), () => undefined);
        }
        return bytes;
      },
    };
  }

  hashOf(index: number): Uint8Array | null {
    return this.hashes.get(index) ?? null;
  }

  /** Branche un invité : rend le traitement de ses trames de maillage (à passer en `onOther` du RangeServer). */
  attach(guestId: string, channel: ChannelLike, size: () => Promise<number>): (frame: RelayFrame) => void {
    this.have.set(guestId, new Set());
    const send = (frame: Uint8Array): void => {
      try {
        if (channel.readyState === 'open') channel.send(frame);
      } catch {
        /* canal fermé */
      }
    };
    return (frame) => {
      switch (frame.t) {
        case 'mesh_req':
          send(encodeMesh(frame.reqId, PIECE_SHIFT, this.fileId));
          break;
        case 'have':
          void size().then(
            (n) => {
              // Annonce remplaçante : un invité absent du suivi (déjà détaché) ne revient pas par ce chemin.
              if (this.have.has(guestId)) this.have.set(guestId, fromIntervals(frame.ranges, pieceCount(n)));
            },
            () => undefined,
          );
          break;
        case 'locate':
          void size().then(
            (n) => {
              if (frame.index >= pieceCount(n)) return;
              const { hash, holders, pending } = this.locate(guestId, frame.index);
              send(encodeLocated(frame.reqId, frame.index, hash, holders, pending));
            },
            () => undefined,
          );
          break;
        default:
          break;
      }
    };
  }

  detach(guestId: string): void {
    this.have.delete(guestId);
    for (const [index, f] of this.inflight) if (f.guest === guestId) this.inflight.delete(index);
  }

  /** Invités suivis (tests). */
  get guests(): string[] {
    return [...this.have.keys()];
  }

  private locate(asker: string, index: number): { hash: Uint8Array | null; holders: string[]; pending: boolean } {
    const hash = this.hashes.get(index) ?? null;
    const holders = [...this.have].filter(([id, set]) => id !== asker && set.has(index)).map(([id]) => id);
    if (holders.length > 0) {
      // Hachage pas encore calculé : le morceau existe chez un invité, on patiente un instant.
      if (!hash) return { hash: null, holders: [], pending: true };
      // Ordre aléatoire : la charge se répartit entre détenteurs.
      holders.sort(() => this.random() - 0.5);
      this.redirected += 1;
      return { hash, holders: holders.slice(0, this.maxHolders), pending: false };
    }
    const t = this.now();
    const f = this.inflight.get(index);
    if (f && f.guest !== asker && t - f.at < this.pendingMs && this.have.has(f.guest)) return { hash, holders: [], pending: true };
    this.inflight.set(index, { guest: asker, at: t });
    return { hash, holders: [], pending: false };
  }
}

/** Décode une trame reçue d'un canal, utile aux tests. */
export function frameOf(data: unknown): RelayFrame | null {
  const bytes = toBytes(data);
  return bytes ? decodeFrame(bytes) : null;
}
