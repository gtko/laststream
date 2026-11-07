/**
 * Fixtures binaires MKV et MP4 construites en code (aucun fichier média), et faux serveur Range.
 * Les builders produisent la structure minimale que lisent les parseurs de src/media.
 */

import type { FetchFn } from '../src/sources/http.js';

// ---------------------------------------------------------------------------
// EBML (Matroska)
// ---------------------------------------------------------------------------

/** Identifiant EBML sur sa longueur naturelle (le marqueur de longueur est déjà dans la valeur). */
function encodeId(id: number): Buffer {
  const length = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const out = Buffer.alloc(length);
  let value = id;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = value >>> 8;
  }
  return out;
}

/** Taille EBML sur la longueur minimale. */
function encodeSize(size: number): Buffer {
  for (let length = 1; length <= 8; length++) {
    if (size < 2 ** (7 * length) - 1) {
      const out = Buffer.alloc(length);
      let value = size;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = value % 256;
        value = Math.floor(value / 256);
      }
      out[0] = (out[0] ?? 0) | (0x80 >> (length - 1));
      return out;
    }
  }
  throw new Error('taille trop grande pour la fixture');
}

/** Élément EBML de taille connue. */
export function ebml(id: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeId(id), encodeSize(payload.length), payload]);
}

/** Élément EBML de taille inconnue (0x01FFFFFFFFFFFFFF) : sa fin est le bord du parent. */
function ebmlUnknownSize(id: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeId(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), payload]);
}

