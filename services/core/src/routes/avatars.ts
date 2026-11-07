import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { App } from '../http/app-env.js';
import type { AvatarAssets } from '../platform/index.js';

const PREFIX = '/avatars/';
/** Seules ces clés sont servies (voir scripts/avatars/merge.mjs) : aucun autre chemin, donc aucun « .. ». */
const AVATAR_KEY = /^(?:catalog\.json|c\/[a-z0-9][a-z0-9-]{0,47}\.json|i\/[a-z0-9][a-z0-9-]{0,47}\/[a-z0-9][a-z0-9-]{0,47}\.webp)$/;
/** Vignettes : leur chemin ne change jamais de contenu (publication par nouvelles clés), cache longue durée. */
const IMAGE_CACHE = 'public, max-age=31536000, immutable';
/** Catalogue et personnages d'une collection : revalidés au plus une fois par heure. */
const JSON_CACHE = 'public, max-age=3600';

/**
 * Route publique GET /avatars/* (catalogue, personnages, vignettes). Les fichiers viennent de la plateforme (R2 sous
 * Workers, dossier ou relais sous Node) ; une clé inconnue ou absente donne 404.
 */
export function registerAvatarRoutes(app: App, assets: AvatarAssets): void {
  app.get('/avatars/*', async (c) => {
    const key = c.req.path.slice(PREFIX.length);
    const response = AVATAR_KEY.test(key) ? await assets.serve(c.req.raw, key) : null;
    if (response === null) return c.body(null, 404, { 'Cache-Control': 'no-store' });
    const image = key.endsWith('.webp');
    const headers = new Headers(response.headers);
    headers.set('Content-Type', image ? 'image/webp' : 'application/json; charset=utf-8');
    headers.set('Cache-Control', image ? IMAGE_CACHE : JSON_CACHE);
    // c.body (et non new Response) : les en-têtes posés par les middlewares (CORS) sont conservés.
    const status = response.status as ContentfulStatusCode;
    const values = Object.fromEntries(headers);
    return response.body === null ? c.body(null, status, values) : c.body(response.body, status, values);
  });
}
