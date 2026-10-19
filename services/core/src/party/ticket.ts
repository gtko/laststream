import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Identity, TICKET_TTL_MS } from './protocol.js';
import { AVATAR_PATTERN } from '../user/avatar.js';

/**
 * Tickets de connexion WebSocket. Un navigateur ne peut pas poser d'en-tête Authorization sur une WebSocket et le jeton
 * de session ne doit pas finir dans une URL : POST /party/:id/join (authentifié) délivre ce ticket court (60 s), lié au
 * salon et au compte, passé en `?ticket=` à /party/:id/ws. Clé HMAC dérivée, séparée de celles des autres jetons.
 *
 * Deux finalités, chacune avec sa propre clé dérivée : le ticket de salon (ci-dessus) et le ticket du flux temps réel
 * social (lié au profil agissant, portée `social-live:<pid>`, voir user/social-v2-live-ws.ts). Un ticket d'une finalité
 * n'est jamais accepté par l'autre. La clé et le format des tickets de salon ne changent pas.
 */
const PURPOSE = 'lastaddon-party-ticket-v1';
/** Finalité du ticket du flux social : jamais valable pour un salon. */
const LIVE_PURPOSE = 'lastaddon-social-live-ticket-v1';
/** Longueur maximale d'un ticket examiné : au-delà, rejet sans calcul de HMAC. */
const MAX_TICKET_CHARS = 2048;

interface TicketPayload extends Identity {
  purpose: typeof PURPOSE;
  roomId: string;
  exp: number;
  nonce: string;
}

/** Clé HMAC dérivée du secret, propre à une finalité. */
const keyFor = (purpose: string, secret: string): Buffer => createHmac('sha256', secret).update(purpose).digest();

/** Enveloppe signée : `<charge utile base64url>.<signature HMAC base64url>`. */
function seal(purpose: string, payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', keyFor(purpose, secret)).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** Charge utile d'un ticket authentique de cette finalité, non expiré ; sinon `undefined`. */
function open(ticket: string, purpose: string, now: number, secret: string): Record<string, unknown> | undefined {
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot !== ticket.lastIndexOf('.') || ticket.length > MAX_TICKET_CHARS) return undefined;
  const body = ticket.slice(0, dot);
  const signature = Buffer.from(ticket.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', keyFor(purpose, secret)).update(body).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.purpose !== purpose || typeof record.exp !== 'number' || record.exp <= now) return undefined;
  return record;
}

export function signTicket(roomId: string, identity: Identity, now: number, secret: string): { ticket: string; expiresAt: string } {
  const payload: TicketPayload = { purpose: PURPOSE, roomId, ...identity, exp: now + TICKET_TTL_MS, nonce: randomBytes(8).toString('base64url') };
  return { ticket: seal(PURPOSE, payload, secret), expiresAt: new Date(payload.exp).toISOString() };
}

/** Identité portée par un ticket authentique, non expiré et émis pour ce salon ; sinon `undefined`. */
export function verifyTicket(ticket: string, roomId: string, now: number, secret: string): Identity | undefined {
  const payload = open(ticket, PURPOSE, now, secret);
  if (
    payload === undefined ||
    payload.roomId !== roomId ||
    typeof payload.accountId !== 'string' ||
    typeof payload.username !== 'string' ||
    typeof payload.avatarColor !== 'string'
  ) {
    return undefined;
  }
  const avatar = typeof payload.avatar === 'string' && AVATAR_PATTERN.test(payload.avatar) ? { avatar: payload.avatar } : {};
  return { accountId: payload.accountId, username: payload.username, avatarColor: payload.avatarColor, ...avatar };
}

/** Portée d'un ticket du flux social : le profil agissant, et lui seul. */
export function liveScope(pid: string): string {
  return `social-live:${pid}`;
}

/** Identité portée par un ticket du flux social : profil agissant et compte. */
export interface LiveIdentity {
  pid: string;
  accountId: string;
}

/** Ticket de 60 s pour ouvrir le flux temps réel d'un profil (POST /user/social/live-ticket). */
export function signLiveTicket(pid: string, accountId: string, now: number, secret: string): { ticket: string; expiresAt: string } {
  const exp = now + TICKET_TTL_MS;
  const payload = { purpose: LIVE_PURPOSE, scope: liveScope(pid), pid, accountId, exp, nonce: randomBytes(8).toString('base64url') };
  return { ticket: seal(LIVE_PURPOSE, payload, secret), expiresAt: new Date(exp).toISOString() };
}

/** Profil et compte d'un ticket du flux social authentique, non expiré et émis pour ce profil ; sinon `undefined`. */
export function verifyLiveTicket(ticket: string, now: number, secret: string): LiveIdentity | undefined {
  const payload = open(ticket, LIVE_PURPOSE, now, secret);
  if (
    payload === undefined ||
    typeof payload.pid !== 'string' ||
    typeof payload.accountId !== 'string' ||
    payload.scope !== liveScope(payload.pid)
  ) {
    return undefined;
  }
  return { pid: payload.pid, accountId: payload.accountId };
}
