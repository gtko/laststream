import type { App, Ctx } from './http/app-env.js';
import type { UiAssets } from './platform/index.js';

/** Fichier d'entrée de l'interface : repli des routes de navigation, jamais mis en cache. */
export const UI_INDEX_FILE = 'index.html';
/** Fichiers à revalider à chaque chargement (mise à jour de l'interface ou du service worker). */
const NO_CACHE_FILES: readonly string[] = [UI_INDEX_FILE, 'service-worker.js'];
/** Assets versionnés par leur nom, sous /assets/ : cache longue durée. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** Racines de l'API : jamais de repli sur index.html, même pour une requête de navigation. */
const API_ROOT = /^\/(health|manifest\.json|config|user)(\/|$)/;
/** Routes par configuration : /:config/manifest.json, /:config/stream/…, /:config/play/…, /:config/lt…, /:config/catalog… */
const API_CONFIG_ROUTE = /^\/[^/]+\/(manifest\.json|stream|play|lt|catalog)(\/|$)/;

/** Vrai pour les chemins réservés à l'API (routes Stremio, configuration, utilisateur, santé). */
export function isApiPath(path: string): boolean {
  return API_ROOT.test(path) || API_CONFIG_ROUTE.test(path);
}

/**
 * Origines du même site quand ce serveur sert l'interface : localhost et 127.0.0.1 sur le port, et l'origine de
 * LASTADDON_PUBLIC_URL si elle est définie.
 */
export function sameOriginsFor(port: number, publicUrl?: string): string[] {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (publicUrl !== undefined) origins.push(new URL(publicUrl).origin);
  return origins;
}

/** Dernier segment d'un chemin (« index.html » pour « / » et les dossiers). */
function fileNameOf(pathname: string): string {
  if (pathname.endsWith('/')) return UI_INDEX_FILE;
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** Ajoute les en-têtes de cache de l'application : index.html et service-worker.js sans cache, /assets/* en cache longue durée. */
function withCacheHeaders(res: Response, pathname: string): Response {
  const headers = new Headers(res.headers);
  if (NO_CACHE_FILES.includes(fileNameOf(pathname))) {
    headers.set('Cache-Control', 'no-cache');
  } else if (pathname.startsWith('/assets/')) {
    headers.set('Cache-Control', ASSET_CACHE);
  }
  return new Response(res.body, { status: res.status, headers });
}

/** Page d'un lien public (`/t/:code`) : ni indexée, ni référente (le code ne doit pas fuiter dans l'en-tête Referer). */
const SHARE_PAGE = /^\/t\/[^/]+\/?$/;

/** Ajoute à la page d'un lien public `Referrer-Policy: no-referrer` et `X-Robots-Tag: noindex`. */
function withSharePageHeaders(res: Response, pathname: string): Response {
  if (!SHARE_PAGE.test(pathname)) return res;
  const headers = new Headers(res.headers);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex');
  return new Response(res.body, { status: res.status, headers });
}

/** Requête de navigation : GET ou HEAD, hors API, qui accepte du HTML. Les requêtes de scripts ou d'images n'en sont pas. */
function isNavigation(c: Ctx): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  if (isApiPath(c.req.path)) return false;
  return /text\/html/i.test(c.req.header('accept') ?? '');
}

/**
 * Sert l'interface compilée à la racine. À appeler après les routes API : celles-ci gardent la priorité.
 * Une navigation inconnue (hors API, Accept text/html) reçoit index.html ; un fichier absent reste un 404.
 */
export function registerUiRoutes(app: App, ui: UiAssets): void {
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      await next();
      return;
    }
    const pathname = c.req.path;
    const file = await ui.serve(c.req.raw, pathname === '/' ? `/${UI_INDEX_FILE}` : pathname);
    if (file !== null) return withSharePageHeaders(withCacheHeaders(file, pathname), pathname);
    if (!isNavigation(c)) {
      await next();
      return;
    }
    const index = await ui.serve(c.req.raw, `/${UI_INDEX_FILE}`);
    if (index === null) {
      await next();
      return;
    }
    const headers = new Headers(index.headers);
    headers.set('Cache-Control', 'no-cache');
    return withSharePageHeaders(new Response(index.body, { status: index.status, headers }), pathname);
  });
}
