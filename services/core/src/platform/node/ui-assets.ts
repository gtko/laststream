import { existsSync, statSync, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { UiAssets } from '../types.js';

/** Fichier d'entrée de l'interface. */
const INDEX_FILE = 'index.html';

/** Erreur de démarrage si le dossier d'interface ne contient pas index.html. Le message ne montre aucun contenu. */
export function assertUiDir(dir: string): void {
  const index = join(dir, INDEX_FILE);
  if (!existsSync(index) || !statSync(index).isFile()) {
    throw new Error(`Dossier d'interface invalide (LASTADDON_UI_DIR ou --ui) : ${INDEX_FILE} introuvable`);
  }
}

const TEXT = 'text/plain; charset=utf-8';
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': TEXT,
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Chemin demandé → chemin absolu sous `root`, ou undefined (hors racine, fichier caché, octet nul). */
function resolveInside(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment !== '');
  // Fichiers et dossiers cachés ignorés (comme dotfiles: 'ignore'), et aucun segment « .. » toléré.
  if (segments.some((segment) => segment.startsWith('.'))) return undefined;
  const target = resolve(root, ...segments);
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

/** ETag faible dérivé de la taille et de la date de modification. */
function etagOf(info: Stats): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const weak = (value: string): string => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => weak(candidate) === weak(etag));
}

/** Plage `bytes=a-b`, `bytes=a-` ou `bytes=-n` sur un fichier de `size` octets. null : plage non satisfaisable ; undefined : ignorée. */
function parseRange(header: string, size: number): { start: number; end: number } | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  return start > end || start >= size ? null : { start, end };
}

/** Interface web lue dans un dossier : types MIME, ETag, Last-Modified, requêtes conditionnelles et plages. */
export function createFsUiAssets(dir: string): UiAssets {
  const root = resolve(dir);
  return {
    async serve(request, pathname) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return null;
      let file = resolveInside(root, pathname);
      if (file === undefined) return null;
      let info = await stat(file).catch(() => undefined);
      if (info?.isDirectory() === true) {
        file = join(file, INDEX_FILE);
        info = await stat(file).catch(() => undefined);
      }
      if (info === undefined || !info.isFile()) return null;

      const headers = new Headers({
        'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=0',
        'Last-Modified': info.mtime.toUTCString(),
        ETag: etagOf(info),
      });

      const ifNoneMatch = request.headers.get('if-none-match');
      const ifModifiedSince = request.headers.get('if-modified-since');
      const notModified =
        ifNoneMatch !== null
          ? etagMatches(ifNoneMatch, etagOf(info))
          : ifModifiedSince !== null && Math.floor(info.mtimeMs / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000);
      if (notModified) {
        headers.delete('Content-Type');
        return new Response(null, { status: 304, headers });
      }

      let status = 200;
      let data = await readFile(file);
      const rangeHeader = request.headers.get('range');
      if (rangeHeader !== null) {
        const range = parseRange(rangeHeader, data.length);
        if (range === null) {
          headers.set('Content-Range', `bytes */${data.length}`);
          return new Response(null, { status: 416, headers });
        }
        if (range !== undefined) {
          headers.set('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`);
          data = data.subarray(range.start, range.end + 1);
          status = 206;
        }
      }
      headers.set('Content-Length', String(data.length));
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), { status, headers });
    },
  };
}
