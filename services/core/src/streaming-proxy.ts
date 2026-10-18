import type { App, Ctx } from './http/app-env.js';
import { originalUrl, sendJson } from './http/respond.js';

/** Préfixe côté navigateur : /_ss/<chemin>?<requête> est relayé vers <serveur de streaming>/<chemin>?<requête>. */
export const STREAM_PROXY_PREFIX = '/_ss';
/** Délai maximum pour recevoir les en-têtes de la réponse amont. Le corps d'un flux long n'a pas de délai global. */
const HEADERS_TIMEOUT_MS = 60_000;
/** En-têtes de la requête transmis en amont. Jamais de cookie, d'Authorization ni d'en-tête de profil. */
const FORWARDED_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept'] as const;
/** En-têtes de la réponse relayés. Les en-têtes CORS et de connexion de l'amont ne le sont pas. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
] as const;

/**
 * URL amont d'une requête relayée : même origine que `base`, chemin et requête repris après le préfixe. Une cible
 * qui sortirait de l'origine (ex. chemin commençant par //) lève une erreur.
 */
export function upstreamUrl(base: URL, originalUrl: string): URL {
  const rest = originalUrl.slice(STREAM_PROXY_PREFIX.length);
  const queryAt = rest.indexOf('?');
  const path = (queryAt === -1 ? rest : rest.slice(0, queryAt)) || '/';
  const url = new URL(base.origin);
  url.pathname = path;
  url.search = queryAt === -1 ? '' : rest.slice(queryAt);
  if (url.origin !== base.origin) throw new Error('cible hors du serveur de streaming');
  return url;
}

function sendUnavailable(c: Ctx): Response {
  c.header('Cache-Control', 'no-store');
  return sendJson(c, { error: 'streaming_server_unavailable' }, 502);
}

/** Relaie une requête GET ou HEAD : en-têtes de lecture (Range, 206) et corps en flux, sans tampon. */
async function relay(base: URL, c: Ctx): Promise<Response> {
  const upstream = upstreamUrl(base, originalUrl(c));
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers.set(name, value);
  }

  // Le client qui part interrompt la requête amont (et donc le flux), y compris pendant la lecture du corps.
  const controller = new AbortController();
  const clientSignal = c.req.raw.signal;
  const onClientGone = (): void => controller.abort();
  if (clientSignal.aborted) controller.abort();
  else clientSignal.addEventListener('abort', onClientGone, { once: true });

  const headersTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, { method: c.req.method, headers, redirect: 'manual', signal: controller.signal });
  } catch {
    clearTimeout(headersTimer);
    clientSignal.removeEventListener('abort', onClientGone);
    return sendUnavailable(c);
  }
  clearTimeout(headersTimer);

  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamRes.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  if (upstreamRes.body === null || c.req.method === 'HEAD') {
    clientSignal.removeEventListener('abort', onClientGone);
    await upstreamRes.body?.cancel().catch(() => undefined);
    return new Response(null, { status: upstreamRes.status, headers: out });
  }
  // Le corps est relayé tel quel : l'annulation côté client (fermeture de la connexion) coupe aussi la connexion amont.
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out });
}

/**
 * Relais same-origin /_ss/* vers le serveur de streaming local (le serveur Stremio n'envoie du CORS qu'aux domaines
 * strem.io). Méthodes GET et HEAD seulement. À monter avant les routes statiques de l'interface.
 */
export function registerStreamingProxy(app: App, target: string): void {
  const base = new URL(target);
  const handler = async (c: Ctx): Promise<Response> => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      c.header('Allow', 'GET, HEAD');
      return c.body(null, 405);
    }
    try {
      return await relay(base, c);
    } catch {
      return sendUnavailable(c);
    }
  };
  app.all(STREAM_PROXY_PREFIX, handler);
  app.all(`${STREAM_PROXY_PREFIX}/*`, handler);
}
