import { allowedOrigins } from '../config/runtime-env.js';
import { createRateLimiter } from '../rate-limit.js';
import { IDENTITY_HEADER, type PartyBackend } from './backend.js';
import { cleanGuestName, guestIdentity, verifyGuestToken } from './guest.js';
import { CLOSE, type Identity } from './protocol.js';
import { refusedSocket } from './refuse.js';
import { verifyTicket } from './ticket.js';

/** Identifiant de salon accepté dans l'URL (base64url, 16 à 32 caractères). */
export const ROOM_ID = /^[A-Za-z0-9_-]{16,32}$/;
/** Chemin de la mise à niveau WebSocket : /party/<id>/ws. */
export const PARTY_WS_PATH = /^\/party\/([A-Za-z0-9_-]{16,32})\/ws$/;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const limiter = createRateLimiter(60, 60_000);

/**
 * Connexion WebSocket d'un salon. Deux formes, traitées avant l'application Hono (une réponse 101 ne doit passer par
 * aucun middleware) :
 * - compte : GET /party/<id>/ws?ticket=<ticket de POST /party/<id>/join> (ticket HMAC, 60 s, lié au salon) ;
 * - invité sans compte : GET /party/<id>/ws?t=<jeton de POST /party/<id>/invite>&name=<pseudo> (séance de 12 h, lié au salon).
 * Vérifie l'origine et le jeton, puis transmet la mise à niveau au Durable Object avec l'identité vérifiée dans un en-tête
 * interne : le client ne peut pas forger cet en-tête, il est toujours écrasé ici.
 */
export async function handlePartyWs(
  request: Request,
  options: { party: PartyBackend | undefined; secret: string; ip: string | undefined; now?: number },
): Promise<Response> {
  const url = new URL(request.url);
  const match = PARTY_WS_PATH.exec(url.pathname);
  if (match === null) return json(404, { error: 'not_found' });
  const roomId = match[1] ?? '';
  if (options.party === undefined) return json(501, { error: 'party_unavailable' });
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' });
  const origin = request.headers.get('origin');
  if (origin !== null && !allowedOrigins().includes(origin) && origin !== url.origin) return json(403, { error: 'origin_forbidden' });
  const verdict = limiter(options.ip ?? 'inconnu');
  if (!verdict.allowed) return json(429, { error: 'rate_limited' });
  const now = options.now ?? Date.now();
  let identity: Identity | undefined;
  const guestToken = url.searchParams.get('t');
  if (guestToken === null) {
    identity = verifyTicket(url.searchParams.get('ticket') ?? '', roomId, now, options.secret);
  } else {
    const verified = await verifyGuestToken(guestToken, roomId, now, options.secret);
    // Jeton expiré ou invalide : refus par fermeture WebSocket 4001 (le navigateur ne voit pas un code HTTP d'échec).
    if (verified === undefined) return refusedSocket(CLOSE.expired, 'expired');
    const name = cleanGuestName(url.searchParams.get('name'));
    if (name === undefined) return json(400, { error: 'invalid_name' });
    identity = guestIdentity(verified.guestId, name, verified.avatar);
  }
  if (identity === undefined) return json(401, { error: 'invalid_ticket' });
  const headers = new Headers(request.headers);
  headers.set(IDENTITY_HEADER, Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url'));
  // Ticket, jeton et pseudo n'ont pas à atteindre le Durable Object.
  const forwarded = new URL(url);
  forwarded.searchParams.delete('ticket');
  forwarded.searchParams.delete('t');
  forwarded.searchParams.delete('name');
  return options.party.room(roomId).fetch(new Request(forwarded.toString(), { method: 'GET', headers }));
}
