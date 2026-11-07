// Captures headless du guide « TV en direct » de Laststream : Réglages > TV en direct (playlist M3U et guide XMLTV),
// puis l'onglet TV (chaînes groupées) et le guide des programmes.
// Produit, dans out/tv-en-direct/ : img/01-reglages-tv.webp, img/02-formulaire.webp, img/03-chaines.webp, img/04-guide.webp,
// img/poster.webp et clip.mp4 (≤ 20 s). Données entièrement fictives : playlist et guide servis par example-tv/server.mjs (port 7102).
//
// Usage : node capture-tv.mjs   (prérequis : app Vite sur :8080, voir README ; l'API lastAddon est lancée par ce script sur :7002).
// Chaque passage repart d'un stockage neuf (.capture-data-tv/data) ; un seul profil principal « Camille ».
// Navigateur toujours headless. Refuse toute adresse non locale et bloque toute requête vers un autre hôte.
// Les briques (API, faux curseur, WebP, clip) sont reprises de capture-profils.mjs ; mock-catalog.mjs n'est que lu.
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogResponse, posterBuffer } from './mock-catalog.mjs';
import { startExampleTv, EXAMPLE_BASE, EXAMPLE_PLAYLIST_URL, EXAMPLE_GUIDE_URL } from './example-tv/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// guides-capture -> laststream-site -> laststream (contient laststream-app et lastaddon).
const PROJECTS = resolve(here, '..', '..');
const APP_DIR = join(PROJECTS, 'laststream-app');
const API_DIR = join(PROJECTS, 'lastaddon');
const OUT = join(here, 'out', 'tv-en-direct');
const WORK = join(here, '.capture-data-tv');
const DATA_DIR = join(WORK, 'data');
const TMP = join(WORK, 'tmp');
const ENV_FILE = join(here, '.env.test');
const APP_URL = (process.env.CAPTURE_APP_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
// Port dédié (un autre agent utilise 7001) ; le stockage est celui de WORK, jamais celui de lastaddon.
const API_URL = (process.env.CAPTURE_TV_API_URL ?? 'http://localhost:7002').replace(/\/+$/, '');
const VIEWPORT = { width: 1280, height: 800 };
// Réglage serveur de l'app (SETTINGS_STORAGE_KEY dans src/data/config.ts), posé dans le navigateur de test seulement.
const SETTINGS_KEY = 'laststream.lastaddon';
const MAX_IMG_BYTES = 250 * 1024;
const MAX_CLIP_SEC = 20;
const MAX_MP4_BYTES = 3 * 1024 * 1024;
const FIRST_PROFILE = 'Camille';
const BOX_NAME = 'Ma box TV';
// Frappe lente, lisible à l'écran.
const TYPE_DELAY_MS = 70;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isLocalHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

function assertLocal(raw, label) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} : protocole non supporté`);
  if (!isLocalHost(url.hostname)) throw new Error(`${label} doit pointer sur localhost (refus de cibler un hôte distant)`);
}

/** Lit SMOKE_USERNAME / SMOKE_PASSWORD de .env.test (partagé avec smoke.mjs) ; le crée s'il manque. Valeurs jamais affichées. */
function loadCredentials() {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, [
      '# Identifiants de test générés par smoke.mjs (compte local uniquement). Ne pas commiter.',
      `SMOKE_USERNAME=smoke${randomBytes(3).toString('hex')}`,
      `SMOKE_PASSWORD=${randomBytes(18).toString('base64url')}`,
      '',
    ].join('\n'), { mode: 0o600 });
  }
  const vars = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  if (!vars.SMOKE_USERNAME || !vars.SMOKE_PASSWORD) throw new Error('.env.test incomplet : supprime-le pour le régénérer');
  return { username: vars.SMOKE_USERNAME, password: vars.SMOKE_PASSWORD };
}

async function postJson(path, body) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, error: (await res.json().catch(() => ({}))).error };
  } catch {
    throw new Error(`API lastAddon injoignable sur ${API_URL}`);
  }
}

async function apiUp() {
  try {
    await fetch(`${API_URL}/user/me`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function appUp() {
  try {
    const r = await fetch(`${APP_URL}/`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Sur un stockage neuf, le premier compte s'inscrit sans lien (comme smoke.mjs). */
async function ensureAccount(creds) {
  const login = await postJson('/user/login', creds);
  if (login.status === 200) return;
  if (login.status !== 401) throw new Error(`/user/login a répondu ${login.status}`);
  const reg = await postJson('/user/register', creds);
  if (reg.status !== 201) throw new Error(`/user/register a répondu ${reg.status}${reg.error ? ` (${reg.error})` : ''}`);
}

const apiLog = () => createWriteStream(join(WORK, 'api.log'), { flags: 'a' });
let logStream = null;

async function startApi() {
  if (await apiUp()) throw new Error(`${API_URL} répond déjà : arrête l'API existante sur ce port (ce script repart d'un stockage neuf)`);
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  mkdirSync(DATA_DIR, { recursive: true });
  logStream ??= apiLog();
  const port = new URL(API_URL).port || '7002';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    // CORS de l'API : l'origine de l'app de capture (7001/8080 du projet restent autorisés par défaut).
    env: { ...process.env, PORT: port, LASTADDON_DATA_DIR: DATA_DIR, LASTADDON_ALLOWED_ORIGINS: [...new Set([APP_URL, 'http://localhost:8080', 'http://localhost:8089'])].join(',') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API arrêtée au démarrage (code ${child.exitCode}) : voir ${join(WORK, 'api.log')}`);
    if (await apiUp()) return child;
    await sleep(300);
  }
  await stopApi(child);
  throw new Error('API lastAddon non joignable après 60 s');
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
}

