import { existsSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

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

/** Erreur de démarrage si le dossier d'interface n'contient pas index.html. Le message ne montre aucun contenu. */
export function assertUiDir(dir: string): void {
  const index = join(dir, UI_INDEX_FILE);
  if (!existsSync(index) || !statSync(index).isFile()) {
    throw new Error(`Dossier d'interface invalide (LASTADDON_UI_DIR ou --ui) : ${UI_INDEX_FILE} introuvable`);
  }
}

/** En-têtes de cache des fichiers statiques : index.html et service-worker.js sans cache, /assets/* en cache longue durée. */
function staticHeaders(root: string) {
  return (res: Response, filePath: string): void => {
    if (NO_CACHE_FILES.includes(basename(filePath))) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (relative(root, filePath).split(sep)[0] === 'assets') {
      res.setHeader('Cache-Control', ASSET_CACHE);
    }
  };
}

/** Requête de navigation : GET ou HEAD, hors API, qui accepte du HTML. Les requêtes de scripts ou d'images n'en sont pas. */
function isNavigation(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (isApiPath(req.path)) return false;
  return /text\/html/i.test(req.get('accept') ?? '');
}

/**
 * Sert l'interface compilée à la racine. À appeler après les routes API : celles-ci gardent la priorité.
 * Une navigation inconnue (hors API, Accept text/html) reçoit index.html ; un fichier absent reste un 404.
 */
export function registerUiRoutes(app: Express, dir: string): void {
  const root = resolve(dir);
  const indexPath = join(root, UI_INDEX_FILE);
  app.use(express.static(root, { index: UI_INDEX_FILE, setHeaders: staticHeaders(root) }));
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (!isNavigation(req)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });
}
