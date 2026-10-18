// Relais à adresse fixe vers le lastAddon de l'utilisateur, joignable par un tunnel rapide cloudflared dont l'URL change.
// L'URL courante du tunnel est enregistrée par le PC (POST /__laststream/register, secret partagé) dans le KV LASTSTREAM_ROUTE.

const ROUTE_KEY = 'tunnel';
const REGISTER_PATH = '/__laststream/register';
const MAX_REGISTER_BYTES = 1024;
const TUNNEL_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.trycloudflare\.com$/;

// Le relais TV HLS de lastAddon (/:config/lt/tv/hls) ne doit pas faire transiter la vidéo par Cloudflare.
const BLOCKED_PATH = /(^|\/)lt\/tv\/hls(\/|$)/;

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
const TUNNEL_DOWN_STATUS = new Set([530, 1033]);
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

async function relay(request, env) {
  const url = new URL(request.url);
  if (isBlockedPath(url.pathname)) {
    return json(403, { error: 'forbidden_path', message: 'Le relais TV HLS ne passe pas par ce domaine.' });
  }

  // Relu à chaque requête (cacheTtl minimal du KV) : aucune URL conservée dans l'isolate.
  const stored = await env.LASTSTREAM_ROUTE.get(ROUTE_KEY, { type: 'json', cacheTtl: 30 });
  const origin = parseTunnelUrl(stored?.url);
  if (origin === null) {
    return unavailable(request, { error: 'no_tunnel', message: 'Aucun tunnel enregistré : le serveur est hors ligne.' }, '30');
  }

  const target = `${origin}${url.pathname}${url.search}`;
  const headers = upstreamHeaders(request, url.host, env);
  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD';
  const idempotent = !hasBody;

  // GET/HEAD/corps vide : 2 réessais. Corps non vide : tamponné s'il est petit pour pouvoir être renvoyé, 1 réessai ; sinon aucun.
  let body;
  let retries = MAX_RETRIES;
  if (hasBody) {
    retries = 0;
    body = request.body;
    const length = Number(request.headers.get('content-length'));
    if (request.headers.has('content-length') && Number.isFinite(length) && length <= MAX_BUFFERED_BODY) {
      body = await request.arrayBuffer();
      retries = 1;
    }
  }

  let detail = 'inconnu';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelay(env));
    let upstream;
    try {
      upstream = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
    } catch (error) {
      detail = String(error?.message ?? error).slice(0, 120);
      continue;
    }
    if (!TRANSIENT_STATUS.has(upstream.status)) return passthrough(upstream);
    detail = `statut amont ${upstream.status}`;
    const down = TUNNEL_DOWN_STATUS.has(upstream.status);
    // Avec corps, seul 530/1033 (tunnel absent, rien n'a atteint le serveur) autorise un nouvel essai.
    const mayRetry = attempt < retries && (idempotent || down);
    if (mayRetry) {
      await upstream.body?.cancel();
      continue;
    }
    // Un 502/503/504 réel du serveur est restitué tel quel ; seul le tunnel absent est masqué.
    if (!down) return passthrough(upstream);
    break;
  }
  return unavailable(
    request,
    { error: 'tunnel_unreachable', message: 'Le serveur est injoignable pour le moment.', detail },
    '15',
  );
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === REGISTER_PATH) return register(request, env);
    if (pathname.startsWith('/__laststream/')) return json(404, { error: 'not_found' });
    return relay(request, env);
  },
};
