import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './app-env.js';

/** Erreur HTTP 4xx levée par un middleware : l'application la rend en réponse générique, sans contenu. */
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/** Taille maximale par défaut du corps JSON : 64 ko. */
export const DEFAULT_JSON_LIMIT = 64 * 1024;

function isJsonContentType(header: string | undefined): boolean {
  return header !== undefined && /^\s*application\/json\s*(;|$)/i.test(header);
}

/** Jeu de caractères déclaré : utf-8 (ou absent) accepté, tout autre refusé (415). */
function charsetSupported(header: string): boolean {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(header);
  return match === null || /^utf-?8$/i.test(match[1] ?? '');
}

/** Lit le corps en s'arrêtant (413) dès que `limit` octets sont dépassés. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (request.headers.has('content-length') && Number.isFinite(declared) && declared > limit) throw new HttpError(413);
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Corps JSON des requêtes `Content-Type: application/json`, rangé dans `c.var.body`. Mêmes règles que le parseur
 * d'Express : objet ou tableau seulement (400 sinon), corps vide = `{}`, plafond `limit` octets (413), jeu de
 * caractères autre qu'utf-8 (415). Les autres types de contenu laissent `body` indéfini.
 */
export function jsonBody(limit: number = DEFAULT_JSON_LIMIT): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const request = c.req.raw;
    const contentType = request.headers.get('content-type') ?? undefined;
    const hasBody =
      request.body !== null || request.headers.has('transfer-encoding') || !Number.isNaN(Number(request.headers.get('content-length') ?? Number.NaN));
    if (!hasBody || !isJsonContentType(contentType)) {
      await next();
      return;
    }
    if (!charsetSupported(contentType ?? '')) throw new HttpError(415);
    const encoding = request.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') throw new HttpError(415);
    const text = new TextDecoder('utf-8').decode(await readLimited(request, limit));
    if (text.length === 0) {
      c.set('body', {});
    } else {
      const first = /^[\x20\t\n\r]*(.)/s.exec(text)?.[1];
      if (first !== '{' && first !== '[') throw new HttpError(400);
      try {
        c.set('body', JSON.parse(text) as unknown);
      } catch {
        throw new HttpError(400);
      }
    }
    await next();
  };
}
