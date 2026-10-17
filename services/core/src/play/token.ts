import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Copie portée par le jeton. Le JSON utilise des noms courts : h, i, u, f, z. */
export interface PlayCopy {
  infoHash?: string;
  fileIdx?: number;
  url?: string;
  filename?: string;
  size?: number;
}

export interface EncodeCopiesOptions {
  secret: string;
  season?: number;
  episode?: number;
  /** Nombre maximal de copies portées (1 à 64). Défaut : 8. */
  maxCopies?: number;
}

export interface DecodedCopies {
  copies: PlayCopy[];
  season?: number;
  episode?: number;
}

/** Contexte HKDF : la clé de signature est distincte des clés de chiffrement et de signature d'URL. */
const HKDF_INFO = 'lastaddon/play/copies/v1';
const TAG_BYTES = 16;
const DEFAULT_MAX_COPIES = 8;
const MAX_DECODED_COPIES = 64;
const MAX_TOKEN_LENGTH = 4 * 1024;
const MAX_FILE_IDX = 1_000_000;
const MAX_SEASON_EPISODE = 9_999;
const MAX_URL_LENGTH = 2048;
const MAX_FILENAME_LENGTH = 512;
/** Hash v1 (40 hex) ou v2 (64 hex), insensible à la casse. */
const INFO_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CompactCopy {
  h?: string;
  i?: number;
  u?: string;
  f?: string;
  z?: number;
}

function deriveKey(secret: string): Buffer {
  if (secret.length === 0) throw new RangeError('secret vide');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32));
}

/** Tronque l'HMAC-SHA256 du corps encodé à 16 octets. */
function tagOf(key: Buffer, encodedPayload: string): Buffer {
  return createHmac('sha256', key).update(encodedPayload, 'utf8').digest().subarray(0, TAG_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Forme compacte d'une copie ; les champs absents ne sont pas écrits. */
function toCompact(copy: PlayCopy): CompactCopy {
  const compact: CompactCopy = {};
  if (copy.infoHash !== undefined) compact.h = copy.infoHash;
  if (copy.fileIdx !== undefined) compact.i = copy.fileIdx;
  if (copy.url !== undefined) compact.u = copy.url;
  if (copy.filename !== undefined) compact.f = copy.filename;
  if (copy.size !== undefined) compact.z = copy.size;
  return compact;
}

/**
 * Valide une copie compacte. Une copie doit porter un hash ou une URL, et chaque champ présent doit être bien formé.
 * Renvoie undefined sinon. Sert à l'encodage (on écarte les copies inutilisables) comme au décodage.
 */
function copyFromCompact(value: unknown): PlayCopy | undefined {
  if (!isRecord(value)) return undefined;
  const { h, i, u, f, z } = value;
  const copy: PlayCopy = {};
  if (h !== undefined) {
    if (typeof h !== 'string' || !INFO_HASH_PATTERN.test(h)) return undefined;
    copy.infoHash = h;
  }
  if (i !== undefined) {
    if (!isInteger(i, 0, MAX_FILE_IDX)) return undefined;
    copy.fileIdx = i;
  }
  if (u !== undefined) {
    if (!isBoundedString(u, MAX_URL_LENGTH)) return undefined;
    copy.url = u;
  }
  if (f !== undefined) {
    if (!isBoundedString(f, MAX_FILENAME_LENGTH)) return undefined;
    copy.filename = f;
  }
  if (z !== undefined) {
    if (!isInteger(z, 0, Number.MAX_SAFE_INTEGER)) return undefined;
    copy.size = z;
  }
  return copy.infoHash !== undefined || copy.url !== undefined ? copy : undefined;
}

function sealed(body: CompactBody, key: Buffer): string {
  const encodedPayload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encodedPayload}.${tagOf(key, encodedPayload).toString('base64url')}`;
}

interface CompactBody {
  c: CompactCopy[];
  s?: number;
  e?: number;
}

function checkEpisodePart(value: number | undefined, name: string): void {
  if (value !== undefined && !isInteger(value, 0, MAX_SEASON_EPISODE)) {
    throw new RangeError(`${name} invalide (entier de 0 à ${MAX_SEASON_EPISODE})`);
  }
}

/**
 * Encode la liste ordonnée des copies en jeton signé : `<payload base64url>.<tag base64url>`.
 * Les copies inutilisables (ni hash ni URL, champ mal formé) sont écartées. On garde les `maxCopies` premières,
 * puis on retire les dernières tant que le jeton dépasse 4 Ko. Lève RangeError si aucune copie ne tient.
 */
export function encodeCopiesToken(copies: readonly PlayCopy[], options: EncodeCopiesOptions): string {
  const { secret, season, episode } = options;
  const maxCopies = options.maxCopies ?? DEFAULT_MAX_COPIES;
  if (!isInteger(maxCopies, 1, MAX_DECODED_COPIES)) {
    throw new RangeError(`maxCopies invalide (entier de 1 à ${MAX_DECODED_COPIES})`);
  }
  checkEpisodePart(season, 'saison');
  checkEpisodePart(episode, 'épisode');

  const valid = copies.flatMap((copy) => {
    const compact = toCompact(copy);
    return copyFromCompact(compact) === undefined ? [] : [compact];
  });
  const key = deriveKey(secret);
  for (let count = Math.min(valid.length, maxCopies); count >= 1; count--) {
    const body: CompactBody = { c: valid.slice(0, count) };
    if (season !== undefined) body.s = season;
    if (episode !== undefined) body.e = episode;
    const token = sealed(body, key);
    if (token.length <= MAX_TOKEN_LENGTH) return token;
  }
  throw new RangeError('aucune copie utilisable ne tient dans le jeton');
}

function decodeBody(body: unknown): DecodedCopies | null {
  const entries = isRecord(body) ? body.c : undefined;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_DECODED_COPIES) return null;
  const copies: PlayCopy[] = [];
  for (const entry of entries) {
    const copy = copyFromCompact(entry);
    if (copy === undefined) return null;
    copies.push(copy);
  }
  const result: DecodedCopies = { copies };
  const season = isRecord(body) ? body.s : undefined;
  if (season !== undefined) {
    if (!isInteger(season, 0, MAX_SEASON_EPISODE)) return null;
    result.season = season;
  }
  const episode = isRecord(body) ? body.e : undefined;
  if (episode !== undefined) {
    if (!isInteger(episode, 0, MAX_SEASON_EPISODE)) return null;
    result.episode = episode;
  }
  return result;
}

/**
 * Décode et vérifie un jeton produit par encodeCopiesToken. La signature est vérifiée avant toute lecture du contenu.
 * Renvoie null si le jeton est trop long (> 4 Ko), malformé, signé avec un autre secret, ou au contenu invalide.
 */
export function decodeCopiesToken(token: string, secret: string): DecodedCopies | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!BASE64URL_PATTERN.test(encodedPayload) || !BASE64URL_PATTERN.test(signature)) return null;

  const given = Buffer.from(signature, 'base64url');
  const expected = tagOf(deriveKey(secret), encodedPayload);
  if (given.length !== TAG_BYTES || !timingSafeEqual(given, expected)) return null;

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return decodeBody(body);
}
