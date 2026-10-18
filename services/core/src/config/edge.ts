import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { safeEqual } from '../user/crypto.js';

/** En-tête portant le secret partagé avec le relais (Worker Cloudflare). */
const EDGE_HEADER = 'x-laststream-edge';
/** En-tête portant l'IP réelle du client, lue seulement si le secret du relais est valide. */
const CLIENT_IP_HEADER = 'x-laststream-client-ip';
const MIN_SECRET_LENGTH = 16;

const edgeRequests = new WeakSet<Request>();

/** LASTADDON_EDGE_SECRET : secret du relais de confiance (au moins 16 caractères). Absent ou trop court : aucun relais de confiance. */
export function edgeSecret(): string | undefined {
  const raw = process.env.LASTADDON_EDGE_SECRET?.trim();
  return raw !== undefined && raw.length >= MIN_SECRET_LENGTH ? raw : undefined;
}

/** Vrai si la requête vient du relais authentifié (secret valide) : ses en-têtes X-Forwarded-* sont alors fiables. */
export function isEdgeRequest(req: Request): boolean {
  return edgeRequests.has(req);
}

/**
 * Confiance limitée au relais authentifié : seule une requête portant le bon secret voit son IP remplacée par celle
 * du client réel (donc le débit se mesure par client). Sans secret valide, les en-têtes du relais sont ignorés.
 */
export function edgeTrust() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const secret = edgeSecret();
    const given = req.get(EDGE_HEADER);
    if (secret !== undefined && given !== undefined && safeEqual(given, secret)) {
      edgeRequests.add(req);
      const clientIp = req.get(CLIENT_IP_HEADER)?.trim();
      if (clientIp !== undefined && isIP(clientIp) !== 0) {
        Object.defineProperty(req, 'ip', { value: clientIp, configurable: true });
      }
    }
    next();
  };
}
