import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';

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

function sendUnavailable(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(502).json({ error: 'streaming_server_unavailable' });
}

/** Relaie une requête GET ou HEAD : en-têtes de lecture (Range, 206) et corps en flux, sans tampon. */
async function relay(base: URL, req: Request, res: Response): Promise<void> {
  const upstream = upstreamUrl(base, req.originalUrl);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.get(name);
    if (value !== undefined) headers.set(name, value);
  }

  // Le client qui part interrompt la requête amont (et donc le flux), y compris pendant la lecture du corps.
  const controller = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort();
  });

  const headersTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(upstream, { method: req.method, headers, redirect: 'manual', signal: controller.signal });
  } catch {
    clearTimeout(headersTimer);
    if (!clientGone) sendUnavailable(res);
    return;
  }
  clearTimeout(headersTimer);

  res.status(upstreamRes.status);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamRes.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
  if (upstreamRes.body === null || req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    // pipeline détruit les deux côtés en cas d'erreur ou de fermeture, ce qui coupe aussi la connexion amont.
    await pipeline(Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream), res);
  } catch {
    // Flux amont interrompu ou client parti : rien à ajouter, la réponse est déjà fermée.
  }
}

/**
 * Relais same-origin /_ss/* vers le serveur de streaming local (le serveur Stremio n'envoie du CORS qu'aux domaines
 * strem.io). Méthodes GET et HEAD seulement. À monter avant les routes statiques de l'interface.
 */
export function registerStreamingProxy(app: Express, target: string): void {
  const base = new URL(target);
  app.use(STREAM_PROXY_PREFIX, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).end();
      return;
    }
    relay(base, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendUnavailable(res);
    });
  });
}