// ---------- Curseur factice (vidéo seulement : masqué pendant les captures) ----------
const CURSOR_SCRIPT = `(() => {
  if (window.__capCursorInstalled) return;
  window.__capCursorInstalled = true;
  let x = -100, y = -100;
  const layer = () => {
    let l = document.getElementById('__cap_layer');
    if (!l && document.documentElement) {
      l = document.createElement('div');
      l.id = '__cap_layer';
      l.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
      l.innerHTML = '<div id="__cap_cursor" style="position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-100px,-100px)"><span style="display:block;width:100%;height:100%;box-sizing:border-box;border-radius:50%;background:#fff;border:2px solid #111;box-shadow:0 2px 6px rgba(0,0,0,.45)"></span></div>';
      (document.body || document.documentElement).appendChild(l);
    }
    return l;
  };
  const place = () => {
    const c = document.getElementById('__cap_cursor');
    if (c) c.style.transform = 'translate(' + (x - 11) + 'px,' + (y - 11) + 'px)';
  };
  const ripple = (px, py) => {
    const l = layer();
    if (!l) return;
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (px - 22) + 'px;top:' + (py - 22) + 'px;width:44px;height:44px;box-sizing:border-box;border-radius:50%;border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none';
    l.appendChild(r);
    r.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => r.remove();
  };
  const pulse = () => {
    const d = document.querySelector('#__cap_cursor span');
    if (d) d.animate([{ transform: 'scale(1)' }, { transform: 'scale(.6)' }, { transform: 'scale(1)' }], { duration: 260 });
  };
  const onMove = (e) => { x = e.clientX; y = e.clientY; layer(); place(); };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', (e) => { onMove(e); ripple(e.clientX, e.clientY); pulse(); }, true);
  document.addEventListener('DOMContentLoaded', () => { layer(); place(); }, true);
})();`;

// ---------- Helpers de scénario : souris lisible, frappe lente, pauses ----------
const now = (s) => (Date.now() - s.t0) / 1000;

