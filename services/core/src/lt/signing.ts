import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Contexte HKDF : la clé de signature est distincte de la clé de chiffrement des configurations. */
const HKDF_INFO = 'lastaddon/lt/tv-hls/v1';

/**
 * Signature des URL du proxy HLS. Une signature lie une URL à une configuration (son jeton) : seules les URL
 * émises par nos listes de chaînes ou par notre réécriture de playlist, pour cette configuration, sont acceptées.
 */
export interface UrlSigner {
  sign(scope: string, url: string): string;
  verify(scope: string, url: string, signature: string | null): boolean;
}

/** Signeur HMAC-SHA256 (base64url) dont la clé est dérivée de LASTADDON_SECRET par HKDF. */
export function createUrlSigner(secret: string): UrlSigner {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32));
  const sign = (scope: string, url: string): string =>
    createHmac('sha256', key).update(JSON.stringify([scope, url])).digest('base64url');
  return {
    sign,
    verify(scope, url, signature) {
      if (signature === null || signature === '') return false;
      const expected = Buffer.from(sign(scope, url));
      const given = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
