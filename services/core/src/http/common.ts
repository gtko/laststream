import { createHash } from 'node:crypto';
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import type { AppEnv } from './app-env.js';
import { sendJson } from './respond.js';

/** Types de contenu dont l'ETag est calculé (réponses construites en mémoire, comme `res.send` d'Express). */
const ETAG_TYPES = /^(application\/json|text\/|application\/vnd\.apple\.mpegurl)/i;

function weakTag(value: string): string {
  return value.trim().replace(/^W\//, '');
}

function conditionMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => weakTag(candidate) === weakTag(etag));
}

/**
 * ETag faible sur les réponses GET/HEAD 200 construites en mémoire (JSON, texte), et 304 si le client le
 * présente (If-None-Match) : même contrat qu'Express. Les flux et les fichiers statiques ne sont pas touchés.
 */
export function etag(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return;
    const res = c.res;
    if (res.status !== 200 || res.body === null || res.headers.has('ETag')) return;
    if (!ETAG_TYPES.test(res.headers.get('content-type') ?? '')) return;
    if (c.req.path.startsWith('/_ss')) return;
    const data = new Uint8Array(await res.clone().arrayBuffer());
    const tag = `W/"${data.length.toString(16)}-${createHash('sha1').update(data).digest('base64').slice(0, 27)}"`;
    const headers = new Headers(res.headers);
    headers.set('ETag', tag);
    const ifNoneMatch = c.req.header('if-none-match');
    const noCache = /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(c.req.header('cache-control') ?? '');
    if (ifNoneMatch !== undefined && !noCache && conditionMatches(ifNoneMatch, tag)) {
      headers.delete('Content-Type');
      headers.delete('Content-Length');
      headers.delete('Transfer-Encoding');
      c.res = new Response(null, { status: 304, headers });
      return;
    }
    c.res = new Response(res.body, { status: res.status, headers });
  };
}

/** Erreur 4xx du parseur de corps (400, 413, 415…) ou erreur interne : réponse générique, sans contenu. */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  c.header('Cache-Control', 'no-store');
  const status = typeof err === 'object' && err !== null && 'status' in err ? (err as { status: unknown }).status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return sendJson(c, { error: 'bad_request' }, status as 400);
  }
  c.set('failure', err instanceof Error ? `${err.name}: ${err.message}` : 'erreur inconnue');
  console.error('Erreur interne', err instanceof Error ? err.name : 'inconnue');
  return sendJson(c, { error: 'internal_error' }, 500);
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 404 des routes inconnues : même page minimale que le gestionnaire par défaut d'Express. */
export const notFound: NotFoundHandler<AppEnv> = (c) => {
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot ${escapeHtml(c.req.method)} ${escapeHtml(new URL(c.req.url).pathname)}</pre>
</body>
</html>
`;
  return c.body(body, 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
};
