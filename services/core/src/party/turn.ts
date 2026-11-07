import type { TurnCredentials } from './protocol.js';

/**
 * Relais TURN (Cloudflare Realtime TURN) de la watch party : identifiants éphémères (24 h) remis à chaque participant dans le
 * message `welcome` (champ `turn`), pour les liaisons WebRTC derrière un NAT strict. Les secrets TURN_KEY_ID et
 * TURN_KEY_API_TOKEN restent sur le Worker. Sans secrets, ou en cas d'échec, le salon reste en STUN seul : rien ne remonte.
 */

/** Liaisons lues par le Worker (voir WorkerEnv) : absentes ou vides, pas de TURN. */
export interface TurnEnv {
  TURN_KEY_ID?: unknown;
  TURN_KEY_API_TOKEN?: unknown;
}

export type TurnFetch = typeof fetch;

const TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
/** Durée de vie demandée à l'API (secondes) : 8 h, assez pour une séance ; courte car les invités sans compte les reçoivent aussi. */
const TTL_SEC = 28_800;
/** Délai maximal de l'appel à l'API (ms). */
const TIMEOUT_MS = 5_000;
/** Durée du cache en mémoire (ms) : nettement sous les 8 h de validité des identifiants. */
const CACHE_MS = 4 * 3_600_000;

/** Cache du module (un isolat) : identifiants valides, par identifiant de clé. Les échecs ne sont jamais mis en cache. */
let cached: { keyId: string; value: TurnCredentials; expires: number } | undefined;

function secret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Seules les URL TURN sans le port 53 (bloqué par les navigateurs) sont conservées. */
function usableUrl(url: string): boolean {
  if (!/^turns?:/i.test(url)) return false;
  const hostPort = url.split('?')[0] ?? '';
  return !/:53$/.test(hostPort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Première entrée de `iceServers` (tableau, ou objet d'anciennes réponses) qui porte des identifiants et une URL TURN exploitable. */
function pickCredentials(body: unknown): TurnCredentials | null {
  if (!isRecord(body)) return null;
  const servers: unknown[] = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  for (const server of servers) {
    if (!isRecord(server)) continue;
    const { username, credential } = server;
    if (typeof username !== 'string' || username === '' || typeof credential !== 'string' || credential === '') continue;
    const list: unknown[] = typeof server.urls === 'string' ? [server.urls] : Array.isArray(server.urls) ? server.urls : [];
    const urls = list.filter((url): url is string => typeof url === 'string' && usableUrl(url));
    if (urls.length > 0) return { urls, username, credential };
  }
  return null;
}

/**
 * Identifiants TURN pour un salon, ou null (secrets absents, erreur HTTP, réponse inexploitable, délai dépassé). Ne journalise
 * jamais le jeton ni le corps de la réponse : seulement le statut ou le nom de l'erreur.
 */
export async function fetchTurnIce(env: TurnEnv, fetchImpl: TurnFetch = fetch): Promise<TurnCredentials | null> {
  const keyId = secret(env.TURN_KEY_ID);
  const token = secret(env.TURN_KEY_API_TOKEN);
  if (keyId === undefined || token === undefined) return null;
  const now = Date.now();
  if (cached !== undefined && cached.keyId === keyId && cached.expires > now) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SEC }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[party][turn] identifiants indisponibles (statut amont : ${res.status})`);
      return null;
    }
    const value = pickCredentials(await res.json());
    if (value === null) {
      console.warn('[party][turn] réponse sans identifiant TURN exploitable');
      return null;
    }
    cached = { keyId, value, expires: now + CACHE_MS };
    return value;
  } catch (err) {
    console.warn(`[party][turn] identifiants indisponibles (${err instanceof Error ? err.name : 'inconnue'})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
