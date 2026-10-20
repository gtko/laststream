import { createHash } from 'node:crypto';

/** Taille maximale d'un fichier .torrent accepté, en octets. */
export const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
/** Profondeur maximale d'imbrication des listes et dictionnaires. */
const MAX_DEPTH = 32;
/** Nombre maximal de fichiers d'un torrent multi-fichiers. */
export const MAX_FILES = 20_000;

const MAX_INTEGER_CHARS = 20;
const MAX_LENGTH_DIGITS = 10;
const MAX_NAME_CHARS = 1_024;
const INTEGER_PATTERN = /^-?(0|[1-9][0-9]*)$/;
const LENGTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const TAG_INTEGER = 0x69; // i
const TAG_LIST = 0x6c; // l
const TAG_DICT = 0x64; // d
const TAG_END = 0x65; // e
const TAG_COLON = 0x3a; // :

export type TorrentErrorCode = 'malformed' | 'too_deep' | 'too_large' | 'too_many_files';

/**
 * Erreur typée de lecture d'un .torrent. Le message est constant : jamais de contenu du fichier, jamais d'URL.
 */
export class TorrentFormatError extends Error {
  readonly code: TorrentErrorCode;

  constructor(code: TorrentErrorCode, message: string) {
    super(message);
    this.name = 'TorrentFormatError';
    this.code = code;
  }
}

/** Fichier d'un torrent : position (ordre du .torrent), chemin relatif UTF-8 et taille en octets. */
export interface TorrentFile {
  idx: number;
  path: string;
  size: number;
}

/** Données utiles d'un .torrent. L'URL d'annonce (announce, announce-list) n'est jamais retournée : elle porte la passkey. */
export interface TorrentInfo {
  /** SHA-1 des octets bruts du dictionnaire info, en hexadécimal minuscule (40 caractères). */
  infoHash: string;
  name: string;
  /** Vrai si info.private vaut 1. */
  private: boolean;
  files: TorrentFile[];
  totalSize: number;
}

type BencodeValue = number | Buffer | BencodeValue[] | BencodeDict;
type BencodeDict = Map<string, BencodeValue>;

interface Span {
  start: number;
  end: number;
}

function malformed(detail: string): TorrentFormatError {
  return new TorrentFormatError('malformed', `bencode invalide : ${detail}`);
}

function checkDepth(depth: number): void {
  if (depth > MAX_DEPTH) throw new TorrentFormatError('too_deep', 'imbrication trop profonde');
}

/**
 * Lecteur bencode sur des octets. Il mémorise l'étendue exacte (offsets) du dictionnaire `info` de la racine :
 * le hash doit porter sur ces octets bruts, jamais sur une réécriture (ordre des clés, entiers, etc.).
 */
class Reader {
  private readonly buf: Buffer;
  private pos = 0;
  /** Octets bruts de la valeur de la clé « info » du dictionnaire racine. */
  infoSpan: Span | undefined = undefined;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get position(): number {
    return this.pos;
  }

  /** Lit une valeur ; `depth` est son niveau d'imbrication (la racine vaut 1). */
  value(depth: number): BencodeValue {
    const tag = this.peek();
    if (tag === TAG_INTEGER) return this.integer();
    if (tag === TAG_LIST) return this.list(depth);
    if (tag === TAG_DICT) return this.dict(depth);
    if (tag >= 0x30 && tag <= 0x39) return this.bytes();
    throw malformed('type inconnu');
  }

  private peek(): number {
    if (this.pos >= this.buf.length) throw malformed('fin de données inattendue');
    return this.buf[this.pos] ?? 0;
  }

  private integer(): number {
    const start = this.pos + 1;
    const limit = Math.min(this.buf.length, start + MAX_INTEGER_CHARS + 1);
    let end = -1;
    for (let i = start; i < limit; i += 1) {
      if (this.buf[i] === TAG_END) {
        end = i;
        break;
      }
    }
    if (end < 0) throw malformed('entier non terminé');
    const text = this.buf.toString('latin1', start, end);
    if (!INTEGER_PATTERN.test(text) || text === '-0') throw malformed('entier non canonique');
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw malformed('entier hors limites');
    this.pos = end + 1;
    return value;
  }

  private bytes(): Buffer {
    const start = this.pos;
    const limit = Math.min(this.buf.length, start + MAX_LENGTH_DIGITS + 1);
    let colon = -1;
    for (let i = start; i < limit; i += 1) {
      if (this.buf[i] === TAG_COLON) {
        colon = i;
        break;
      }
    }
    if (colon < 0) throw malformed('longueur de chaîne invalide');
    const digits = this.buf.toString('latin1', start, colon);
    if (!LENGTH_PATTERN.test(digits)) throw malformed('longueur de chaîne invalide');
    const length = Number(digits);
    const from = colon + 1;
    if (from + length > this.buf.length) throw malformed('chaîne tronquée');
    this.pos = from + length;
    return this.buf.subarray(from, this.pos);
  }