function uintBytes(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function uint(id: number, value: number): Buffer {
  return ebml(id, uintBytes(value));
}

function str(id: number, value: string): Buffer {
  return ebml(id, Buffer.from(value, 'utf8'));
}

function float64(id: number, value: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeDoubleBE(value);
  return ebml(id, payload);
}

/** Type Matroska codé dans TrackType. */
const TRACK_TYPE_CODE = { video: 1, audio: 2, subtitle: 17 } as const;

/** Piste MKV à construire. Langue et drapeaux omis = absents du fichier (défauts Matroska). */
export interface MkvTrackSpec {
  number: number;
  type: keyof typeof TRACK_TYPE_CODE;
  codecId: string;
  /** Element Language (ISO 639-2). */
  language?: string;
  /** Element LanguageBCP47 (ex. 'fr-CA'). */
  languageIetf?: string;
  name?: string;
  channels?: number;
  defaultFlag?: boolean;
  forced?: boolean;
}

function trackEntry(spec: MkvTrackSpec): Buffer {
  const parts: Buffer[] = [
    uint(0xd7, spec.number),
    uint(0x73c5, 1000 + spec.number),
    uint(0x83, TRACK_TYPE_CODE[spec.type]),
    str(0x86, spec.codecId),
  ];
  if (spec.name !== undefined) parts.push(str(0x536e, spec.name));
  if (spec.language !== undefined) parts.push(str(0x22b59c, spec.language));
  if (spec.languageIetf !== undefined) parts.push(str(0x22b59d, spec.languageIetf));
  if (spec.defaultFlag !== undefined) parts.push(uint(0x88, spec.defaultFlag ? 1 : 0));
  if (spec.forced !== undefined) parts.push(uint(0x55aa, spec.forced ? 1 : 0));
  if (spec.type === 'audio') {
    parts.push(ebml(0xe1, Buffer.concat([uint(0x9f, spec.channels ?? 2), float64(0xb5, 48000)])));
  }
  if (spec.type === 'video') {
    parts.push(ebml(0xe0, Buffer.concat([uint(0xb0, 1920), uint(0xba, 1080)])));
  }
  return ebml(0xae, Buffer.concat(parts));
}

/** Jeu par défaut : 1 vidéo, 2 audio (fre E-AC-3 Atmos 6 canaux ; eng AAC 2 canaux), 1 sous-titre (fre). */
export function defaultMkvTracks(): MkvTrackSpec[] {
  return [
    { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC' },
    { number: 2, type: 'audio', codecId: 'A_EAC3', language: 'fre', name: 'Français Atmos', channels: 6, defaultFlag: true },
    { number: 3, type: 'audio', codecId: 'A_AAC', language: 'eng', channels: 2 },
    { number: 4, type: 'subtitle', codecId: 'S_TEXT/UTF8', language: 'fre', name: 'Français', forced: false },
  ];
}

export interface MkvOptions {
  tracks?: MkvTrackSpec[];
  /** Durée en secondes (Info > Duration, TimecodeScale = 1 ms). */
  durationSec?: number;
  /** Segment à taille inconnue. */
  unknownSegmentSize?: boolean;
  /** Cluster à taille inconnue (placé en dernier, il s'étend jusqu'à la fin). */
  unknownClusterSize?: boolean;
  /** Taille du bloc média factice dans le Cluster. */
  clusterBytes?: number;
}

/** Construit un fichier MKV : EBML, Segment (SeekHead, Info, Tracks, Void, Cues, Cluster). */
export function buildMkv(options: MkvOptions = {}): Buffer {
  const tracks = options.tracks ?? defaultMkvTracks();
  const header = ebml(0x1a45dfa3, str(0x4282, 'matroska'));
  const seekHead = ebml(0x114d9b74, ebml(0x4dbb, ebml(0x53ab, Buffer.from([0x16, 0x54, 0xae, 0x6b]))));
  const infoParts = [uint(0x2ad7b1, 1_000_000)];
  if (options.durationSec !== undefined) infoParts.push(float64(0x4489, options.durationSec * 1000));
  const info = ebml(0x1549a966, Buffer.concat(infoParts));
  const tracksElement = ebml(0x1654ae6b, Buffer.concat(tracks.map(trackEntry)));
  const voidElement = ebml(0xec, Buffer.alloc(16));
  const cues = ebml(0x1c53bb6b, Buffer.alloc(8));
  const clusterPayload = Buffer.concat([uint(0xe7, 0), ebml(0xa3, Buffer.alloc(options.clusterBytes ?? 64, 0x55))]);
  const cluster = options.unknownClusterSize
    ? ebmlUnknownSize(0x1f43b675, clusterPayload)
    : ebml(0x1f43b675, clusterPayload);
  const segmentBody = Buffer.concat([seekHead, info, tracksElement, voidElement, cues, cluster]);
  const segment = options.unknownSegmentSize
    ? ebmlUnknownSize(0x18538067, segmentBody)
    : ebml(0x18538067, segmentBody);
  return Buffer.concat([header, segment]);
}

// ---------------------------------------------------------------------------
// MP4 / MOV
// ---------------------------------------------------------------------------

/** Boîte ISO BMFF de taille 32 bits. */
export function box(type: string, ...payloads: Buffer[]): Buffer {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** Boîte de taille 64 bits (taille 1 puis champ largesize). */
export function largeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 'latin1');
  header.writeBigUInt64BE(BigInt(payload.length + 16), 8);
  return Buffer.concat([header, payload]);
}

/** Code de langue ISO 639-2 empaqueté sur 16 bits (1 bit de remplissage, trois codes de 5 bits). */
export function packLanguage(code: string): number {
  const [a = 0, b = 0, c = 0] = [...code].map((letter) => letter.charCodeAt(0) - 0x60);
  return (a << 10) | (b << 5) | c;
}

function fullBox(type: string, body: Buffer): Buffer {
  return box(type, Buffer.alloc(4), body);
}

function mvhd(durationSec: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(1000, 12);
  payload.writeUInt32BE(Math.round(durationSec * 1000), 16);
  return box('mvhd', payload);
}

function mdhd(language: string): Buffer {
  const payload = Buffer.alloc(24);
  payload.writeUInt32BE(1000, 12);
  payload.writeUInt32BE(0, 16);
  payload.writeUInt16BE(packLanguage(language), 20);
  return box('mdhd', payload);
}

function hdlr(handler: string): Buffer {
  return box('hdlr', Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('Handler\0'));
}

/** Sample entry audio (AudioSampleEntry v0) : nombre de canaux à l'offset 24. */
function audioSampleEntry(codec: string, channels: number): Buffer {
  const entry = Buffer.alloc(36);
  entry.writeUInt32BE(36, 0);
  entry.write(codec, 4, 'latin1');
  entry.writeUInt16BE(1, 14);
  entry.writeUInt16BE(channels, 24);
  entry.writeUInt16BE(16, 26);
  entry.writeUInt32BE((48000 << 16) >>> 0, 32);
  return entry;
}

/** Sample entry générique (vidéo, sous-titres) : seul le fourcc compte pour les tests. */
function genericSampleEntry(codec: string): Buffer {
  const entry = Buffer.alloc(40);
  entry.writeUInt32BE(40, 0);
  entry.write(codec, 4, 'latin1');
  entry.writeUInt16BE(1, 14);
  return entry;
}

/** Piste MP4 à construire. */
export interface Mp4TrackSpec {
  handler: 'soun' | 'vide' | 'subt';
  /** Code ISO 639-2 sur trois lettres (ex. 'fre', 'und'). */
  language: string;
  /** Fourcc du sample entry (mp4a, ec-3, ac-3, tx3g, avc1…). */
  codec: string;
  channels?: number;
}

function trak(spec: Mp4TrackSpec): Buffer {
  const entry =
    spec.handler === 'soun'
      ? audioSampleEntry(spec.codec, spec.channels ?? 2)
      : genericSampleEntry(spec.codec);
  const stsd = fullBox('stsd', Buffer.concat([uintBuffer32(1), entry]));
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', mdhd(spec.language), hdlr(spec.handler), minf);
  return box('trak', box('tkhd', Buffer.alloc(84)), mdia);
}

function uintBuffer32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

export interface Mp4Options {
  tracks?: Mp4TrackSpec[];
  /** 'moov-first' : ftyp, moov, mdat. 'moov-last' : ftyp, mdat, moov (cas « moov à la fin »). */
  layout: 'moov-first' | 'moov-last';
  durationSec?: number;
  /** Taille du mdat factice, en octets. */
  mdatBytes?: number;
}

/** Jeu MP4 par défaut : une piste audio fre E-AC-3 6 canaux, une audio eng AAC 2 canaux, un sous-titre fre. */
export function defaultMp4Tracks(): Mp4TrackSpec[] {
  return [
    { handler: 'soun', language: 'fre', codec: 'ec-3', channels: 6 },
    { handler: 'soun', language: 'eng', codec: 'mp4a', channels: 2 },
    { handler: 'subt', language: 'fre', codec: 'tx3g' },
  ];
}

/** Construit un fichier MP4 (ftyp, moov, mdat) dans l'ordre demandé. */
export function buildMp4(options: Mp4Options): Buffer {
  const tracks = options.tracks ?? defaultMp4Tracks();
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), uintBuffer32(0x200), Buffer.from('isomiso2mp41', 'latin1'));
  const moov = box('moov', mvhd(options.durationSec ?? 0), ...tracks.map(trak));
  const mdat = box('mdat', Buffer.alloc(options.mdatBytes ?? 64, 0x11));
  return options.layout === 'moov-first'
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);
}

