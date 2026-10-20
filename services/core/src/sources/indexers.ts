/** Titre et année, pour la recherche texte de repli. */
export interface TitleInfo {
  title: string;
  year?: number;
}

export function isMagnet(value: string | undefined): value is string {
  return value !== undefined && value.toLowerCase().startsWith('magnet:');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) de 32 caractères vers hexadécimal de 40 caractères minuscules. */
function base32ToHex(value: string): string | undefined {
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const char of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return undefined;
    acc = ((acc << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === 20 ? bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('') : undefined;
}

/** Info-hash BitTorrent (hex 40 ou base32 32) normalisé en hex 40 minuscules. */
function normalizeInfoHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(trimmed)) return base32ToHex(trimmed);
  return undefined;
}

const BTIH = /btih:([0-9a-z]{40}|[0-9a-z]{32})(?![0-9a-z])/i;

/** Info-hash extrait du paramètre xt=urn:btih d'un magnet, en hex 40 minuscules. */
export function infoHashFromMagnet(magnet: string | undefined): string | undefined {
  const match = BTIH.exec(magnet ?? '');
  return match?.[1] === undefined ? undefined : normalizeInfoHash(match[1]);
}
