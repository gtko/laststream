// Adresse publique fixe de Laststream : relaie toutes les routes vers le Worker « lastaddon-core » (Service Binding CORE).
// Repli optionnel vers le lastAddon du PC par un tunnel rapide cloudflared (dont l'URL change), uniquement si core renvoie 5xx
// et qu'un tunnel est enregistré (POST /__laststream/register, secret partagé, KV LASTSTREAM_ROUTE). Désactivable : TUNNEL_FALLBACK=0.

import { handleRange, RANGE_PATH } from './range.js';

const ROUTE_KEY = 'tunnel';
const REGISTER_PATH = '/__laststream/register';
const MAX_REGISTER_BYTES = 1024;
const TUNNEL_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.trycloudflare\.com$/;

// Le relais TV HLS de lastAddon (/:config/lt/tv/hls) ne doit pas faire transiter la vidéo par Cloudflare.
const BLOCKED_PATH = /(^|\/)lt\/tv\/hls(\/|$)/;

// Seuls ces chemins acceptent une connexion WebSocket relayée vers lastaddon-core : salons de watch party et direct social.
const WEBSOCKET_PARTY_PATH = /^\/party\/[^/]+\/ws$/;
const WEBSOCKET_EXACT_PATHS = new Set(['/user/social/live']);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection',
]);

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

/** Chemin normalisé pour le contrôle d'accès : décodé, en minuscules, sans doubles barres ni segments « . ». */
export function normalizePath(pathname) {
  let decoded = pathname;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  const segments = [];
  for (const part of decoded.toLowerCase().replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`;
}

export function isBlockedPath(pathname) {
  const normalized = normalizePath(pathname);
  return normalized === null || BLOCKED_PATH.test(normalized);
}

/** Origine d'un tunnel rapide valide (https://xxx.trycloudflare.com, sans identifiants, port, chemin), sinon null. */
export function parseTunnelUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!TUNNEL_HOST.test(url.hostname)) return null;
  return url.origin;
}

/** Comparaison en temps constant : empreintes SHA-256 de longueur fixe, puis comparaison sans court-circuit. */
export async function secretsMatch(given, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given ?? '')),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function register(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  if (!(await secretsMatch(request.headers.get('x-register-secret'), env.REGISTER_SECRET))) {
    return json(401, { error: 'unauthorized' });
  }
  const text = await request.text();
  if (text.length > MAX_REGISTER_BYTES) return json(413, { error: 'payload_too_large' });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const origin = parseTunnelUrl(body?.url);
  if (origin === null) return json(400, { error: 'invalid_tunnel_url' });
  await env.LASTSTREAM_ROUTE.put(ROUTE_KEY, JSON.stringify({ url: origin, registeredAt: new Date().toISOString() }));
  return json(200, { ok: true });
}

function upstreamHeaders(request, publicHost, env) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length') continue;
    if (lower.startsWith('cf-') || lower.startsWith('x-forwarded-') || lower.startsWith('x-laststream-')) continue;
    if (lower === 'x-real-ip' || lower === 'forwarded' || lower === 'x-register-secret') continue;
    headers.set(name, value);
  }
  // Le lastAddon ne croit ces en-têtes que si le secret du relais est valide (LASTADDON_EDGE_SECRET).
  if (env.EDGE_SECRET) headers.set('x-laststream-edge', env.EDGE_SECRET);
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-laststream-client-ip', clientIp);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', publicHost);
  return headers;
}

const TRANSIENT_STATUS = new Set([502, 503, 504, 530, 1033]);
// Tunnel absent côté Cloudflare : rien n'a atteint le serveur, le corps peut être renvoyé sans risque.
const TUNNEL_DOWN_STATUS = new Set([530, 1033]);
const NO_STATUS = new Set();
const MAX_BUFFERED_BODY = 1024 * 1024;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryDelay = (env) => (env.RETRY_DELAY_MS !== undefined ? Number(env.RETRY_DELAY_MS) : 200 + Math.random() * 300);

const RESTART_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Laststream redémarre</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;font:16px system-ui,sans-serif;text-align:center;padding:16px}
h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;color:#9aa0a6}</style></head>
<body><main><h1>Laststream redémarre…</h1><p>Nouvel essai automatique dans quelques secondes.</p></main>
<script>setTimeout(function(){location.reload()},5000)</script></body></html>`;

/** Erreur 503 : page HTML FR à rechargement automatique pour un navigateur, JSON pour les appels API. */
function unavailable(request, body, retryAfter) {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    return new Response(RESTART_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfter },
    });
  }
  return json(503, body, { 'retry-after': retryAfter });
}

