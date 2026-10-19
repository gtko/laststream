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
 *
 *   invité -> hôte (à l'ouverture du canal)
 *     CAPS    [7][reqId u32 = 0][mask u32]                        bit i = DECODE_CAPS[i] : décodages que l'invité sait faire
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

/**
 * Capacités de décodage annoncées par un invité (vidéo, puis audio). L'index sert de bit sur le fil : ne pas réordonner,
 * ajouter en fin de liste.
 */
export const DECODE_CAPS = ['h264', 'hevc', 'av1', 'vp9', 'aac', 'opus', 'ac3', 'eac3', 'dts', 'flac'] as const;
export type DecodeCap = (typeof DECODE_CAPS)[number];

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
  | { t: 'caps'; mask: number };

const TYPE = { req: 1, infoReq: 2, info: 3, data: 4, err: 5, cancel: 6, caps: 7 } as const;
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

/** Bits (DECODE_CAPS) des capacités d'une liste ; les noms inconnus sont ignorés. */
export function capsMask(caps: readonly string[]): number {
  let mask = 0;
  for (const cap of caps) {
    const i = DECODE_CAPS.indexOf(cap as DecodeCap);
    if (i >= 0) mask |= 1 << i;
  }
  return mask >>> 0;
}

/** Capacités d'un masque, dans l'ordre de DECODE_CAPS (les bits inconnus sont ignorés). */
export function capsFromMask(mask: number): DecodeCap[] {
  return DECODE_CAPS.filter((_, i) => (mask & (1 << i)) !== 0);
}

/** Annonce des capacités de décodage de l'invité (bits de DECODE_CAPS). */
export function encodeCaps(mask: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff) throw new Error('masque hors bornes');
  const { out, view } = header(9, TYPE.caps, 0);
  view.setUint32(5, mask);
  return out;
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
    case TYPE.caps:
      return n === 9 && reqId === 0 ? { t: 'caps', mask: view.getUint32(5) } : null;
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
