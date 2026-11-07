// Addon d'exemple du guide « Ajouter une source » de Laststream : un mini serveur Stremio (http natif, CORS ouvert).
// Sert exactement l'addon décrit dans le guide : /manifest.json, /logo.svg et /stream/{type}/{id}.json (même réponse
// pour tout identifiant). Port 7101 par défaut (variable EXAMPLE_ADDON_PORT). Écoute sur toutes les interfaces
// (IPv4 et IPv6) pour que « localhost » réponde quel que soit l'ordre de résolution.
//
// Usage : node example-addon/server.mjs   (ou importé : startExampleAddon() renvoie le serveur http).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.EXAMPLE_ADDON_PORT ?? 7101);
const ORIGIN = `http://localhost:${PORT}`;

const MANIFEST = {
  id: 'exemple.mon-addon',
  version: '1.0.0',
  name: 'Mon addon',
  description: 'Exemple de source pour Laststream',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: `${ORIGIN}/logo.svg`,
};

// Logo local : un disque sombre avec une flèche de lecture (SVG simple, sans ressource externe).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#1b1830"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="#f5b942" stroke-width="10"/>
  <path d="M54 42 L90 64 L54 86 Z" fill="#f5b942"/>
</svg>
`;

const STREAMS = {
  streams: [{ name: 'Mon addon', title: '1080p', url: `${ORIGIN}/video.mp4` }],
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
};

function send(res, status, type, body) {
  res.writeHead(status, { ...CORS, 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain; charset=utf-8', '');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Méthode non autorisée');
  const { pathname } = new URL(req.url ?? '/', ORIGIN);
  if (pathname === '/manifest.json') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(MANIFEST));
  if (pathname === '/logo.svg') return send(res, 200, 'image/svg+xml', LOGO_SVG);
  const stream = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(pathname);
  if (stream) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(STREAMS));
  return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }));
}

/** Démarre le serveur d'exemple et renvoie l'instance http (écoute sur PORT). */
export function startExampleAddon(port = PORT) {
  const server = createServer(handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startExampleAddon().then(
    () => console.log(`Addon d'exemple : ${ORIGIN}/manifest.json`),
    (err) => {
      console.error(`Addon d'exemple : échec au démarrage (${err.message})`);
      process.exit(1);
    },
  );
}
