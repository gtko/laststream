/* Protocole binaire des plages, sur le DataChannel « ranges » entre l'hôte et l'invité. Trames big-endian.
 * Aucune URL ni texte libre n'y circule (seulement des codes d'erreur) : rien à journaliser ni à afficher.
 *
 *   invité -> hôte
 *     REQ     [1][reqId u32][start u64][end u64]   octets [start, end) du fichier (end exclu), 8 Mo au plus
 *     INFO?   [2][reqId u32]                       demande la taille et le type
 *     CANCEL  [6][reqId u32]                       annule la requête
 *   hôte -> invité
 *     INFO    [3][reqId u32][size u64][mimeLen u16][mime utf-8]   mimeLen 0 : type inconnu
 *     DATA    [4][reqId u32][offset u64][flags u8][octets]        64 Ko au plus ; offset = position dans le fichier ;
 *                                                                 flags bit 0 = dernier morceau de la requête
 *     ERR     [5][reqId u32][code u8]                             code = index dans RANGE_ERROR_CODES
 *   maillage entre invités (ajouts de fin ; un pair qui ne les connaît pas les ignore et reste en relais direct)
 *     MESH?   [32][reqId u32]                                     invité -> hôte, ou invité <-> invité : annonce du maillage
 *     MESH    [33][reqId u32][pieceShift u8][idLen u8][fileId]    réponse : taille des morceaux (1 << shift) et identifiant opaque du fichier
 *     HAVE    [34][reqId u32][n u16][(start u32, len u32) × n]    morceaux détenus (intervalles d'index), instantané complet
 *     LOCATE  [35][reqId u32][index u32]                          invité -> hôte : qui a ce morceau, et son hachage ?
 *     LOCATED [36][reqId u32][index u32][flags u8][sha256 32][n u8][(idLen u8, id) × n]
 *                                                                 flags bit 0 = en cours chez un autre invité (attendre) ; hachage nul = inconnu
 *
 * Encodage et décodage purs (testés dans src/relay/protocol.test.ts). */

/** Nom du DataChannel des plages (créé par l'hôte). */
export const RELAY_CHANNEL_LABEL = 'ranges';
export const CHUNK_BYTES = 64 * 1024;
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;
export const MAX_MIME_BYTES = 255;
export const FLAG_FIN = 0x01;

/** Codes envoyés par l'hôte (index = octet sur le fil : ne pas réordonner). */
// `unshareable` (lecture refusée au navigateur de l'hôte : CORS, lien non lisible en web) est ajouté en fin : les index existants ne bougent pas.
export const RANGE_ERROR_CODES = ['bad_request', 'too_large', 'out_of_range', 'busy', 'source', 'unshareable'] as const;
export type RangeErrorCode = (typeof RANGE_ERROR_CODES)[number];

/** Codes locaux (délais, annulation, fermeture) en plus des codes de l'hôte. */
export type RelayErrorCode = RangeErrorCode | 'timeout' | 'cancelled' | 'closed' | 'unavailable' | 'protocol';

const MESSAGES: Record<RelayErrorCode, string> = {
  bad_request: 'Requête de plage invalide.',
  too_large: 'Plage trop grande pour une seule requête.',
  out_of_range: 'Plage hors du fichier.',
  busy: 'Trop de requêtes en cours côté hôte.',
  source: 'Lecture de la source impossible.',
  unshareable: 'Ce lien ne peut pas être partagé depuis le navigateur.',
  timeout: 'Délai dépassé.',
  cancelled: 'Requête annulée.',
  closed: 'Canal de relais fermé.',
  unavailable: 'Connexion au relais impossible.',
  protocol: 'Réponse inattendue du relais.',
};

const RETRYABLE: ReadonlySet<RelayErrorCode> = new Set<RelayErrorCode>(['busy', 'source', 'timeout']);

/** Erreur du relais : message fixe, jamais d'URL ni de contenu de la source. */
export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode) {
    super(MESSAGES[code]);
    this.name = 'RelayError';
    this.code = code;
  }

  /** Vrai si la reprise peut réussir (hôte occupé, source momentanément en échec, délai). */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Interface minimale d'un DataChannel (un RTCDataChannel la satisfait, un canal en mémoire aussi). */
export type ChannelEvent = 'open' | 'message' | 'close' | 'bufferedamountlow';

export interface ChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: ChannelEvent, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: ChannelEvent, listener: (ev: { data?: unknown }) => void): void;
}

export type RelayFrame =
  | { t: 'req'; reqId: number; start: number; end: number }
  | { t: 'info_req'; reqId: number }
  | { t: 'info'; reqId: number; size: number; mime?: string }
  | { t: 'data'; reqId: number; offset: number; fin: boolean; payload: Uint8Array }
  | { t: 'err'; reqId: number; code: RangeErrorCode }
  | { t: 'cancel'; reqId: number }
  | { t: 'mesh_req'; reqId: number }
  | { t: 'mesh'; reqId: number; pieceShift: number; fileId: string }
  | { t: 'have'; reqId: number; ranges: PieceInterval[] }
  | { t: 'locate'; reqId: number; index: number }
  | { t: 'located'; reqId: number; index: number; pending: boolean; hash: Uint8Array | null; holders: string[] };

