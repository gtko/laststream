// Captures de l'app pour la page d'accueil du site (public/assets/shots), en mode démo (`?demo=1&clean=1`), sans compte.
// Catalogue factice (mock-catalog.mjs : titres inventés, jaquettes et fonds générés par IA) : aucune affiche réelle,
// aucun appel TMDB ni serveur Laststream. Toute requête vers un autre hôte que localhost est servie par le mock ou bloquée.
//
// Usage : app Vite lancée (npx vite --port 8093 --strictPort dans apps/web), puis
//   CAPTURE_APP_URL=http://localhost:8093 node capture-site.mjs
// Produit dans out/site/ : <nom>.webp (2400x1500 ou 1170x2532), <nom>-1200.webp et <nom>-600.webp.
// Copie ensuite à la main dans public/assets/shots/ après relecture.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogResponse, posterBuffer } from './mock-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..', '..', 'web');
const OUT = join(here, 'out', 'site');
const TMP = join(here, '.capture-data-site');
const APP_URL = (process.env.CAPTURE_APP_URL ?? 'http://localhost:8093').replace(/\/+$/, '');
const DESKTOP = { width: 1200, height: 750 };
const MOBILE = { width: 390, height: 844 };
const MAX_BYTES = { full: 420 * 1024, 1200: 200 * 1024, 600: 80 * 1024 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polices de l'app (Google Fonts) : seul hôte externe autorisé, pour un rendu identique à l'app publiée.
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** Sans bande-annonce : le lecteur YouTube (bloqué ici) laisserait un cadre vide sur la fiche et l'accueil mobile. */
function withoutTrailers(body) {
  if (!body || typeof body !== 'object') return body;
  if (body.videos) return { ...body, videos: { results: [] } };
  if (Array.isArray(body.results) && body.results.some((r) => r && r.type === 'Trailer')) return { ...body, results: [] };
  return body;
}

const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.localhost');

function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg a échoué : ${(r.stderr || '').trim().slice(0, 400)}`);
}

/** PNG → WebP à la largeur voulue ; qualité décroissante jusqu'à passer sous le plafond. */
function toWebp(png, dest, width, max) {
  let last = null;
  for (const q of [82, 76, 70, 64]) {
    runFfmpeg(['-i', png, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', dest]);
    last = { q, kb: Math.round(statSync(dest).size / 1024) };
    if (last.kb * 1024 <= max) break;
  }
  return last;
}

// L'accueil enfant ne met en avant qu'un titre avec bande-annonce : on la garde pour lui seulement.
const opts = { trailers: false };

async function newContext(browser, { mobile }) {
  const context = await browser.newContext(mobile
    ? { viewport: MOBILE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-FR' }
    : { viewport: DESKTOP, deviceScaleFactor: 2, locale: 'fr-FR' });
  const blocked = new Set();
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.hostname === 'image.tmdb.org') {
      return route.fulfill({ status: 200, contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: posterBuffer(url.pathname) });
    }
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST' } });
    // Mode démo : config publique factice (aucun appel au vrai serveur).
    if (/\/config\/encode$/.test(url.pathname)) return json(200, { config: 'demo' });
    const mock = catalogResponse(url.pathname, url.searchParams);
    if (mock) return json(mock.status, opts.trailers ? mock.body : withoutTrailers(mock.body));
    if (/\/lt\//.test(url.pathname)) return json(404, { error: 'not_found' });
    if (isLocalHost(url.hostname) || FONT_HOSTS.has(url.hostname)) return route.continue();
    blocked.add(url.host);
    return route.abort();
  });
  return { context, blocked };
}

async function waitHome(page) {
  await page.locator('.row-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(2500);
}

async function imagesSettled(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(async () => {
    const imgs = [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight);
    const all = Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    await Promise.race([all, new Promise((r) => setTimeout(r, 6000))]);
  });
  await sleep(900);
}

const shots = [];
async function snap(page, name, mobile = false) {
  await imagesSettled(page);
  const png = join(TMP, `${name}.png`);
  console.error(`capture ${name}`);
  await page.screenshot({ path: png });
  shots.push({ name, png, mobile });
}

async function open(page, hash, profile = 'alex') {
  await page.goto(`${APP_URL}/?demo=1&clean=1&profile=${profile}${hash}`, { waitUntil: 'domcontentloaded' });
}

async function desktop(browser) {
  const { context, blocked } = await newContext(browser, { mobile: false });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await open(page, '#/');
    await waitHome(page);
    await snap(page, 'home');
    await page.locator('.row-title').first().evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 70 }));
    await sleep(800);
    await snap(page, 'home-rows');

    await open(page, '#/movie/1001');
    await sleep(4500);
    await snap(page, 'title');

    for (const [name, hash] of [['movies', '#/films'], ['series', '#/series'], ['explore', '#/discover'], ['settings', '#/settings']]) {
      await open(page, hash);
      await sleep(3500);
      await snap(page, name);
    }

    opts.trailers = true;
    await open(page, '#/', 'leo');
    await waitHome(page);
    await snap(page, 'kids');
    opts.trailers = false;
  } finally {
    await context.close();
  }
  return { blocked, errors };
}

async function mobile(browser) {
  const { context, blocked } = await newContext(browser, { mobile: true });
  const page = await context.newPage();
  try {
    await open(page, '#/');
    await waitHome(page);
    await snap(page, 'mobile-home', true);
    await open(page, '#/tv/2001');
    await sleep(3500);
    await snap(page, 'mobile-title', true);
  } finally {
    await context.close();
  }
  return { blocked };
}

async function main() {
  const u = new URL(APP_URL);
  if (!isLocalHost(u.hostname)) throw new Error('CAPTURE_APP_URL doit pointer sur localhost');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  const { chromium } = createRequire(join(APP_DIR, 'package.json'))('playwright');
  const exe = process.env.CAPTURE_CHROMIUM;
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  const report = [];
  try {
    const d = await desktop(browser);
    const m = await mobile(browser);
    const blocked = [...new Set([...d.blocked, ...m.blocked])];
    if (blocked.length) report.push(`hôtes bloqués : ${blocked.join(', ')}`);
    if (d.errors.length) report.push(`erreurs de page : ${d.errors.length} (ex. ${d.errors[0].slice(0, 160)})`);
  } finally {
    await browser.close();
  }
  for (const s of shots) {
    const sizes = s.mobile ? [['', 1170, MAX_BYTES.full], ['-600', 600, MAX_BYTES[600] * 2]] : [['', 2400, MAX_BYTES.full], ['-1200', 1200, MAX_BYTES[1200]], ['-600', 600, MAX_BYTES[600]]];
    for (const [suffix, w, max] of sizes) {
      const info = toWebp(s.png, join(OUT, `${s.name}${suffix}.webp`), w, max);
      report.push(`${s.name}${suffix}.webp ${info.kb} Ko (q${info.q})`);
    }
  }
  console.log(report.join('\n'));
}

main().then(() => process.exit(0), (err) => { console.error(`ECHEC : ${err.message}`); process.exit(1); });