async function glideTo(s, x, y) {
  const dist = Math.hypot(x - s.cursor.x, y - s.cursor.y);
  // Chaque mouse.move est un aller-retour CDP : peu d'étapes, espacées, pour un déplacement lisible.
  const steps = Math.max(8, Math.min(18, Math.round(dist / 45)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (Math.pow(-2 * t + 2, 2)) / 2; // easeInOutQuad
    await s.page.mouse.move(s.cursor.x + (x - s.cursor.x) * e, s.cursor.y + (y - s.cursor.y) * e);
    await sleep(8);
  }
  s.cursor.x = x;
  s.cursor.y = y;
}

async function click(s, loc, pause = 600) {
  const el = loc.first();
  await el.waitFor({ state: 'visible', timeout: 20_000 });
  // Un élément hors de la fenêtre recevrait le clic à des coordonnées négatives.
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  await glideTo(s, b.x + b.width / 2, b.y + b.height / 2);
  await sleep(140);
  await s.page.mouse.down();
  await sleep(60);
  await s.page.mouse.up();
  if (pause) await sleep(pause);
}

/** Attend que plus aucune requête ne soit en cours pendant `quietMs` (ou `maxMs` au plus). */
async function waitNetQuiet(s, quietMs = 500, maxMs = 15_000) {
  const t0 = Date.now();
  let quietSince = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (s.inflight > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs) return;
    await sleep(50);
  }
}

/** Attend que le défilement de la page soit terminé (position stable pendant ~0,5 s). */
async function waitScrollSettled(page) {
  let last = null;
  let still = 0;
  for (let i = 0; i < 40 && still < 5; i++) {
    const y = await page.evaluate(() => window.scrollY);
    still = y === last ? still + 1 : 0;
    last = y;
    await sleep(100);
  }
}

/** Pointeur garé dans un coin vide : pas de survol (ex. colonne de gauche) dans les images. */
async function parkCursor(s) {
  await s.page.mouse.move(2, 2);
  s.cursor.x = 2;
  s.cursor.y = 2;
  await sleep(150);
}

async function typeIn(s, loc, text, pause = 500) {
  await click(s, loc, 250);
  await s.page.keyboard.type(text, { delay: TYPE_DELAY_MS });
  await sleep(pause);
}

async function scrollTo(s, loc, pause = 800) {
  await loc.first().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await sleep(pause);
}

