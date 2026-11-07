import { isIPv4, isIPv6 } from 'node:net';

/**
 * Indique si une adresse IP (v4 ou v6, crochets et zone id tolérés) n'est PAS publique :
 * non spécifiée, boucle locale, privée (RFC 1918, ULA fc00::/7), lien local, CGNAT (100.64/10),
 * benchmark, documentation, multicast, réservée. IPv4 embarquée (mappée, NAT64) : évaluée en IPv4.
 * Une chaîne qui n'est pas une adresse IP est refusée par défaut.
 */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (isIPv4(ip)) return isNonPublicIPv4(ip);
  if (!isIPv6(ip)) return true;
  const bytes = ipv6Bytes(ip);
  if (bytes === undefined) return true;
  return isNonPublicIPv6(bytes);
}

function isNonPublicIPv4(ip: string): boolean {
  const [a = -1, b = -1, c = -1] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 100 && (b & 0xc0) === 64) return true; // 100.64/10 (CGNAT)
  if (a === 169 && b === 254) return true; // lien local
  if (a === 172 && (b & 0xf0) === 16) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b & 0xfe) === 18) return true; // 198.18/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  return a >= 224; // multicast et réservé
}

function isNonPublicIPv6(bytes: readonly number[]): boolean {
  const allZero = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  const last4 = (): string => bytes.slice(12, 16).join('.');
  if (allZero(0, 12)) return true; // ::/96 (compatibilité IPv4 obsolète, ::1 et ::)
  if (allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isNonPublicIPv4(last4()); // ::ffff:0:0/96
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  if (nat64 && allZero(4, 12)) return isNonPublicIPv4(last4()); // 64:ff9b::/96
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 (ULA)
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 (lien local)
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 (site local obsolète)
  if (first === 0xff) return true; // ff00::/8 (multicast)
  return first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8; // 2001:db8::/32
}

/** Convertit une IPv6 textuelle (forme abrégée, IPv4 finale tolérée) en 16 octets. */
function ipv6Bytes(ip: string): number[] | undefined {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (groups < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const hextets = [...left, ...Array<string>(groups).fill('0'), ...right];
  const bytes: number[] = [];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return undefined;
    const value = parseInt(hextet, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : undefined;
}
