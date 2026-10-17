import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { type Config, type ConfigInput, parseConfig } from './schema.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_ENCODED_LENGTH = 128 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Erreur de décodage. Message générique : ne contient jamais le contenu reçu. */
export class ConfigDecodeError extends Error {
  constructor(message = 'Configuration illisible ou chiffrement invalide') {
    super(message);
    this.name = 'ConfigDecodeError';
  }
}

function deriveKey(secret: string): Buffer {
  if (secret.length === 0) {
    throw new Error('Clé de chiffrement manquante');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Valide puis chiffre une configuration (AES-256-GCM, clé = sha256(secret)).
 * Format binaire : iv (12) | tag (16) | ciphertext, encodé en base64url.
 */
export function encodeConfig(config: ConfigInput | Config | unknown, secret: string): string {
  const valid = parseConfig(config);
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(valid), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function tryDecrypt(bytes: Buffer, secret: string): string | null {
  if (bytes.length <= IV_LENGTH + TAG_LENGTH) return null;
  const iv = bytes.subarray(0, IV_LENGTH);
  const tag = bytes.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = bytes.subarray(IV_LENGTH + TAG_LENGTH);
  try {
    const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Pas de message d'origine : V8 y recopie des extraits de l'entrée.
    throw new ConfigDecodeError();
  }
}

/**
 * Déchiffre une configuration encodée par encodeConfig et renvoie l'objet validé.
 * Si allowPlain est vrai, accepte aussi du JSON brut encodé en base64url ; sinon refusé.
 */
export function decodeConfig(encoded: string, secret: string, options: { allowPlain: boolean }): Config {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_ENCODED_LENGTH ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    throw new ConfigDecodeError('Configuration illisible : format invalide');
  }

  const bytes = Buffer.from(encoded, 'base64url');
  const decrypted = tryDecrypt(bytes, secret);
  if (decrypted !== null) {
    return parseConfig(parseJsonSafely(decrypted));
  }

  if (!options.allowPlain) {
    throw new ConfigDecodeError();
  }
  return parseConfig(parseJsonSafely(bytes.toString('utf8')));
}