function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg a échoué : ${(r.stderr || '').trim().slice(0, 400)}`);
}

/** PNG → WebP ; qualité décroissante jusqu'à passer sous 250 Ko. */
function toWebp(png, dest) {
  let last = null;
  for (const q of [82, 74, 66, 58]) {
    runFfmpeg(['-i', png, '-frames:v', '1', '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', dest]);
    last = { q, kb: Math.round(statSync(dest).size / 1024) };
    if (last.kb * 1024 <= MAX_IMG_BYTES) break;
  }
  return last;
}

async function setCaptureLayer(s, visible) {
  await s.page.evaluate((v) => {
    const l = document.getElementById('__cap_layer');
    if (l) l.style.display = v ? '' : 'none';
  }, visible);
}

/** Capture PNG (curseur factice masqué). La conversion WebP se fait après l'enregistrement : le clip reste court. */
async function snap(s, name) {
  // La capture fige l'image : ce moment est retiré du clip (s.cuts), l'écran ne bouge pas pendant ce temps.
  const from = now(s);
  await setCaptureLayer(s, false);
  await sleep(120);
  const png = join(TMP, `${name}.png`);
  await s.page.screenshot({ path: png });
  await setCaptureLayer(s, true);
  s.cuts.push([from, now(s)]);
  s.marks[name] = now(s);
  s.shots.push({ name, png });
}

// ---------- Étapes communes ----------
/** Stockage neuf : login UI, puis premier profil « Camille » (principal, sans code PIN), puis accueil. Hors enregistrement. */
async function bootstrapMain(s, creds) {
  const { page } = s;
  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  const form = page.locator('#auth-form');
  await form.waitFor({ state: 'visible', timeout: 30_000 });
  await form.locator('input[name="username"]').fill(creds.username);
  await form.locator('input[name="password"]').fill(creds.password);
  await form.locator('button[type="submit"]').click();
  await page.locator('h1.auth-title', { hasText: 'Qui regarde ?' }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-pf-add]').click();
  const editor = page.locator('form.pf-editor');
  await editor.waitFor({ state: 'visible' });
  await editor.locator('input[name="name"]').fill(FIRST_PROFILE);
  await editor.locator('button[type="submit"]').click();
  await page.locator('.pf', { hasText: FIRST_PROFILE }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.pf', { hasText: FIRST_PROFILE }).click();
  await page.locator('.nav-avatar').waitFor({ state: 'visible', timeout: 30_000 });
  await homeReady(page);
}

/** L'accueil s'affiche d'abord en « chargement », puis se redessine avec le catalogue : on attend ce second rendu. */
async function homeReady(page) {
  await page.locator('.row-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(1200);
}

// ---------- Scénario « TV en direct » ----------
// Les attentes de chargement (serveur, guide) sont retirées du clip : s.cuts garde leurs intervalles (même repère que now(s)).
async function scenarioTv(s) {
  const { page } = s;
  await click(s, page.locator('.nav-avatar'), 400);
  await click(s, page.locator('.nav-pop-profile a[href="#/settings"]'), 400);
  await page.locator('.set-page').waitFor({ state: 'visible', timeout: 20_000 });
  await click(s, page.locator('[data-set-cat="tv"]'), 400);
  await page.locator('#set-p-tv').waitFor({ state: 'visible' });
  // La page Réglages charge sa configuration puis se redessine une fois : on attend ce rendu, sinon il efface la saisie.
  await waitNetQuiet(s);
  await sleep(300);
  s.clip.start = now(s);
  await scrollTo(s, page.locator('.set-card h3', { hasText: 'Playlists M3U' }), 350);
  await snap(s, '01-reglages-tv');

  await scrollTo(s, page.locator('.set-card h3', { hasText: 'Ajouter une playlist M3U' }), 350);
  await typeIn(s, page.locator('[data-box-name]'), BOX_NAME, 200);
  await typeIn(s, page.locator('[data-box-url]'), EXAMPLE_PLAYLIST_URL, 200);
  await typeIn(s, page.locator('[data-box-guide]'), EXAMPLE_GUIDE_URL, 200);
  await snap(s, '02-formulaire');
  const kept = {
    name: await page.locator('[data-box-name]').inputValue(),
    url: await page.locator('[data-box-url]').inputValue(),
    guide: await page.locator('[data-box-guide]').inputValue(),
  };
  if (kept.name !== BOX_NAME || kept.url !== EXAMPLE_PLAYLIST_URL || kept.guide !== EXAMPLE_GUIDE_URL) {
    throw new Error('formulaire vidé pendant la saisie (rendu de la page Réglages) : ' + ['name', 'url', 'guide'].filter((k) => kept[k] === '').join(', ') + ' vide(s)');
  }

  await click(s, page.locator('[data-box-add]'), 0);
  // Attente non filmée : relecture de la playlist et du guide (le message final signale aussi la fin du guide).
  const addWait = now(s) + 0.2;
  await page.locator('#tv-box-msg', { hasText: 'guide à jour' }).waitFor({ state: 'visible', timeout: 45_000 });
  s.cuts.push([addWait, now(s)]);
  await sleep(300);

  // Onglet TV : retour à l'accueil (la barre des réglages n'a que « Retour »), puis « Direct ».
  await click(s, page.locator('[data-back]'), 500);
  await page.locator('.nav-avatar').waitFor({ state: 'visible', timeout: 20_000 });
  const tvWait = now(s) + 0.2;
  await click(s, page.locator('a[href="#/tv-live"]:visible'), 300);
  await page.locator('#tv-title').waitFor({ state: 'visible', timeout: 30_000 });
  s.cuts.push([tvWait, now(s)]);

  // Chaînes de la box, groupées par catégorie (group-title) dans la colonne de gauche.
  await click(s, page.locator('[data-tvcat="Ma box"]'), 400);
  const epgWait = now(s);
  await page.locator('#epg .epg-row').first().waitFor({ state: 'visible', timeout: 20_000 });
  // Le guide arrive après les lignes : on attend de vrais programmes (et non la cellule « Programme indisponible »).
  await page.locator('#epg .epg-cell:not(.epg-none)').first().waitFor({ state: 'visible', timeout: 25_000 });
  s.cuts.push([epgWait, now(s)]);
  await sleep(200);
  // Cadre : le haut de la page TV (filtres, catégories et premières chaînes). En calant la grille en haut, le bouton
  // Retour fixe recouvrait la colonne des catégories ; à la position d'origine il ne recouvre plus rien.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await waitScrollSettled(page);
  await parkCursor(s);
  await snap(s, '03-chaines');

  // Guide des programmes : un programme en cours, sélectionné ; le détail (au-dessus de la grille) est affiché.
  await click(s, page.locator('#epg .epg-cell.is-now').first(), 500);
  await page.locator('#tv-detail .tvd-title').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#tv-detail').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  await sleep(400);
  await parkCursor(s);
  await snap(s, '04-guide');
  s.clip.end = now(s);
}

/** Intervalles gardés du parcours (les attentes retirées), en secondes depuis le début de la vidéo. */
function keptSegments(from, to, cuts) {
  const segs = [];
  let t = from;
  for (const [a, b] of [...cuts].sort((x, y) => x[0] - y[0])) {
    if (b <= t || a >= to) continue;
    if (a > t) segs.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < to) segs.push([t, to]);
  return segs.filter(([a, b]) => b - a > 0.05);
}

/** Temps de sortie (dans le clip) d'un instant de la vidéo. */
function clipTime(segs, t) {
  let out = 0;
  for (const [a, b] of segs) {
    if (t <= a) break;
    out += Math.min(t, b) - a;
  }
  return out;
}

const ENC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];

/** Encode le clip en ne gardant que les intervalles `segs` (attentes retirées par concat). */
function cutClip(videoFile, dest, segs) {
  if (segs.length === 1) {
    runFfmpeg(['-ss', segs[0][0].toFixed(2), '-i', videoFile, '-t', (segs[0][1] - segs[0][0]).toFixed(2), ...ENC, dest]);
    return;
  }
  const parts = segs.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`);
  parts.push(segs.map((_, i) => `[v${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0[outv]`);
  runFfmpeg(['-i', videoFile, '-filter_complex', parts.join(';'), '-map', '[outv]', ...ENC, dest]);
}