/** Offset du moov dans un fichier construit par buildMp4 (position de son en-tête). */
export function moovOffsetOf(file: Buffer): number {
  const at = file.indexOf('moov', 0, 'latin1');
  if (at < 4) throw new Error('moov absent de la fixture');
  return at - 4;
}

// ---------------------------------------------------------------------------
// Faux serveur HTTP (aucun réseau)
// ---------------------------------------------------------------------------

/** Appel enregistré par le faux serveur. */
export interface RecordedCall {
  url: string;
  range: string | undefined;
  headers: Record<string, string>;
}

/** Copie un Buffer dans un Uint8Array à buffer propre, accepté par Response. */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/**
 * Faux fetch qui sert `file` : requêtes `Range: bytes=a-b` (et `bytes=a-`) → 206 avec Content-Range ;
 * hors bornes → 416 ; sans Range, ou avec `ignoreRange` → 200 et le fichier entier.
 */
export function rangeServer(file: Buffer, options: { ignoreRange?: boolean } = {}): {
  fetch: FetchFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const range = headers.get('range') ?? undefined;
    calls.push({ url: String(input), range, headers: Object.fromEntries(headers.entries()) });
    const match = range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match === null || options.ignoreRange === true) {
      return new Response(bodyOf(file), { status: 200 });
    }
    const start = Number(match[1]);
    const last = match[2] === undefined || match[2] === '' ? file.length - 1 : Math.min(Number(match[2]), file.length - 1);
    if (start >= file.length || last < start) return new Response(null, { status: 416 });
    const slice = file.subarray(start, last + 1);
    return new Response(bodyOf(slice), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${last}/${file.length}` },
    });
  };
  return { fetch: handler as unknown as FetchFn, calls };
}
