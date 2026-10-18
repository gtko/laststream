// Relais de plages d'octets pour les miniatures de la barre de progression :
//   GET /__laststream/range?u=<url https>&s=<début>&e=<fin incluse>&t=<jeton>
// Les liens débridés n'envoient pas de CORS : le navigateur ne peut pas lire une plage directement. Ce relais la lit à sa
// place (4 Mo au plus), avec CORS pour les origines de l'application. Il ne relaie que :
//   - des URL https de domaines autorisés (RANGE_HOSTS, par défaut *.debrid.it et *.alldebrid.com) ;
//   - sur présentation d'un jeton HMAC émis par lastAddon (secret RANGE_SECRET), lié à l'URL exacte, valable 6 h.

export const RANGE_PATH = '/__laststream/range';
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;
const MAX_REDIRECTS = 2;
const MAX_TOKEN_TTL_S = 7 * 3600;

const DEFAULT_HOSTS = '*.debrid.it,*.alldebrid.com';
const DEFAULT_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://192.168.1.143:8080',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'https://laststream.gtux-prog.workers.dev',
].join(',');

const encoder = new TextEncoder();

const list = (value, fallback) =>
  (typeof value === 'string' && value.trim() !== '' ? value : fallback)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** Domaine autorisé : `*.exemple.com` couvre les sous-domaines (jamais le domaine nu), un nom sans joker est exact. */
export function hostAllowed(hostname, patterns) {
  const host = hostname.toLowerCase();
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || /^[0-9.]+$/.test(host)) return false;
  return patterns.some((p) => (p.startsWith('*.') ? host.length > p.length - 1 && host.endsWith(p.slice(1)) : host === p));
}

/** URL https autorisée (sans identifiants ni port autre que 443), sinon null. */
export function parseRangeTarget(raw, env = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return null;
  return hostAllowed(url.hostname, list(env.RANGE_HOSTS, DEFAULT_HOSTS)) ? url : null;
}

function base64urlToBytes(text) {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '=');
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Jeton `<exp>.<signature>` : HMAC-SHA256(secret, "range1\n<exp>\n<url>"), même calcul que lastAddon (range-token.ts). */
export async function verifyRangeToken(secret, url, token, nowMs = Date.now()) {
  if (typeof secret !== 'string' || secret.length === 0 || typeof token !== 'string') return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (m === null) return false;
  const exp = Number(m[1]);
  const now = Math.floor(nowMs / 1000);
  if (exp < now || exp > now + MAX_TOKEN_TTL_S) return false;
  const sig = base64urlToBytes(m[2]);
  if (sig === null) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, encoder.encode(`range1\n${exp}\n${url}`));
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function reply(status, body, cors, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...extra },
  });
}

function parseOffset(value) {
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

export async function handleRange(request, env) {
  const origin = request.headers.get('origin');
  const allowedOrigins = list(env.RANGE_ORIGINS, DEFAULT_ORIGINS);
  // Une requête de navigateur porte toujours Origin : hors liste, refus net. Sans Origin (outil serveur), le jeton reste exigé.
  if (origin !== null && !allowedOrigins.includes(origin.toLowerCase())) return reply(403, { error: 'origin_not_allowed' }, {});
  const cors = origin === null ? {} : corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, cors, { allow: 'GET, OPTIONS' });
  if (typeof env.RANGE_SECRET !== 'string' || env.RANGE_SECRET === '') return reply(503, { error: 'range_disabled' }, cors);

  const params = new URL(request.url).searchParams;
  const rawUrl = params.get('u');
  const token = params.get('t');
  if (token === null || token === '' || rawUrl === null) return reply(401, { error: 'token_required' }, cors);
  const target = parseRangeTarget(rawUrl, env);
  if (target === null) return reply(403, { error: 'host_not_allowed' }, cors);
  if (!(await verifyRangeToken(env.RANGE_SECRET, rawUrl, token))) return reply(401, { error: 'invalid_token' }, cors);

  const start = parseOffset(params.get('s'));
  const end = parseOffset(params.get('e'));
  if (start === null || end === null || end < start) return reply(400, { error: 'invalid_range' }, cors);
  if (end - start + 1 > MAX_RANGE_BYTES) return reply(413, { error: 'range_too_large', max: MAX_RANGE_BYTES }, cors);

  const hosts = list(env.RANGE_HOSTS, DEFAULT_HOSTS);
  let current = target;
  let upstream;
  for (let hop = 0; ; hop += 1) {
    try {
      upstream = await fetch(current.href, { headers: { range: `bytes=${start}-${end}` }, redirect: 'manual' });
    } catch {
      return reply(502, { error: 'upstream_unreachable' }, cors);
    }
    if (upstream.status < 300 || upstream.status >= 400) break;
    // Redirection : suivie seulement vers un autre domaine autorisé (pas de sortie de la liste blanche).
    const location = upstream.headers.get('location');
    await upstream.body?.cancel();
    let next = null;
    try {
      next = location === null ? null : new URL(location, current);
    } catch {
      next = null;
    }
    if (next === null || hop >= MAX_REDIRECTS || next.protocol !== 'https:' || next.username !== '' || next.password !== '' ||
      (next.port !== '' && next.port !== '443') || !hostAllowed(next.hostname, hosts)) {
      return reply(502, { error: 'bad_redirect' }, cors);
    }
    current = next;
  }

  if (upstream.status === 416) {
    await upstream.body?.cancel();
    return reply(416, { error: 'range_not_satisfiable' }, cors, { 'content-range': upstream.headers.get('content-range') ?? '' });
  }
  // 200 : l'amont ignore Range et enverrait tout le fichier (jusqu'à 80 Go) : on coupe aussitôt.
  if (upstream.status !== 206) {
    await upstream.body?.cancel();
    return reply(upstream.status === 200 ? 502 : upstream.status >= 500 ? 502 : upstream.status, { error: upstream.status === 200 ? 'range_unsupported' : 'upstream_error', status: upstream.status }, cors);
  }
  const length = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RANGE_BYTES) {
    await upstream.body?.cancel();
    return reply(502, { error: 'upstream_too_large' }, cors);
  }
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    ...cors,
  });
  for (const name of ['content-range', 'content-length']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 206, headers });
}
