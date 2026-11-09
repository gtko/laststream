// Adresse publique fixe de Laststream : relaie toutes les routes vers le Worker « lastaddon-core » (Service Binding CORE).
// Si core est injoignable, la page d'attente (503) est servie. Hors rapports Sentry, le Worker ne contacte que core.
// Exceptions non gérées : journal et Sentry (egress-guard.js). Le Worker n'appelle aucun débrideur.

import { reportUnhandledError } from './egress-guard.js';

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

/** Identifiant de requête pour les journaux : cf-ray (tronqué) ou UUID aléatoire. */
const requestIdOf = (request) => (request.headers.get('cf-ray') ?? '').slice(0, 64) || crypto.randomUUID();

function upstreamHeaders(request, publicHost, env) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length') continue;
    if (lower.startsWith('cf-') || lower.startsWith('x-forwarded-') || lower.startsWith('x-laststream-')) continue;
    if (lower === 'x-real-ip' || lower === 'forwarded') continue;
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

/**
 * Envoie la requête à core via `send`, avec réessais : erreurs réseau, puis 502/503/504 si la requête est idempotente.
 * Renvoie { response } (réponse à restituer, 5xx réel compris) ou { response: null, detail } si core n'a pas répondu.
 */
async function forward(send, { retries, idempotent, env }) {
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
    if (!TRANSIENT_STATUS.has(upstream.status) || !idempotent || attempt === retries) return { response: upstream };
    await upstream.body?.cancel();
  }
  return { response: null, detail };
}

async function relay(request, env) {
  const url = new URL(request.url);
  if (isBlockedPath(url.pathname)) {
    return json(403, { error: 'forbidden_path', message: 'Le relais TV HLS ne passe pas par ce domaine.' });
  }

  const headers = upstreamHeaders(request, url.host, env);

  // Watch party et direct social : la connexion WebSocket passe telle quelle vers lastaddon-core (pas de réessai).
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
  // réessai (le flux est consommé par le premier envoi).
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

  // lastaddon-core (Worker, Service Binding) : toutes les routes. Sa réponse est restituée telle quelle, 5xx réel compris.
  const core =
    env.CORE === undefined
      ? { response: null, detail: 'liaison CORE absente' }
      : await forward(() => env.CORE.fetch(new Request(request.url, { method: request.method, headers, body, redirect: 'manual' })), {
          retries,
          idempotent,
          env,
        });
  if (core.response !== null) return passthrough(core.response);

  // core injoignable : page d'attente pour un navigateur, JSON 503 sinon.
  return unavailable(request, { error: 'upstream_unreachable', message: 'Le serveur est injoignable pour le moment.', detail: core.detail }, '15');
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
  // Flux de version Android (publié par le workflow Release) : réécrit à chaque release, donc cache court. Absent de R2 :
  // la requête suit le relais habituel (ancien latest.json servi avec l'application web).
  if (pathname === '/app/android/latest.json') {
    return { key: 'android/latest.json', type: 'application/json', cache: 'public, max-age=300', fallback: true };
  }
  // Flux de version Windows (voir laststream-shell-ng/upload.ps1) : réécrit à chaque release, donc cache court.
  if (pathname === '/app/windows/latest.json') {
    return { key: 'windows/latest.json', type: 'application/json', cache: 'public, max-age=300' };
  }
  // Signature ed25519 du flux : l'updater natif la télécharge à côté de latest.json et refuse la mise à jour sans elle.
  if (pathname === '/app/windows/latest.json.sig') {
    return { key: 'windows/latest.json.sig', type: 'text/plain; charset=utf-8', cache: 'public, max-age=300' };
  }
  return null;
}

/** Exception non gérée : journal et envoi Sentry (si SENTRY_DSN), puis 500 JSON sans détail. */
function internalError(error, request, env, ctx) {
  reportUnhandledError(error, env, ctx, requestIdOf(request));
  return json(500, { error: 'internal' });
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  // Fichiers d'application (trop gros pour les Workers Assets) : servis depuis R2, nom strict, en lecture seule.
  const file = env.APP_FILES && appFile(pathname);
  if (file) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });
    const obj = await env.APP_FILES.get(file.key, { range: request.headers });
    if (!obj) return file.fallback ? relay(request, env) : json(404, { error: 'not_found' });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('content-type', file.type);
    if (file.attachment) headers.set('content-disposition', `attachment; filename="${file.name}"`);
    headers.set('etag', obj.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', file.cache ?? 'public, max-age=86400, immutable');
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
  if (pathname.startsWith('/__laststream/')) return json(404, { error: 'not_found' });
  return relay(request, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (error) {
      return internalError(error, request, env, ctx);
    }
  },
};
