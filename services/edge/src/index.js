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

async function relay(request, env) {
  const url = new URL(request.url);
  if (isBlockedPath(url.pathname)) {
    return json(403, { error: 'forbidden_path', message: 'Le relais TV HLS ne passe pas par ce domaine.' });
  }

  const stored = await env.LASTSTREAM_ROUTE.get(ROUTE_KEY, 'json');
  const origin = parseTunnelUrl(stored?.url);
  if (origin === null) {
    return json(503, { error: 'no_tunnel', message: 'Aucun tunnel enregistré : le serveur est hors ligne.' }, { 'retry-after': '30' });
  }

  const target = `${origin}${url.pathname}${url.search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const unreachable = (detail) =>
    json(503, { error: 'tunnel_unreachable', message: 'Le serveur est injoignable pour le moment.', detail }, { 'retry-after': '15' });
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request, url.host, env),
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });
  } catch (error) {
    return unreachable(String(error?.message ?? error).slice(0, 120));
  }
  // Erreurs de Cloudflare quand le tunnel n'existe plus (530 / 1033) : message clair plutôt qu'une page HTML.
  if (upstream.status === 530 || upstream.status === 1033) return unreachable(`statut amont ${upstream.status}`);
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === REGISTER_PATH) return register(request, env);
    if (pathname.startsWith('/__laststream/')) return json(404, { error: 'not_found' });
    return relay(request, env);
  },
};