function passthrough(upstream) {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Repli vers le tunnel du PC : actif sauf si la variable TUNNEL_FALLBACK vaut « 0 » (ou « off », « false »). */
export function fallbackEnabled(env) {
  return !['0', 'off', 'false'].includes(String(env.TUNNEL_FALLBACK ?? '1').toLowerCase());
}

/**
 * Envoie la requête via `send` avec réessais. Renvoie { response } (réponse à restituer, éventuellement 5xx réel) ou
 * { response: null, detail } quand rien d'exploitable n'est revenu (erreurs réseau, cible absente).
 */
async function forward(send, { retries, idempotent, downStatus, env }) {
  let detail = 'inconnu';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelay(env));
    let upstream;
    try {
      upstream = await send();
    } catch (error) {
      detail = String(error?.message ?? error).slice(0, 120);
      continue;
    }
    if (!TRANSIENT_STATUS.has(upstream.status)) return { response: upstream };
    detail = `statut amont ${upstream.status}`;
    const down = downStatus.has(upstream.status);
    // Avec corps, seule une cible absente (rien n'a atteint le serveur) autorise un nouvel essai.
    if (attempt < retries && (idempotent || down)) {
      await upstream.body?.cancel();
      continue;
    }
    // Un 502/503/504 réel du serveur est restitué tel quel ; seule une cible absente est masquée.
    if (!down) return { response: upstream };
    break;
  }
  return { response: null, detail };
}

