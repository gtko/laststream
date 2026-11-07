import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Ctx } from './app-env.js';

/** Réponse JSON, au format historique d'Express (`application/json; charset=utf-8`). */
export function sendJson(c: Ctx, body: unknown, status: ContentfulStatusCode = 200): Response {
  return c.body(JSON.stringify(body), status, { 'Content-Type': 'application/json; charset=utf-8' });
}

/** Réponse sans corps. */
export function sendEmpty(c: Ctx, status: 204 | 302 = 204): Response {
  return c.body(null, status);
}

/** Réponse binaire ou texte avec son type. */
export function sendBody(c: Ctx, body: string | Uint8Array, status: ContentfulStatusCode, contentType: string): Response {
  const data = typeof body === 'string' ? body : new Uint8Array(body);
  return c.body(data as string & Uint8Array, status, { 'Content-Type': contentType });
}

/** Valeur de chaque paramètre de requête ; une clé répétée donne un tableau (comme le parseur « simple » d'Express). */
export function queryParams(c: Ctx): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else out[key] = [previous, value];
  }
  return out;
}

/** Chemin et requête bruts de la requête (équivalent d'`originalUrl`). */
export function originalUrl(c: Ctx): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}
