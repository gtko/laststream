// Capture headless du guide « Ajouter une source » de Laststream.
// Produit, dans out/ajouter-une-source/ : img/01-reglages-sources.webp, img/02-url-addon.webp,
// img/03-apercu-manifest.webp, img/04-fiche-sources.webp, img/poster.webp et clip.mp4 (≤ 20 s, sans audio).
//
// Parcours : Réglages > Sources > « Ajouter un addon Stremio » > coller l'URL > aperçu du manifest > « Enregistrer »
// > fiche d'un film (« Lecture ») > sources trouvées par l'addon.
//
// Usage : node capture-source.mjs   (prérequis : app Vite sur :8080, voir README).
// Démarre sa propre API lastAddon (port 7001, données dans .capture-data-source/) et son propre addon d'exemple
// (port 7101, example-addon/server.mjs). Ne touche pas à l'API du port 7002 ni à laststream-app / laststream-site/public.
// Navigateur toujours headless. Refuse toute adresse non locale et bloque toute requête vers un autre hôte.
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogResponse, posterBuffer } from './mock-catalog.mjs';
import { startExampleAddon } from './example-addon/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// guides-capture -> laststream-site -> laststream (contient laststream-app et lastaddon).
const PROJECTS = resolve(here, '..', '..');
const APP_DIR = join(PROJECTS, 'laststream-app');
const API_DIR = join(PROJECTS, 'lastaddon');
const OUT = join(here, 'out', 'ajouter-une-source');
const WORK = join(here, '.capture-data-source');
const TMP = join(WORK, 'tmp');
const ENV_FILE = join(here, '.env.test');
const APP_URL = (process.env.CAPTURE_APP_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const API_URL = (process.env.CAPTURE_API_URL ?? 'http://localhost:7001').replace(/\/+$/, '');
const ADDON_PORT = 7101;
const ADDON_MANIFEST = `http://localhost:${ADDON_PORT}/manifest.json`;
const VIEWPORT = { width: 1280, height: 800 };
// Réglage serveur de l'app (SETTINGS_STORAGE_KEY dans src/data/config.ts), posé dans le navigateur de test seulement.
const SETTINGS_KEY = 'laststream.lastaddon';
// Préférence « Lancer la meilleure source » (AUTOPLAY_STORAGE_KEY dans src/data/prefs.ts).
const AUTOPLAY_KEY = 'laststream.autoplay';
const MAX_IMG_BYTES = 250 * 1024;
const MAX_CLIP_SEC = 20;
const FIRST_PROFILE = 'Camille';
const FILM_ID = 1001; // « Les Gardiens du phare » : seul titre du catalogue factice avec un identifiant tt…
const FILM_TITLE = 'Les Gardiens du phare';
const POSTER_SHOT = '03-apercu-manifest';
const MAX_ATTEMPTS = 2; // une relance automatique de l'ensemble du parcours, sur un stockage neuf

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

/** Lit SMOKE_USERNAME / SMOKE_PASSWORD de .env.test (partagé avec smoke.mjs et capture-profils.mjs) ; le crée s'il manque. Valeurs jamais affichées. */
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

let logStream = null;
const apiLog = () => createWriteStream(join(WORK, 'api.log'), { flags: 'a' });

/** API lastAddon sur son propre dossier de données (neuf : un dossier daté par essai, jamais réutilisé). */
async function startApi(dataDir) {
  if (await apiUp()) throw new Error(`${API_URL} répond déjà : arrête l'API existante (ce script démarre la sienne)`);
  mkdirSync(dataDir, { recursive: true });
  logStream ??= apiLog();
  const port = new URL(API_URL).port || '7001';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    // CORS de l'API : l'origine de l'app de capture (et 8080/8089 du projet) reste autorisée.
    env: { ...process.env, PORT: port, LASTADDON_DATA_DIR: dataDir, LASTADDON_ALLOWED_ORIGINS: [...new Set([APP_URL, 'http://localhost:8080', 'http://localhost:8089'])].join(',') },
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
  // Chaque mouse.move est un aller-retour CDP (quelques dizaines de ms) : peu d'étapes, espacées, pour un déplacement lisible.
  const steps = Math.max(10, Math.min(22, Math.round(dist / 35)));
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
  // Un élément hors de la fenêtre recevrait le clic à des coordonnées négatives : on le ramène dans la vue d'abord.
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  await glideTo(s, b.x + b.width / 2, b.y + b.height / 2);
  await sleep(140);
  await s.page.mouse.down();
  await sleep(60);
  await s.page.mouse.up();
  if (pause) await sleep(pause);
}

async function typeIn(s, loc, text, pause = 500) {
  await click(s, loc, 250);
  await s.page.keyboard.type(text, { delay: 60 });
  await sleep(pause);
}

function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg a échoué : ${(r.stderr || '').trim().slice(0, 400)}`);
}

/** PNG → WebP ; qualité décroissante jusqu'à passer sous 250 Ko. */
function toWebp(png, dest) {
  let last = null;
  for (const q of [82, 74, 66]) {
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
  await setCaptureLayer(s, false);
  await sleep(120);
  const png = join(TMP, `${s.stamp}-${name}.png`);
  await s.page.screenshot({ path: png });
  await setCaptureLayer(s, true);
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

// ---------- Guide : ajouter une source ----------
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

/** « Sources » dans le menu : la section passe en tête (défilement doux) et devient la catégorie active. */
async function settleOnSources(s) {
  const { page } = s;
  await click(s, page.locator('[data-set-cat="sources"]'), 0);
  await page.locator('[data-set-cat="sources"][aria-current="true"]').first().waitFor({ state: 'attached', timeout: 10_000 });
  await waitScrollSettled(page);
  await sleep(250);
}

async function scenarioSource(s) {
  const { page } = s;
  s.clip.start = now(s);
  // Réglages > Sources (menu du compte).
  await click(s, page.locator('.nav-avatar'), 400);
  await click(s, page.locator('a[href="#/settings"]'), 350);
  await click(s, page.locator('[data-set-cat="sources"]'), 350);
  await page.locator('[data-set-addsrc="upstream"]').waitFor({ state: 'visible', timeout: 30_000 });
  // La configuration se charge après l'ouverture de la page et redessine la liste : on attend ce rendu final.
  await page.locator('#set-la-msg', { hasText: 'chargée' }).waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(600);
  // « Sources » dans le menu : la section passe en tête et devient la catégorie active (surlignée) avant la capture.
  await settleOnSources(s);
  await snap(s, '01-reglages-sources');
  // Ajouter un addon Stremio, puis coller (taper) l'URL du manifest.
  await click(s, page.locator('[data-set-addsrc="upstream"]'), 300);
  const urlInput = page.locator('.src-card [data-sf="url"]').first();
  await urlInput.waitFor({ state: 'visible', timeout: 10_000 });
  await typeIn(s, urlInput, ADDON_MANIFEST, 200);
  await snap(s, '02-url-addon');
  // Sortie du champ : l'app lit le manifest (événement « change »).
  await page.keyboard.press('Tab');
  await page.locator('.src-card[data-status="ok"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await page.locator('.src-card .src-name', { hasText: 'Mon addon' }).first().waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(350);
  // Le défilement vers la carte a déplacé la page : on revient sur « Sources » (menu) avant la capture.
  await settleOnSources(s);
  await snap(s, POSTER_SHOT);
  // Enregistrer.
  await click(s, page.locator('#set-la button[type="submit"]'), 0);
  await page.locator('#set-la-msg', { hasText: 'enregistrée' }).waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(600);
  // Fiche du film, puis « Lecture » : l'addon fournit une source.
  await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, FILM_ID);
  await page.locator('.f-title', { hasText: FILM_TITLE }).waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(450);
  // Lecture sans lecture automatique (préférence posée dans le navigateur de test) : la liste des sources s'ouvre.
  await click(s, page.locator('#f-actions [data-play]'), 300);
  await page.locator('text=Mon addon >> visible=true').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(700);
  s.clip.end = now(s);
  await snap(s, '04-fiche-sources');
}

function cutClip(videoFile, dest, from, dur) {
  runFfmpeg(['-ss', from.toFixed(2), '-i', videoFile, '-t', dur.toFixed(2), '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', dest]);
}

/** Un essai complet : API neuve, addon d'exemple, navigateur headless, parcours, conversions. Renvoie le rapport. */
async function runAttempt(attempt, creds, chromium) {
  const stamp = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-a${attempt}`;
  const dataDir = join(WORK, `data-${stamp}`);
  const videoDir = join(TMP, `video-${stamp}`);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, 'img'), { recursive: true });
  mkdirSync(videoDir, { recursive: true });

  let api = null;
  let browser = null;
  try {
    api = await startApi(dataDir);
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
        // Catalogue TMDB / Top 10 factice (mock-catalog.mjs). Les autres requêtes locales (API, addon d'exemple) passent.
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
    // Lecture sans lecture automatique : « Lecture » ouvre la liste des sources au lieu de lancer la première (faux flux).
    await context.addInitScript(({ key, value }) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      } catch (_) { /* stockage indisponible : lecture automatique par défaut */ }
    }, { key: AUTOPLAY_KEY, value: '0' });
    await context.addInitScript(CURSOR_SCRIPT);

    const page = await context.newPage();
    const s = { page, stamp, guideId: 'ajouter-une-source', marks: {}, clip: {}, shots: [], cursor: { x: 60, y: 60 }, t0: Date.now(), errors: [] };
    page.on('pageerror', (e) => s.errors.push(e.message));
    const videoPromise = page.video();

    try {
      // Le chronomètre part avec la vidéo (newPage) : le clip est découpé à partir de clip.start, bootstrap exclu.
      await bootstrapMain(s, creds);
      await scenarioSource(s);
    } catch (err) {
      await page.screenshot({ path: join(TMP, `${stamp}-echec.png`) }).catch(() => {});
      throw err;
    } finally {
      await context.close(); // finalise la vidéo
    }

    const videoFile = await videoPromise.path();
    let from = Math.max(0, s.clip.start - 0.2);
    const to = s.clip.end + 0.3;
    // La latence de rendu varie d'un passage à l'autre : si le clip dépasse, on coupe le début (menu du compte), jamais la fin.
    const MAX_DUR = MAX_CLIP_SEC - 0.5;
    if (to - from > MAX_DUR) from = to - MAX_DUR;
    const dur = to - from;
    if (dur > MAX_CLIP_SEC) throw new Error(`clip de ${dur.toFixed(1)} s : plus de ${MAX_CLIP_SEC} s`);
    if (s.marks[POSTER_SHOT] - from < 0) throw new Error('image d’affiche avant le début du clip');
    cutClip(videoFile, join(OUT, 'clip.mp4'), from, dur);
    const log = [];
    for (const sh of s.shots) {
      const info = toWebp(sh.png, join(OUT, 'img', `${sh.name}.webp`));
      if (info.kb * 1024 > MAX_IMG_BYTES) throw new Error(`img/${sh.name}.webp : ${info.kb} Ko, plus de 250 Ko`);
      log.push(`img/${sh.name}.webp ${info.kb} Ko (q${info.q})`);
    }
    const posterAt = s.marks[POSTER_SHOT] - from;
    runFfmpeg(['-ss', posterAt.toFixed(2), '-i', join(OUT, 'clip.mp4'), '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', join(OUT, 'img', 'poster.webp')]);
    const mp4Kb = Math.round(statSync(join(OUT, 'clip.mp4')).size / 1024);
    const posterKb = Math.round(statSync(join(OUT, 'img', 'poster.webp')).size / 1024);
    const blockedHosts = [...blocked];
    return [
      ...log,
      `clip.mp4 ${mp4Kb} Ko, durée ${dur.toFixed(1)} s`,
      `img/poster.webp ${posterKb} Ko`,
      ...(blockedHosts.length ? [`hôtes bloqués : ${blockedHosts.join(', ')}`] : []),
      ...(s.errors.length ? [`erreurs de page : ${s.errors.length} (ex. ${s.errors[0].slice(0, 160)})`] : []),
    ];
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopApi(api);
  }
}

