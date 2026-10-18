import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Ctx } from '../http/app-env.js';
import { runtimeEnv } from '../platform/index.js';
import { safeEqual } from '../user/crypto.js';

/** En-tête portant le secret partagé avec le relais (Worker Cloudflare). */
const EDGE_HEADER = 'x-laststream-edge';
/** En-tête portant l'IP réelle du client, lue seulement si le secret du relais est valide. */
const CLIENT_IP_HEADER = 'x-laststream-client-ip';
const MIN_SECRET_LENGTH = 16;

/** LASTADDON_EDGE_SECRET : secret du relais de confiance (au moins 16 caractères). Absent ou trop court : aucun relais de confiance. */
export function edgeSecret(): string | undefined {
  const raw = runtimeEnv().get('LASTADDON_EDGE_SECRET')?.trim();
  return raw !== undefined && raw.length >= MIN_SECRET_LENGTH ? raw : undefined;
}

/** Vrai si la requête vient du relais authentifié (secret valide) : ses en-têtes X-Forwarded-* sont alors fiables. */
export function isEdgeRequest(c: Ctx): boolean {
  return c.get('edge') === true;
}

/**
 * Confiance limitée au relais authentifié : seule une requête portant le bon secret voit son IP remplacée par celle
 * du client réel (donc le débit se mesure par client). Sans secret valide, les en-têtes du relais sont ignorés.
 * À monter après la détermination de l'IP de base (socket ou proxy de confiance).
 */
export function edgeTrust(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const secret = edgeSecret();
    const given = c.req.header(EDGE_HEADER);
    if (secret !== undefined && given !== undefined && safeEqual(given, secret)) {
      c.set('edge', true);
      const clientIp = c.req.header(CLIENT_IP_HEADER)?.trim();
      if (clientIp !== undefined && isIP(clientIp) !== 0) c.set('ip', clientIp);
    }
    await next();
  };
}
