import { allowedOrigins } from '../config/runtime-env.js';
import { verifyLiveTicketClaims } from '../party/ticket.js';
import { type SharedLimits, sharedLimiterFor } from '../rate-limit-shared.js';
import { SOCIAL_LIVE_EXP_HEADER, SOCIAL_LIVE_NONCE_HEADER, SOCIAL_LIVE_PATH, SOCIAL_LIVE_PID_HEADER } from './social-v2-live.js';

/**
 * Porte du flux temps réel social (`GET /user/social/live?ticket=…`), traitée par le Worker avant l'application Hono (une
 * réponse 101 ne traverse aucun middleware). Le ticket (POST /user/social/live-ticket, 60 s, lié au profil) est vérifié
 * ici, puis la mise à niveau est transmise au Durable Object des données avec le pid vérifié dans un en-tête interne :
 * le client ne peut pas le forger, l'en-tête est toujours écrasé ici. Refus : 401 `invalid_ticket` (le navigateur ne voit
 * alors qu'un échec de mise à niveau et retombe sur le polling).
 */

/** Mises à niveau par minute et par IP (au-delà : 429). */
const UPGRADES_PER_MINUTE = 30;
const upgrades = sharedLimiterFor('socialUpgrade', UPGRADES_PER_MINUTE, 60_000);
/** Mises à niveau par minute et par profil, quelle que soit l'IP. */
const profileUpgrades = sharedLimiterFor('socialUpgrade', UPGRADES_PER_MINUTE, 60_000);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const rateLimited = (retryAfterSec: number): Response =>
  new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(retryAfterSec) },
  });

export async function handleSocialLiveWs(
  request: Request,
  options: { secret: string; ip: string | undefined; forward: (forwarded: Request) => Promise<Response>; now?: number; shared?: SharedLimits },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== SOCIAL_LIVE_PATH) return json(404, { error: 'not_found' });
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' });
  const origin = request.headers.get('origin');
  if (origin !== null && !allowedOrigins().includes(origin) && origin !== url.origin) return json(403, { error: 'origin_forbidden' });
  const byIp = await upgrades(options.shared, `ip:${options.ip ?? 'inconnu'}`);
  if (!byIp.allowed) return rateLimited(byIp.retryAfterSec);
  const identity = verifyLiveTicketClaims(url.searchParams.get('ticket') ?? '', options.now ?? Date.now(), options.secret);
  if (identity === undefined) return json(401, { error: 'invalid_ticket' });
  const byProfile = await profileUpgrades(options.shared, `pid:${identity.pid}`);
  if (!byProfile.allowed) return rateLimited(byProfile.retryAfterSec);
  const headers = new Headers(request.headers);
  headers.set(SOCIAL_LIVE_PID_HEADER, identity.pid);
  // Usage unique : le Durable Object consomme le nonce (voir social-v2-live-tickets.ts). Toujours écrasés ici.
  headers.set(SOCIAL_LIVE_NONCE_HEADER, identity.nonce);
  headers.set(SOCIAL_LIVE_EXP_HEADER, String(identity.exp));
  // Le ticket n'a pas à atteindre le Durable Object.
  const forwarded = new URL(url);
  forwarded.search = '';
  return await options.forward(new Request(forwarded.toString(), { method: 'GET', headers }));
}
