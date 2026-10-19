// Playlist M3U et guide XMLTV FICTIFS pour les captures « TV en direct » (guides-capture/capture-tv.mjs).
// Mini serveur http natif, CORS ouvert, écoute sur 127.0.0.1:7102 :
//   /playlist.m3u      8 chaînes inventées (tvg-id, tvg-name, tvg-logo, group-title, tvg-chno 1-8)
//   /epg.xml           guide XMLTV : programmes de 30 à 90 min couvrant maintenant → +24 h (dates calculées à l'exécution)
//   /logo/<n>.svg      logos générés (initiales sur fond coloré)
//   /live/<n>.m3u8     404 : pas de flux, la lecture n'est pas requise pour les captures
// Aucune donnée réelle : noms, titres et logos sont inventés. Lancement direct : node example-tv/server.mjs
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const EXAMPLE_PORT = 7102;
export const EXAMPLE_BASE = `http://localhost:${EXAMPLE_PORT}`;
export const EXAMPLE_PLAYLIST_URL = `${EXAMPLE_BASE}/playlist.m3u`;
export const EXAMPLE_GUIDE_URL = `${EXAMPLE_BASE}/epg.xml`;

const CHANNELS = [
  { n: 1, id: 'laststream.info', name: 'Laststream Info', group: 'Généralistes', initials: 'LI', color: '#c2185b', titles: [
    'Le journal de 13 h', 'Le point sur la semaine', 'Bulletin régional', 'Le journal du soir', 'Analyse du jour',
    'Reportage : la ville en fête', 'Le grand débat', 'Le journal de nuit'] },
  { n: 2, id: 'cine.etoile', name: 'Ciné Étoile', group: 'Cinéma', initials: 'CÉ', color: '#1565c0', titles: [
    'La Nuit des Comètes', 'Le Dernier Train d’Ouest', 'Amours à Lisbonne', 'Le Secret du Phare', 'Mission Orbite', 'Les Trois Marées'] },
  { n: 3, id: 'docu.planete', name: 'Docu Planète', group: 'Documentaires', initials: 'DP', color: '#2e7d32', titles: [
    'Les forêts oubliées', 'Océans profonds', 'Les glaciers en mouvement', 'Villages d’altitude', 'Savanes vivantes', 'Le désert qui chante'] },
  { n: 4, id: 'sport.arena', name: 'Sport Arena', group: 'Sport', initials: 'SA', color: '#ef6c00', titles: [
    'Magazine sportif', 'Match du soir (direct)', 'Les coulisses du stade', 'Analyse tactique', 'Tournoi : résumé', 'Le club de la semaine'] },
  { n: 5, id: 'kids.arcenciel', name: 'Kids Arc-en-ciel', group: 'Jeunesse', initials: 'KA', color: '#00897b', titles: [
    'Les Petits Explorateurs', 'Pipou et ses amis', 'Le club des robots', 'Dessins du matin', 'Les Chatons joyeux', 'Atelier magie'] },
  { n: 6, id: 'musique.live', name: 'Musique Live', group: 'Musique', initials: 'MU', color: '#6a1b9a', titles: [
    'Top du moment', 'Concert acoustique', 'Clips en boucle', 'Session live', 'Les nuits jazz', 'Rock et rétro'] },
  { n: 7, id: 'meteo.locale', name: 'Météo Locale', group: 'Généralistes', initials: 'ML', color: '#0277bd', titles: [
    'Prévisions de la journée', 'Bulletin du soir', 'Météo de la semaine', 'Alertes et vigilance', 'Vents et marées', 'Prévisions du week-end'] },
  { n: 8, id: 'series.club', name: 'Séries Club', group: 'Cinéma', initials: 'SC', color: '#c62828', titles: [
    'Les Enquêteurs', 'Chronique d’un hiver', 'Au cœur du quartier', 'Le dernier appartement', 'Les Héritiers', 'Nuits blanches'] },
];