async function relay(request, env) {
  const url = new URL(request.url);
  if (isBlockedPath(url.pathname)) {
    return json(403, { error: 'forbidden_path', message: 'Le relais TV HLS ne passe pas par ce domaine.' });
  }

  const headers = upstreamHeaders(request, url.host, env);

  // Watch party et direct social : la connexion WebSocket passe telle quelle vers lastaddon-core (pas de réessai ni de repli).
  if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
    const allowed = WEBSOCKET_PARTY_PATH.test(url.pathname) || WEBSOCKET_EXACT_PATHS.has(url.pathname);
    if (!allowed || env.CORE === undefined) {
      return json(426, { error: 'upgrade_required', message: 'WebSocket réservé aux salons de watch party et au direct social.' });
    }
    headers.set('upgrade', 'websocket');
    return env.CORE.fetch(new Request(request.url, { method: 'GET', headers }));
  }

  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD';
  const idempotent = !hasBody;

  // GET/HEAD/corps vide : 2 réessais. Corps non vide : tamponné s'il est petit pour pouvoir être renvoyé, 1 réessai ; sinon aucun
  // réessai et aucun repli (le flux est consommé par le premier envoi).
  let body;
  let retries = MAX_RETRIES;
  let replayable = true;
  if (hasBody) {
    retries = 0;
    replayable = false;
    body = request.body;
    const length = Number(request.headers.get('content-length'));
    if (request.headers.has('content-length') && Number.isFinite(length) && length <= MAX_BUFFERED_BODY) {
      body = await request.arrayBuffer();
      retries = 1;
      replayable = true;
    }
  }

  // 1. lastaddon-core (Worker, Service Binding) : toutes les routes.
  const core =
    env.CORE === undefined
      ? { response: null, detail: 'liaison CORE absente' }
      : await forward(() => env.CORE.fetch(new Request(request.url, { method: request.method, headers, body, redirect: 'manual' })), {
          retries,
          idempotent,
          downStatus: NO_STATUS,
          env,
        });
  if (core.response !== null && core.response.status < 500) return passthrough(core.response);

  // 2. Repli vers le tunnel du PC, uniquement si core renvoie 5xx (ou échoue) ET qu'un tunnel est enregistré.
  let detail = core.detail ?? `statut core ${core.response?.status}`;
  if (replayable && fallbackEnabled(env)) {
    // Relu à chaque requête (cacheTtl minimal du KV) : aucune URL conservée dans l'isolate.
    const stored = await env.LASTSTREAM_ROUTE.get(ROUTE_KEY, { type: 'json', cacheTtl: 30 });
    const origin = parseTunnelUrl(stored?.url);
    if (origin !== null) {
      const target = `${origin}${url.pathname}${url.search}`;
      const tunnel = await forward(() => fetch(target, { method: request.method, headers, body, redirect: 'manual' }), {
        retries,
        idempotent,
        downStatus: TUNNEL_DOWN_STATUS,
        env,
      });
      if (tunnel.response !== null && (tunnel.response.status < 500 || core.response === null)) {
        await core.response?.body?.cancel();
        return passthrough(tunnel.response);
      }
      await tunnel.response?.body?.cancel();
      detail = `${detail} ; tunnel : ${tunnel.detail ?? `statut ${tunnel.response?.status}`}`;
    }
  }

  // 3. Rien d'exploitable : le 5xx réel de core est restitué, sinon page d'attente / JSON 503.
  if (core.response !== null) return passthrough(core.response);
  return unavailable(request, { error: 'upstream_unreachable', message: 'Le serveur est injoignable pour le moment.', detail }, '15');
}

/** Fichiers publiés dans R2 : chemin public strict -> clé, type, nom de téléchargement. */
function appFile(pathname) {
  const name = pathname.split('/').pop();
  if (/^\/app\/android\/laststream-\d{10}\.apk$/.test(pathname)) {
    return { key: 'android/' + name, type: 'application/vnd.android.package-archive' };
  }
  if (/^\/app\/windows\/Laststream-Setup-\d+\.\d+\.\d+\.exe$/.test(pathname)) {
    return { key: 'windows/' + name, type: 'application/vnd.microsoft.portable-executable', attachment: true, name };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === REGISTER_PATH) return register(request, env);
    // Coupé : lire les fichiers AllDebrid depuis des IP Cloudflare a fait suspendre le compte. Réactivable par RANGE_ENABLED=1.
    // Fichiers d'application (trop gros pour les Workers Assets) : servis depuis R2, nom strict, en lecture seule.
    const file = env.APP_FILES && appFile(pathname);
    if (file) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });
      const obj = await env.APP_FILES.get(file.key, { range: request.headers });
      if (!obj) return json(404, { error: 'not_found' });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('content-type', file.type);
      if (file.attachment) headers.set('content-disposition', `attachment; filename="${file.name}"`);
      headers.set('etag', obj.httpEtag);
      headers.set('accept-ranges', 'bytes');
      headers.set('cache-control', 'public, max-age=86400, immutable');
      if (obj.range && request.headers.has('range')) {
        const r = obj.range;
        const start = 'offset' in r ? r.offset : obj.size - r.suffix;
        const len = 'length' in r && r.length !== undefined ? r.length : obj.size - start;
        headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
        return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers });
      }
      headers.set('content-length', String(obj.size));
      return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
    }
    if (pathname === RANGE_PATH) {
      if (env.RANGE_ENABLED !== '1') return json(410, { error: 'range_disabled', message: 'Relais de miniatures désactivé.' });
      return handleRange(request, env);
    }
    if (pathname.startsWith('/__laststream/')) return json(404, { error: 'not_found' });
    return relay(request, env);
  },
};