/** Intervalle d'index de morceaux [start, start + len). */
export interface PieceInterval {
  start: number;
  len: number;
}

// Maillage : 32 et suivants, pour ne pas heurter les types ajoutés à la suite par d'autres chantiers (7 à 31).
const TYPE = { req: 1, infoReq: 2, info: 3, data: 4, err: 5, cancel: 6, meshReq: 32, mesh: 33, have: 34, locate: 35, located: 36 } as const;
/** Intervalles au plus par instantané HAVE, longueur maximale d'un identifiant de fichier ou de pair. */
export const MAX_HAVE_RANGES = 512;
export const MAX_ID_BYTES = 64;
const DATA_HEADER = 14;
const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Plage valide : entiers sûrs, start >= 0, end > start. */
export function isValidRange(start: number, end: number): boolean {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start;
}

function checkId(reqId: number): number {
  if (!Number.isInteger(reqId) || reqId < 0 || reqId > 0xffffffff) throw new Error('reqId hors bornes');
  return reqId;
}

function checkPos(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('position hors bornes');
  return n;
}

function header(len: number, type: number, reqId: number): { out: Uint8Array; view: DataView } {
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint32(1, checkId(reqId));
  return { out, view };
}

export function encodeReq(reqId: number, start: number, end: number): Uint8Array {
  checkPos(start);
  checkPos(end);
  const { out, view } = header(21, TYPE.req, reqId);
  view.setBigUint64(5, BigInt(start));
  view.setBigUint64(13, BigInt(end));
  return out;
}

export function encodeInfoReq(reqId: number): Uint8Array {
  return header(5, TYPE.infoReq, reqId).out;
}

export function encodeCancel(reqId: number): Uint8Array {
  return header(5, TYPE.cancel, reqId).out;
}

/** Réponse d'information ; un type trop long (> 255 octets) est omis. */
export function encodeInfo(reqId: number, size: number, mime?: string): Uint8Array {
  checkPos(size);
  const raw = mime ? utf8.encode(mime) : new Uint8Array(0);
  const m = raw.byteLength <= MAX_MIME_BYTES ? raw : new Uint8Array(0);
  const { out, view } = header(15 + m.byteLength, TYPE.info, reqId);
  view.setBigUint64(5, BigInt(size));
  view.setUint16(13, m.byteLength);
  out.set(m, 15);
  return out;
}

export function encodeData(reqId: number, offset: number, payload: Uint8Array, fin: boolean): Uint8Array {
  checkPos(offset);
  if (payload.byteLength > CHUNK_BYTES) throw new Error('morceau trop grand');
  const { out, view } = header(DATA_HEADER + payload.byteLength, TYPE.data, reqId);
  view.setBigUint64(5, BigInt(offset));
  view.setUint8(13, fin ? FLAG_FIN : 0);
  out.set(payload, DATA_HEADER);
  return out;
}

export function encodeErr(reqId: number, code: RangeErrorCode): Uint8Array {
  const index = RANGE_ERROR_CODES.indexOf(code);
  if (index < 0) throw new Error('code inconnu');
  const { out, view } = header(6, TYPE.err, reqId);
  view.setUint8(5, index);
  return out;
}

function readU64(view: DataView, at: number): number | null {
  const big = view.getBigUint64(at);
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : null;
}

