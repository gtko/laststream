import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Primitives des données utilisateur. Mots de passe et PIN : scrypt (sel de 16 octets, paramètres stockés avec
 * le hash). Jetons de session : 32 octets aléatoires, seule leur empreinte SHA-256 est stockée. Jetons de profil
 * (déverrouillage PIN) : HMAC signé avec la clé serveur, liés à la session et à la version du PIN.
 */

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;
const SCRYPT_PREFIX = 'scrypt';

/**
 * Jeton de profil (déverrouillage PIN) : valide 30 jours, comme un profil resté déverrouillé sur un appareil. Il
 * cesse de valoir à la déconnexion, au changement de PIN, ou au changement de session.
 */
export const PROFILE_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const PROFILE_TOKEN_PURPOSE = 'profile-unlock';

function scryptAsync(secret: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hash scrypt d'un secret (mot de passe ou PIN). Format : scrypt$N$r$p$sel$clé (base64). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await scryptAsync(secret, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [SCRYPT_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Vérifie un secret contre un hash produit par hashSecret. Format invalide : false (jamais d'exception). */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = await scryptAsync(secret, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}

/** Comparaison de chaînes à temps constant (les deux côtés sont hachés pour des longueurs égales). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** Jeton de session : 32 octets aléatoires, encodés en base64url (43 caractères). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Empreinte SHA-256 (hex) d'un jeton de session : seule valeur stockée en base, et identifiant de session. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Clé dérivée, dédiée aux jetons de profil (séparée de la clé de chiffrement des configurations). */
function profileTokenKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(PROFILE_TOKEN_PURPOSE).digest();
}

/** Ce à quoi un jeton de profil est lié : compte, profil, session (empreinte) et version du PIN. */
export interface ProfileTokenClaims {
  accountId: string;
  profileId: string;
  sessionHash: string;
  pinVersion: number;
}

interface ProfileTokenPayload extends ProfileTokenClaims {
  purpose: typeof PROFILE_TOKEN_PURPOSE;
  exp: number;
}

/** Jeton court (charge utile JSON + HMAC). Invalide dès que la session ou la version du PIN change. */
export function signProfileToken(claims: ProfileTokenClaims, now: number, secret: string): { token: string; expiresAt: string } {
  const payload: ProfileTokenPayload = { purpose: PROFILE_TOKEN_PURPOSE, ...claims, exp: now + PROFILE_TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', profileTokenKey(secret)).update(body).digest('base64url');
  return { token: `${body}.${signature}`, expiresAt: new Date(payload.exp).toISOString() };
}

/** Vrai si le jeton est authentique, non expiré, et lié à exactement ces claims (compte, profil, session, PIN). */
export function verifyProfileToken(token: string, expected: ProfileTokenClaims, now: number, secret: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return false;
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), 'base64url');
  const expectedSignature = createHmac('sha256', profileTokenKey(secret)).update(body).digest();
  if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
  } catch {
    return false;
  }
  if (typeof payload !== 'object' || payload === null) return false;
  const claims = payload as Partial<ProfileTokenPayload>;
  return (
    claims.purpose === PROFILE_TOKEN_PURPOSE &&
    claims.accountId === expected.accountId &&
    claims.profileId === expected.profileId &&
    claims.sessionHash === expected.sessionHash &&
    claims.pinVersion === expected.pinVersion &&
    typeof claims.exp === 'number' &&
    claims.exp > now
  );
}
