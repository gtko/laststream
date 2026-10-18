/**
 * Jeton d'accès au relais de plages du Worker Cloudflare (GET /__laststream/range).
 *
 * Module volontairement portable : WebCrypto uniquement (`globalThis.crypto.subtle`), ni `node:*` ni fs ni Buffer, pour
 * tourner à l'identique sous Node et sous Cloudflare Workers (lastAddon doit y être porté).
 *
 * Format : `<exp>.<signature>` — exp en secondes Unix, signature = HMAC-SHA256(secret, "range1\n<exp>\n<url>") en
 * base64url. Le jeton est lié à l'URL exacte du lien débridé : il ne sert à relayer aucune autre adresse.
 * Le Worker applique le même calcul (voir laststream-edge/src/range.js).
 */

export const RANGE_TOKEN_TTL_S = 6 * 3600;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  if (secret.length === 0) throw new RangeError('secret vide');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

const message = (exp: number, url: string): Uint8Array<ArrayBuffer> => encoder.encode(`range1\n${exp}\n${url}`);

export interface RangeToken {
  token: string;
  /** Expiration, secondes Unix. */
  exp: number;
}

/** Émet un jeton valable `ttlSeconds` (6 h par défaut) pour cette URL. */
export async function signRangeToken(
  secret: string,
  url: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = RANGE_TOKEN_TTL_S,
): Promise<RangeToken> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const key = await hmacKey(secret, 'sign');
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, message(exp, url)));
  return { token: `${exp}.${base64url(sig)}`, exp };
}

/** Vérifie signature (en temps constant, via WebCrypto) et expiration. */
export async function verifyRangeToken(secret: string, url: string, token: string, nowMs: number = Date.now()): Promise<boolean> {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(nowMs / 1000)) return false;
  const padded = m[2].replaceAll('-', '+').replaceAll('_', '/') + '=';
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, sig, message(exp, url));
}