// Durées en minutes (30 à 90), cyclées de façon déterministe pour chaque chaîne.
const DURATIONS = [30, 60, 45, 90, 30, 75, 60, 45];
const SLOT_MS = 30 * 60 * 1000;
const WINDOW_AFTER_MS = 25 * 3600 * 1000; // maintenant → +24 h, avec une marge

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** « 20261019140000 +0000 » : format XMLTV, UTC. */
function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

export function playlistText() {
  const lines = ['#EXTM3U'];
  for (const c of CHANNELS) {
    lines.push(`#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${EXAMPLE_BASE}/logo/${c.n}.svg" tvg-chno="${c.n}" group-title="${c.group}",${c.name}`);
    lines.push(`${EXAMPLE_BASE}/live/${c.n}.m3u8`);
  }
  return lines.join('\n') + '\n';
}

export function guideText(now = Date.now()) {
  // Fenêtre : à partir du créneau de 30 min qui précède maintenant (moins 1 h), jusqu'à +25 h.
  const from = Math.floor((now - 3600 * 1000) / SLOT_MS) * SLOT_MS;
  const to = now + WINDOW_AFTER_MS;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="laststream guides-capture (fictif)">'];
  for (const c of CHANNELS) {
    out.push(`  <channel id="${c.id}"><display-name lang="fr">${xmlEscape(c.name)}</display-name><icon src="${EXAMPLE_BASE}/logo/${c.n}.svg"/></channel>`);
  }
  for (const c of CHANNELS) {
    let t = from + (c.n % 3) * SLOT_MS; // décalage par chaîne pour ne pas aligner toutes les grilles
    let i = 0;
    while (t < to) {
      const dur = DURATIONS[(i + c.n) % DURATIONS.length] * 60 * 1000;
      const title = c.titles[(i + c.n) % c.titles.length];
      out.push(`  <programme start="${xmltvTime(t)}" stop="${xmltvTime(t + dur)}" channel="${c.id}">` +
        `<title lang="fr">${xmlEscape(title)}</title>` +
        `<desc lang="fr">${xmlEscape(`${title} : émission fictive de la playlist d’exemple (${c.name}).`)}</desc>` +
        `<category lang="fr">${xmlEscape(c.group)}</category></programme>`);
      t += dur;
      i += 1;
    }
  }
  out.push('</tv>');
  return out.join('\n') + '\n';
}

export function logoSvg(n) {
  const c = CHANNELS.find((x) => x.n === n);
  if (!c) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90">` +
    `<rect width="160" height="90" rx="12" fill="${c.color}"/>` +
    `<text x="80" y="57" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#ffffff">${c.initials}</text></svg>\n`;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
  });
  res.end(body);
}

export function createExampleServer() {
  return createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain; charset=utf-8', '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Méthode non autorisée\n');
    const path = new URL(req.url ?? '/', EXAMPLE_BASE).pathname;
    if (path === '/playlist.m3u') return send(res, 200, 'audio/x-mpegurl; charset=utf-8', playlistText());
    if (path === '/epg.xml') return send(res, 200, 'application/xml; charset=utf-8', guideText());
    const logo = /^\/logo\/(\d+)\.svg$/.exec(path);
    if (logo) {
      const svg = logoSvg(Number(logo[1]));
      if (svg) return send(res, 200, 'image/svg+xml; charset=utf-8', svg);
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Non trouvé (exemple fictif)\n');
  });
}

/** Démarre le serveur sur 127.0.0.1:7102 ; renvoie { close() }. Refuse si le port est pris. */
export function startExampleTv(port = EXAMPLE_PORT) {
  const server = createExampleServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startExampleTv().then(() => console.log(`exemple TV (fictif) prêt sur ${EXAMPLE_BASE}`), (err) => {
    console.error(`ECHEC : ${err.message}`);
    process.exit(1);
  });
}