async function runCapture(creds, chromium) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'img'), { recursive: true });
  const videoDir = join(TMP, 'video');
  rmSync(videoDir, { recursive: true, force: true });

  let api = null;
  let example = null;
  let browser = null;
  try {
    example = await startExampleTv();
    api = await startApi();
    await ensureAccount(creds);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      locale: 'fr-FR',
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    const blocked = new Set();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      if (url.hostname === 'image.tmdb.org') {
        // Affiches et fonds : affiches locales (guides-capture/posters), servies ici ; le CDN TMDB n'est jamais appelé.
        return route.fulfill({
          status: 200,
          contentType: 'image/webp',
          headers: { 'access-control-allow-origin': '*' },
          body: posterBuffer(url.pathname),
        });
      }
      if (isLocalHost(url.hostname)) {
        // Catalogue TMDB / Top 10 : données factices (mock-catalog.mjs). Playlist et guide : serveur d'exemple (7102), laissés passer.
        const mock = catalogResponse(url.pathname, url.searchParams);
        if (mock) {
          return route.fulfill({
            status: mock.status,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(mock.body),
          });
        }
        return route.continue();
      }
      blocked.add(url.host);
      return route.abort();
    });
    await context.addInitScript(({ key, value }) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      } catch (_) { /* stockage indisponible : l'app demandera le serveur */ }
    }, { key: SETTINGS_KEY, value: JSON.stringify({ base: API_URL, mode: 'custom', custom: API_URL, config: '' }) });
    await context.addInitScript(CURSOR_SCRIPT);

    const page = await context.newPage();
    const s = { page, inflight: 0, marks: {}, clip: {}, cuts: [], shots: [], cursor: { x: 60, y: 60 }, t0: Date.now(), errors: [] };
    page.on('pageerror', (e) => s.errors.push(e.message));
    page.on('request', () => { s.inflight += 1; });
    page.on('requestfinished', () => { s.inflight -= 1; });
    page.on('requestfailed', () => { s.inflight -= 1; });
    s.t0 = Date.now();
    const videoPromise = page.video();

    try {
      await bootstrapMain(s, creds);
      await scenarioTv(s);
    } catch (err) {
      await page.screenshot({ path: join(TMP, 'echec-tv.png') }).catch(() => {});
      throw err;
    } finally {
      await context.close(); // finalise la vidéo
    }

    const videoFile = await videoPromise.path();
    const from = Math.max(0, s.clip.start - 0.1);
    const to = s.clip.end + 0.2;
    const segs = keptSegments(from, to, s.cuts);
    const dur = segs.reduce((acc, [a, b]) => acc + (b - a), 0);
    if (dur > MAX_CLIP_SEC) throw new Error(`clip de ${dur.toFixed(1)} s : plus de ${MAX_CLIP_SEC} s`);
    cutClip(videoFile, join(OUT, 'clip.mp4'), segs);
    const mp4Bytes = statSync(join(OUT, 'clip.mp4')).size;
    if (mp4Bytes > MAX_MP4_BYTES) throw new Error(`clip.mp4 de ${Math.round(mp4Bytes / 1024)} Ko : plus de 3 Mo`);
    const log = [];
    for (const sh of s.shots) {
      const info = toWebp(sh.png, join(OUT, 'img', `${sh.name}.webp`));
      log.push(`img/${sh.name}.webp ${info.kb} Ko (q${info.q})`);
      if (info.kb * 1024 > MAX_IMG_BYTES) throw new Error(`img/${sh.name}.webp : ${info.kb} Ko, plus de 250 Ko`);
    }
    const posterAt = clipTime(segs, s.marks['03-chaines']);
    runFfmpeg(['-ss', posterAt.toFixed(2), '-i', join(OUT, 'clip.mp4'), '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', join(OUT, 'img', 'poster.webp')]);
    const posterKb = Math.round(statSync(join(OUT, 'img', 'poster.webp')).size / 1024);
    const blockedHosts = [...blocked];
    return [
      '## tv-en-direct',
      ...log,
      `clip.mp4 ${Math.round(mp4Bytes / 1024)} Ko, durée ${dur.toFixed(1)} s`,
      `img/poster.webp ${posterKb} Ko`,
      ...(blockedHosts.length ? [`hôtes bloqués : ${blockedHosts.join(', ')}`] : []),
      ...(s.errors.length ? [`erreurs de page : ${s.errors.length} (ex. ${s.errors[0].slice(0, 160)})`] : []),
    ];
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopApi(api);
    await example?.close().catch(() => {});
  }
}

async function main() {
  assertLocal(APP_URL, 'CAPTURE_APP_URL');
  assertLocal(API_URL, 'CAPTURE_TV_API_URL');
  assertLocal(EXAMPLE_BASE, 'serveur d’exemple');
  mkdirSync(WORK, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  if (!(await appUp())) throw new Error(`l'app ne répond pas sur ${APP_URL} : lance « npm run dev » dans laststream-app`);
  const creds = loadCredentials();
  // Playwright vient de laststream-app/node_modules (pas de npm install ici).
  const { chromium } = createRequire(join(APP_DIR, 'package.json'))('playwright');
  logStream = apiLog();
  const report = await runCapture(creds, chromium);
  logStream?.end();
  console.log(report.join('\n'));
}

main().then(
  () => process.exit(0),
  (err) => {
    logStream?.end();
    console.error(`ECHEC : ${err.message}`);
    process.exit(1);
  },
);