async function main() {
  assertLocal(APP_URL, 'CAPTURE_APP_URL');
  assertLocal(API_URL, 'CAPTURE_API_URL');
  if (new URL(API_URL).port === '7002') throw new Error('le port 7002 appartient à un autre agent : utilise 7001');
  mkdirSync(WORK, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  logStream = apiLog();
  if (!(await appUp())) throw new Error(`l'app ne répond pas sur ${APP_URL} : lance « npm run dev » dans laststream-app`);
  const creds = loadCredentials();
  // Playwright vient de laststream-app/node_modules (pas de npm install ici).
  const { chromium } = createRequire(join(APP_DIR, 'package.json'))('playwright');
  // Addon d'exemple du guide, sur son port dédié (le serveur d'exemple ne s'arrête pas tout seul).
  const addon = await startExampleAddon(ADDON_PORT);
  try {
    let report = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !report; attempt++) {
      try {
        report = await runAttempt(attempt, creds, chromium);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        console.log(`essai ${attempt} en échec (${err.message.slice(0, 200)}) : relance automatique`);
      }
    }
    logStream?.end();
    console.log(['## ajouter-une-source', ...report].join('\n'));
  } finally {
    await new Promise((r) => addon.close(() => r()));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    logStream?.end();
    console.error(`ECHEC : ${err.message}`);
    process.exit(1);
  },
);
