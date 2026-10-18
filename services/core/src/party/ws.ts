import { allowedOrigins } from '../config/runtime-env.js';
import { createRateLimiter } from '../rate-limit.js';
import { IDENTITY_HEADER, type PartyBackend } from './backend.js';
import { verifyTicket } from './ticket.js';

/** Identifiant de salon accepté dans l'URL (base64url, 16 à 32 caractères). */
export const ROOM_ID = /^[A-Za-z0-9_-]{16,32}$/;
/** Chemin de la mise à niveau WebSocket : /party/<id>/ws. */
export const PARTY_WS_PATH = /^\/party\/([A-Za-z0-9_-]{16,32})\/ws$/;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const limiter = createRateLimiter(60, 60_000);

/**
 * Connexion WebSocket d'un salon : GET /party/<id>/ws?ticket=<ticket de POST /party/<id>/join>. Traitée avant
 * l'application Hono (une réponse 101 ne doit passer par aucun middleware). Vérifie l'origine, le ticket (HMAC, 60 s,
 * lié au salon), puis transmet la mise à niveau au Durable Object avec l'identité vérifiée dans un en-tête interne : le
 * client ne peut pas forger cet en-tête, il est toujours écrasé ici.
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
  const identity = verifyTicket(url.searchParams.get('ticket') ?? '', roomId, options.now ?? Date.now(), options.secret);
  if (identity === undefined) return json(401, { error: 'invalid_ticket' });
  const headers = new Headers(request.headers);
  headers.set(IDENTITY_HEADER, Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url'));
  // Le ticket n'a pas à atteindre le Durable Object.
  const forwarded = new URL(url);
  forwarded.searchParams.delete('ticket');
  return options.party.room(roomId).fetch(new Request(forwarded.toString(), { method: 'GET', headers }));
}