/** Trame décodée, ou null si elle est malformée ou d'un type inconnu (jamais d'exception). */
export function decodeFrame(buf: Uint8Array): RelayFrame | null {
  if (buf.byteLength < 5) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = buf.byteLength;
  const type = view.getUint8(0);
  const reqId = view.getUint32(1);
  switch (type) {
    case TYPE.req: {
      if (n !== 21) return null;
      const start = readU64(view, 5);
      const end = readU64(view, 13);
      return start === null || end === null ? null : { t: 'req', reqId, start, end };
    }
    case TYPE.infoReq:
      return n === 5 ? { t: 'info_req', reqId } : null;
    case TYPE.info: {
      if (n < 15) return null;
      const size = readU64(view, 5);
      const mimeLen = view.getUint16(13);
      if (size === null || n !== 15 + mimeLen) return null;
      if (mimeLen === 0) return { t: 'info', reqId, size };
      try {
        return { t: 'info', reqId, size, mime: utf8Strict.decode(buf.subarray(15)) };
      } catch {
        return null;
      }
    }
    case TYPE.data: {
      if (n < DATA_HEADER) return null;
      const offset = readU64(view, 5);
      if (offset === null || n - DATA_HEADER > CHUNK_BYTES) return null;
      return { t: 'data', reqId, offset, fin: (view.getUint8(13) & FLAG_FIN) !== 0, payload: buf.subarray(DATA_HEADER) };
    }
    case TYPE.err: {
      if (n !== 6) return null;
      const code = RANGE_ERROR_CODES[view.getUint8(5)];
      return code === undefined ? null : { t: 'err', reqId, code };
    }
    case TYPE.cancel:
      return n === 5 ? { t: 'cancel', reqId } : null;
    case TYPE.meshReq:
      return n === 5 ? { t: 'mesh_req', reqId } : null;
    case TYPE.mesh: {
      if (n < 7 || n !== 7 + view.getUint8(6)) return null;
      const shift = view.getUint8(5);
      if (shift < 10 || shift > 26) return null;
      try {
        return { t: 'mesh', reqId, pieceShift: shift, fileId: utf8Strict.decode(buf.subarray(7)) };
      } catch {
        return null;
      }
    }
    case TYPE.have: {
      if (n < 7) return null;
      const count = view.getUint16(5);
      if (count > MAX_HAVE_RANGES || n !== 7 + count * 8) return null;
      const ranges: PieceInterval[] = [];
      for (let i = 0; i < count; i += 1) {
        const start = view.getUint32(7 + i * 8);
        const len = view.getUint32(11 + i * 8);
        if (len === 0 || start + len > 0xffffffff) return null;
        ranges.push({ start, len });
      }
      return { t: 'have', reqId, ranges };
    }
    case TYPE.locate:
      return n === 9 ? { t: 'locate', reqId, index: view.getUint32(5) } : null;
    case TYPE.located: {
      if (n < 43) return null;
      const holderCount = view.getUint8(42);
      const holders: string[] = [];
      let at = 43;
      try {
        for (let i = 0; i < holderCount; i += 1) {
          if (at >= n) return null;
          const len = view.getUint8(at);
          if (at + 1 + len > n) return null;
          holders.push(utf8Strict.decode(buf.subarray(at + 1, at + 1 + len)));
          at += 1 + len;
        }
      } catch {
        return null;
      }
      if (at !== n) return null;
      const hash = buf.slice(10, 42);
      return { t: 'located', reqId, index: view.getUint32(5), pending: (view.getUint8(9) & 1) !== 0, hash: hash.some((b) => b !== 0) ? hash : null, holders };
    }
    default:
      return null;
  }
}

/** Octets d'un message reçu (ArrayBuffer ou vue), ou null pour une charge texte. */
export function toBytes(data: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  return null;
}

// ---- Maillage entre invités (ajouts de fin) ----

export function encodeMeshReq(reqId: number): Uint8Array {
  return header(5, TYPE.meshReq, reqId).out;
}

export function encodeMesh(reqId: number, pieceShift: number, fileId: string): Uint8Array {
  const id = utf8.encode(fileId);
  if (id.byteLength > MAX_ID_BYTES) throw new Error('identifiant trop long');
  const { out, view } = header(7 + id.byteLength, TYPE.mesh, reqId);
  view.setUint8(5, pieceShift);
  view.setUint8(6, id.byteLength);
  out.set(id, 7);
  return out;
}

/** Instantané des morceaux détenus ; au-delà de MAX_HAVE_RANGES intervalles, les plus à droite sont omis. */
export function encodeHave(reqId: number, ranges: readonly PieceInterval[]): Uint8Array {
  const list = ranges.slice(0, MAX_HAVE_RANGES);
  const { out, view } = header(7 + list.length * 8, TYPE.have, reqId);
  view.setUint16(5, list.length);
  list.forEach((r, i) => {
    view.setUint32(7 + i * 8, r.start);
    view.setUint32(11 + i * 8, r.len);
  });
  return out;
}

export function encodeLocate(reqId: number, index: number): Uint8Array {
  const { out, view } = header(9, TYPE.locate, reqId);
  view.setUint32(5, index);
  return out;
}

/** Réponse de l'hôte : hachage SHA-256 du morceau (null : inconnu) et invités qui le détiennent. */
export function encodeLocated(reqId: number, index: number, hash: Uint8Array | null, holders: readonly string[], pending = false): Uint8Array {
  if (hash && hash.byteLength !== 32) throw new Error('hachage de 32 octets attendu');
  const ids = holders.slice(0, 8).map((h) => utf8.encode(h)).filter((b) => b.byteLength > 0 && b.byteLength <= MAX_ID_BYTES);
  const { out, view } = header(43 + ids.reduce((sum, b) => sum + 1 + b.byteLength, 0), TYPE.located, reqId);
  view.setUint32(5, index);
  view.setUint8(9, pending ? 1 : 0);
  if (hash) out.set(hash, 10);
  view.setUint8(42, ids.length);
  let at = 43;
  for (const b of ids) {
    view.setUint8(at, b.byteLength);
    out.set(b, at + 1);
    at += 1 + b.byteLength;
  }
  return out;
}
