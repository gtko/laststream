import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Jeton d'élévation : preuve récente (10 minutes) que le propriétaire a ressaisi son mot de passe, exigée pour les
 * actions destructrices. Jeton signé (HMAC), sans stockage : lié au compte ET à la session (empreinte), il cesse de
 * valoir à la déconnexion, à la rotation de session ou à la révocation des sessions.
 */
export const ELEVATION_TTL_MS = 10 * 60_000;
const PURPOSE = 'admin-elevation';

export interface ElevationClaims {
  accountId: string;
  sessionHash: string;
}

interface Payload extends ElevationClaims {
  purpose: typeof PURPOSE;
  exp: number;
}

const keyOf = (secret: string): Buffer => createHmac('sha256', secret).update(PURPOSE).digest();

export function signElevation(claims: ElevationClaims, now: number, secret: string): { token: string; expiresAt: string } {
  const payload: Payload = { purpose: PURPOSE, accountId: claims.accountId, sessionHash: claims.sessionHash, exp: now + ELEVATION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', keyOf(secret)).update(body).digest('base64url');
  return { token: `${body}.${signature}`, expiresAt: new Date(payload.exp).toISOString() };
}

export type ElevationVerdict = 'ok' | 'expired' | 'invalid';

/** `expired` : jeton authentique mais périmé (le client doit redemander le mot de passe) ; `invalid` : absent, forgé ou d'une autre session. */
export function verifyElevation(token: string | undefined, expected: ElevationClaims, now: number, secret: string): ElevationVerdict {
  if (token === undefined) return 'invalid';
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return 'invalid';
  const body = token.slice(0, dot);
  const signature = Buffer.from(token.slice(dot + 1), 'base64url');
  const wanted = createHmac('sha256', keyOf(secret)).update(body).digest();
  if (signature.length !== wanted.length || !timingSafeEqual(signature, wanted)) return 'invalid';
  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
  } catch {
    return 'invalid';
  }
  if (payload.purpose !== PURPOSE || payload.accountId !== expected.accountId || payload.sessionHash !== expected.sessionHash || typeof payload.exp !== 'number') {
    return 'invalid';
  }
  return payload.exp > now ? 'ok' : 'expired';
}
