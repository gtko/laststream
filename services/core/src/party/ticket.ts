import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Identity, TICKET_TTL_MS } from './protocol.js';

/**
 * Ticket de connexion WebSocket. Un navigateur ne peut pas poser d'en-tête Authorization sur une WebSocket et le jeton
 * de session ne doit pas finir dans une URL : POST /party/:id/join (authentifié) délivre ce ticket court (60 s), lié au
 * salon et au compte, passé en `?ticket=` à /party/:id/ws. Clé HMAC dérivée, séparée de celles des autres jetons.
 */
const PURPOSE = 'lastaddon-party-ticket-v1';

interface TicketPayload extends Identity {
  purpose: typeof PURPOSE;
  roomId: string;
  exp: number;
  nonce: string;
}

const key = (secret: string): Buffer => createHmac('sha256', secret).update(PURPOSE).digest();

export function signTicket(roomId: string, identity: Identity, now: number, secret: string): { ticket: string; expiresAt: string } {
  const payload: TicketPayload = { purpose: PURPOSE, roomId, ...identity, exp: now + TICKET_TTL_MS, nonce: randomBytes(8).toString('base64url') };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key(secret)).update(body).digest('base64url');
  return { ticket: `${body}.${signature}`, expiresAt: new Date(payload.exp).toISOString() };
}

/** Identité portée par un ticket authentique, non expiré et émis pour ce salon ; sinon `undefined`. */
export function verifyTicket(ticket: string, roomId: string, now: number, secret: string): Identity | undefined {
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot !== ticket.lastIndexOf('.') || ticket.length > 2048) return undefined;
  const body = ticket.slice(0, dot);
  const signature = Buffer.from(ticket.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', key(secret)).update(body).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
  let payload: Partial<TicketPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TicketPayload>;
  } catch {
    return undefined;
  }
  if (
    payload.purpose !== PURPOSE ||
    payload.roomId !== roomId ||
    typeof payload.exp !== 'number' ||
    payload.exp <= now ||
    typeof payload.accountId !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.avatarColor !== 'string'
  ) {
    return undefined;
  }
  return { accountId: payload.accountId, username: payload.username, avatarColor: payload.avatarColor };
}