  private list(depth: number): BencodeValue[] {
    checkDepth(depth);
    this.pos += 1;
    const items: BencodeValue[] = [];
    while (this.peek() !== TAG_END) items.push(this.value(depth + 1));
    this.pos += 1;
    return items;
  }

  private dict(depth: number): BencodeDict {
    checkDepth(depth);
    this.pos += 1;
    const entries: BencodeDict = new Map();
    while (this.peek() !== TAG_END) {
      const tag = this.peek();
      if (tag < 0x30 || tag > 0x39) throw malformed('clé de dictionnaire invalide');
      // Clés en latin1 : une correspondance octet pour caractère, donc injective (aucune collision silencieuse).
      const key = this.bytes().toString('latin1');
      if (entries.has(key)) throw malformed('clé dupliquée');
      const valueStart = this.pos;
      const value = this.value(depth + 1);
      if (depth === 1 && key === 'info') this.infoSpan = { start: valueStart, end: this.pos };
      entries.set(key, value);
    }
    this.pos += 1;
    return entries;
  }
}

/** Texte UTF-8 nettoyé : sans caractères de contrôle, borné en longueur. */
function cleanText(bytes: Buffer): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  const printable = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
  return printable.join('').trim().slice(0, MAX_NAME_CHARS);
}

function textOf(value: BencodeValue | undefined): string | undefined {
  return Buffer.isBuffer(value) ? cleanText(value) : undefined;
}

/** Entrée de la liste `files` : taille et chemin (path.utf-8 de préférence à path). Segments . et .. ignorés. */
function fileOf(entry: BencodeValue, idx: number): TorrentFile {
  if (!(entry instanceof Map)) throw malformed('entrée de fichier invalide');
  const size = entry.get('length');
  if (typeof size !== 'number' || size < 0) throw malformed('taille de fichier invalide');
  const parts = entry.get('path.utf-8') ?? entry.get('path');
  if (!Array.isArray(parts)) throw malformed('chemin de fichier invalide');
  const segments = parts.map((part) => {
    if (!Buffer.isBuffer(part)) throw malformed('segment de chemin invalide');
    return cleanText(part);
  });
  const path = segments.filter((segment) => segment !== '' && segment !== '.' && segment !== '..').join('/');
  return { idx, path: path === '' ? `fichier-${idx + 1}` : path.slice(0, MAX_NAME_CHARS), size };
}

function describeInfo(info: BencodeDict, infoHash: string): TorrentInfo {
  const name = textOf(info.get('name.utf-8')) ?? textOf(info.get('name'));
  if (name === undefined) throw malformed('nom absent');
  const isPrivate = info.get('private') === 1;

  const fileList = info.get('files');
  let files: TorrentFile[];
  if (Array.isArray(fileList)) {
    if (fileList.length > MAX_FILES) throw new TorrentFormatError('too_many_files', 'trop de fichiers');
    files = fileList.map((entry, idx) => fileOf(entry, idx));
  } else {
    const length = info.get('length');
    if (typeof length !== 'number' || length < 0) throw malformed('taille absente');
    files = [{ idx: 0, path: name, size: length }];
  }

  let totalSize = 0;
  for (const file of files) totalSize += file.size;
  if (!Number.isSafeInteger(totalSize)) throw malformed('taille totale hors limites');
  return { infoHash, name, private: isPrivate, files, totalSize };
}

/**
 * Lit un fichier .torrent (octets) : infoHash = SHA-1 des octets bruts du dictionnaire info, nom, drapeau privé,
 * liste des fichiers. Lève TorrentFormatError (code typé, message constant) si le contenu est invalide, trop
 * volumineux ou trop profond. Les clés non triées sont tolérées ; les clés dupliquées et les données en trop non.
 */
export function parseTorrent(input: Uint8Array): TorrentInfo {
  if (input.byteLength > MAX_TORRENT_BYTES) throw new TorrentFormatError('too_large', 'torrent trop volumineux');
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const reader = new Reader(buf);
  const root = reader.value(1);
  if (reader.position !== buf.length) throw malformed('données en trop');
  if (!(root instanceof Map)) throw malformed('dictionnaire racine attendu');
  const info = root.get('info');
  const span = reader.infoSpan;
  if (span === undefined || !(info instanceof Map)) throw malformed('dictionnaire info absent');
  const infoHash = createHash('sha1').update(buf.subarray(span.start, span.end)).digest('hex');
  return describeInfo(info, infoHash);
}
