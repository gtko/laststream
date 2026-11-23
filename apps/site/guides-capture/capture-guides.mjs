// Captures annotées des guides du site, en français et en anglais.
//
// Pour chaque guide et chaque langue : API lastAddon locale neuve (services/core, stockage jetable), app Vite locale,
// navigateur headless. Le catalogue est factice (mock-catalog.mjs : titres inventés, jaquettes générées par IA) : aucune
// affiche réelle, aucun appel TMDB. Toute requête vers un autre hôte que localhost est bloquée (sauf Google Fonts).
//
// Chaque capture est prise sans annotation (la vidéo reste propre), puis annotée après coup : cadre jaune autour de
// l'endroit où cliquer, pastille numérotée et bulle de texte dans la langue du guide. En anglais, l'interface de l'app
// est traduite à l'affichage par i18n-en.mjs (l'app elle-même n'est qu'en français).
//
// Usage (app Vite lancée : `npx vite --port 8093 --strictPort` dans apps/web) :
//   CAPTURE_APP_URL=http://localhost:8093 node capture-guides.mjs [guide ...] [--lang fr|en]
// Produit out/guides/<lang>/<guide>/ : img/NN-nom.webp (2560x1600), img/NN-nom-1280.webp, img/poster.webp, img/og.jpg,
// clip.mp4. Copie ensuite (après relecture) avec `node capture-guides.mjs --install`.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogResponse, posterBuffer } from './mock-catalog.mjs';
import { startExampleAddon } from './example-addon/server.mjs';
import { startExampleTv, EXAMPLE_PLAYLIST_URL, EXAMPLE_GUIDE_URL } from './example-tv/server.mjs';
import { EN_TEXT, EN_PATTERNS, EN_CONTEXT } from './i18n-en.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const APP_DIR = join(ROOT, 'apps', 'web');
const API_DIR = join(ROOT, 'services', 'core');
const SITE_PUBLIC = resolve(here, '..', 'public');
const OUT = join(here, 'out', 'guides');
const WORK = join(here, '.capture-data-guides');
const APP_URL = (process.env.CAPTURE_APP_URL ?? 'http://localhost:8093').replace(/\/+$/, '');
const API_PORT = Number(process.env.CAPTURE_API_PORT ?? 7004);
const API_URL = `http://localhost:${API_PORT}`;
const ADDON_MANIFEST = 'http://localhost:7101/manifest.json';
const VIEWPORT = { width: 1280, height: 800 };
const SETTINGS_KEY = 'laststream.lastaddon';
const AUTOPLAY_KEY = 'laststream.autoplay';
const MAX_IMG = { full: 300 * 1024, small: 130 * 1024 };
const MAX_CLIP_SEC = 24;
const PARENTAL_CODE = '2468';
const CREDS = { username: 'camille', password: 'guides-' + Math.random().toString(36).slice(2, 12) };
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.localhost');

// ---------- Outils ----------
function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg a échoué : ${(r.stderr || '').trim().slice(0, 400)}`);
}

function toWebp(png, dest, width, max) {
  let last = null;
  for (const q of [84, 78, 72, 66, 60]) {
    runFfmpeg(['-i', png, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', dest]);
    last = { q, kb: Math.round(statSync(dest).size / 1024) };
    if (last.kb * 1024 <= max) break;
  }
  return last;
}

async function up(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * API locale sur un stockage neuf. `node` : serveur Node de services/core (sans watch party) ; `worker` : le Worker
 * Cloudflare en local (`wrangler dev --local`, Durable Objects compris : salons, amis en direct).
 */
async function startApi(dataDir, backend = 'node') {
  if (await up(`${API_URL}/user/me`)) throw new Error(`${API_URL} répond déjà : arrête l'API existante`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const secret = 'capture-guides-' + 'x'.repeat(32);
  const child = backend === 'worker'
    ? (mkdirSync(join(API_DIR, 'worker-ui'), { recursive: true }), spawn(join(API_DIR, 'node_modules', '.bin', 'wrangler'), ['dev', '--local', '--port', String(API_PORT), '--persist-to', dataDir,
      '--var', 'LASTADDON_PUBLIC:0', '--var', 'LASTADDON_ALLOW_SIGNUP:1', '--var', `LASTADDON_ALLOWED_ORIGINS:${APP_URL}`, '--var', `LASTADDON_SECRET:${secret}`], {
      cwd: API_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    }))
    : spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: API_DIR,
      env: { ...process.env, PORT: String(API_PORT), LASTADDON_DATA_DIR: dataDir, LASTADDON_SECRET: secret, LASTADDON_ALLOW_SIGNUP: '1', LASTADDON_ALLOWED_ORIGINS: APP_URL },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API arrêtée au démarrage : ${err.slice(-400)}`);
    if (await up(`${API_URL}/user/me`)) return child;
    await sleep(300);
  }
  await stopApi(child);
  throw new Error('API lastAddon non joignable après 90 s');
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  // wrangler lance workerd en sous-processus : on arrête tout le groupe.
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([exited, sleep(5000)]);
}

async function register(creds = CREDS) {
  const res = await fetch(`${API_URL}/user/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) });
  if (res.status !== 201) throw new Error(`/user/register a répondu ${res.status}`);
}

// ---------- Traduction de l'interface (anglais) ----------
// Injecté dans la page : remplace les textes et attributs connus, au chargement puis à chaque changement du DOM.
function translatorScript({ text, patterns, contexts }) {
  const dict = new Map(Object.entries(text));
  const pats = patterns.map(([re, to]) => [new RegExp(re), to]);
  const ctx = contexts.map(([sel, map]) => [sel, new Map(Object.entries(map))]);
  const norm = (s) => s.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  const one = (key) => {
    if (dict.has(key)) return dict.get(key);
    for (const [re, to] of pats) if (re.test(key)) return key.replace(re, to);
    return null;
  };
  const tr = (raw, el) => {
    const key = norm(raw);
    if (!key) return null;
    if (el) for (const [sel, map] of ctx) if (map.has(key) && el.closest && el.closest(sel)) return map.get(key);
    const whole = one(key);
    if (whole !== null) return whole;
    // « Drame · 2024 · ★ 8,1 », « 4 billets disponibles · 0 validé » : chaque morceau séparément.
    if (key.includes(' · ')) {
      const parts = key.split(' · ');
      const out = parts.map((p) => one(p) ?? p);
      if (out.some((p, i) => p !== parts[i])) return out.join(' · ');
    }
    return null;
  };
  const fixNode = (n) => {
    const out = tr(n.nodeValue, n.parentElement);
    if (out !== null && out !== norm(n.nodeValue)) {
      const lead = /^\s*/.exec(n.nodeValue)[0];
      const trail = /\s*$/.exec(n.nodeValue)[0];
      n.nodeValue = lead + out + trail;
    }
  };
  const ATTRS = ['placeholder', 'aria-label', 'title', 'data-tip'];
  const fixEl = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) {
        const out = tr(v);
        if (out !== null && out !== v) el.setAttribute(a, out);
      }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
      const out = tr(el.value);
      if (out !== null) el.value = out;
    }
  };
  const walk = (root) => {
    if (root.nodeType === 3) return fixNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
      fixEl(root);
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) {
        const p = n.parentNode;
        if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue;
        fixNode(n);
      } else fixEl(n);
    }
  };
  const start = () => {
    document.documentElement.lang = 'en';
    walk(document.documentElement);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') fixNode(m.target);
        else if (m.type === 'attributes') fixEl(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (document.title) document.title = tr(document.title) ?? document.title;
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  window.__untranslated = () => {
    const seen = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest('script,style')) continue;
      const r = p.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight || getComputedStyle(p).visibility === 'hidden') continue;
      const k = norm(n.nodeValue);
      if (k && /[a-zà-ÿ]{2}/i.test(k) && tr(k, p) === null && !Object.values(text).includes(k)) seen.add(k);
    }
    return [...seen];
  };
}

// ---------- Curseur factice (vidéo seulement) ----------
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
  const place = () => { const c = document.getElementById('__cap_cursor'); if (c) c.style.transform = 'translate(' + (x - 11) + 'px,' + (y - 11) + 'px)'; };
  const ripple = (px, py) => {
    const l = layer(); if (!l) return;
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (px - 22) + 'px;top:' + (py - 22) + 'px;width:44px;height:44px;box-sizing:border-box;border-radius:50%;border:3px solid rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none';
    l.appendChild(r);
    r.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => r.remove();
  };
  const onMove = (e) => { x = e.clientX; y = e.clientY; layer(); place(); };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mousedown', (e) => { onMove(e); ripple(e.clientX, e.clientY); }, true);
})();`;

// ---------- Gestes lisibles (souris, frappe) ----------
const now = (s) => (Date.now() - s.t0) / 1000;

async function glideTo(s, x, y) {
  const dist = Math.hypot(x - s.cursor.x, y - s.cursor.y);
  const steps = Math.max(8, Math.min(20, Math.round(dist / 40)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await s.page.mouse.move(s.cursor.x + (x - s.cursor.x) * e, s.cursor.y + (y - s.cursor.y) * e);
    await sleep(8);
  }
  s.cursor = { x, y };
}

async function click(s, loc, pause = 600) {
  const el = loc.first();
  await el.waitFor({ state: 'visible', timeout: 20_000 });
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const b = await el.boundingBox();
  await glideTo(s, b.x + b.width / 2, b.y + b.height / 2);
  await sleep(120);
  await s.page.mouse.down();
  await sleep(50);
  await s.page.mouse.up();
  if (pause) await sleep(pause);
}

async function typeIn(s, loc, text, pause = 400) {
  await click(s, loc, 200);
  await s.page.keyboard.type(text, { delay: 55 });
  await sleep(pause);
}

async function scrollTo(s, loc, block = 'center', pause = 800) {
  await loc.first().evaluate((el, b) => el.scrollIntoView({ block: b, behavior: 'smooth' }), block);
  await sleep(pause);
}

async function waitScrollSettled(page) {
  let last = null;
  let still = 0;
  for (let i = 0; i < 40 && still < 5; i++) {
    const y = await page.evaluate(() => window.scrollY + ':' + (document.scrollingElement?.scrollTop ?? 0));
    still = y === last ? still + 1 : 0;
    last = y;
    await sleep(100);
  }
}

async function parkCursor(s) {
  await glideTo(s, VIEWPORT.width - 30, VIEWPORT.height - 30);
}

// ---------- Captures ----------
/**
 * Capture propre (curseur masqué) et relevé des zones à annoter. `marks` : [{ loc, label: { fr, en }, place?, pad? }].
 * Les rectangles sont relevés au moment de la capture, en pixels CSS de la fenêtre.
 */
async function snap(s, name, marks = []) {
  await s.page.evaluate(() => { const l = document.getElementById('__cap_layer'); if (l) l.style.display = 'none'; });
  await sleep(150);
  if (s.lang === 'en') {
    const left = await s.page.evaluate(() => window.__untranslated?.() ?? []);
    if (left.length) s.untranslated.push(...left.map((t) => `${name}: ${t}`));
  }
  const rects = [];
  for (const m of marks) {
    const el = m.loc.first();
    await el.waitFor({ state: 'visible', timeout: 10_000 });
    const b = await el.boundingBox();
    if (!b) throw new Error(`${name} : zone à annoter introuvable`);
    rects.push({ x: b.x, y: b.y, w: b.width, h: b.height, label: m.label[s.lang], place: m.place, pad: m.pad ?? 6, n: m.n });
  }
  const png = join(s.tmp, `${name}.png`);
  await s.page.screenshot({ path: png });
  await s.page.evaluate(() => { const l = document.getElementById('__cap_layer'); if (l) l.style.display = ''; });
  s.marks[name] = now(s);
  s.shots.push({ name, png, rects });
}

/** Dessine les annotations sur une capture (page à part, même échelle) : cadre, pastille numérotée, bulle. */
async function annotate(browser, shot, dest) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const { readFileSync } = await import('node:fs');
  const b64 = readFileSync(shot.png).toString('base64');
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:#000}
    img{position:absolute;inset:0;width:100%;height:100%}
    .ring{position:absolute;box-sizing:border-box;border:3px solid #ffd23f;border-radius:12px;
      box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 22px 4px rgba(255,210,63,.55),inset 0 0 0 1px rgba(0,0,0,.35)}
    .dim{position:absolute;border-radius:12px;box-shadow:0 0 0 4000px rgba(5,4,10,.42)}
    .badge{position:absolute;width:30px;height:30px;border-radius:50%;background:#ffd23f;color:#141118;
      font:800 16px/30px "Segoe UI",Roboto,Arial,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.6),0 0 0 2px #141118}
    .bubble{position:absolute;max-width:300px;padding:8px 13px;border-radius:10px;background:#ffd23f;color:#141118;
      font:700 15px/1.3 "Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.55),0 0 0 2px #141118;white-space:normal}
  </style></head><body><img src="data:image/png;base64,${b64}"><div id="a"></div></body></html>`);
  await page.evaluate(({ rects, W, H }) => {
    const root = document.getElementById('a');
    const add = (cls, css, txt) => { const d = document.createElement('div'); d.className = cls; Object.assign(d.style, css); if (txt) d.textContent = txt; root.appendChild(d); return d; };
    // Assombrit le reste seulement quand il n'y a qu'une zone : l'œil va droit à l'endroit où cliquer.
    if (rects.length === 1) {
      const r = rects[0];
      add('dim', { left: r.x - r.pad + 'px', top: r.y - r.pad + 'px', width: r.w + 2 * r.pad + 'px', height: r.h + 2 * r.pad + 'px' });
    }
    const boxes = [];
    const placed = [];
    rects.forEach((r, i) => {
      const L = Math.max(2, r.x - r.pad), T = Math.max(2, r.y - r.pad);
      const R = Math.min(W - 2, r.x + r.w + r.pad), B = Math.min(H - 2, r.y + r.h + r.pad);
      add('ring', { left: L + 'px', top: T + 'px', width: R - L + 'px', height: B - T + 'px' });
      const n = String(r.n ?? (rects.length > 1 ? i + 1 : ''));
      if (n) add('badge', { left: Math.max(4, L - 15) + 'px', top: Math.max(4, T - 15) + 'px' }, n);
      boxes.push({ L, T, R, B });
    });
    rects.forEach((r, i) => {
      if (!r.label) return;
      const { L, T, R, B } = boxes[i];
      const el = add('bubble', { left: '0px', top: '0px', visibility: 'hidden' }, (rects.length > 1 ? (r.n ?? i + 1) + '. ' : '') + r.label);
      const bw = el.offsetWidth, bh = el.offsetHeight, gap = 14;
      const cx = (L + R) / 2, cy = (T + B) / 2;
      const clampX = (x) => Math.max(8, Math.min(W - bw - 8, x));
      const clampY = (y) => Math.max(8, Math.min(H - bh - 8, y));
      const cand = {
        below: [clampX(cx - bw / 2), B + gap],
        above: [clampX(cx - bw / 2), T - gap - bh],
        right: [R + gap, clampY(cy - bh / 2)],
        left: [L - gap - bw, clampY(cy - bh / 2)],
        // Dans le cadre, à droite : pour les champs larges, sans masquer le texte autour.
        inside: [R - bw - 12, cy - bh / 2],
      };
      const fits = ([x, y]) => x >= 4 && y >= 4 && x + bw <= W - 4 && y + bh <= H - 4;
      const overlaps = ([x, y], k) => placed.some((b) => x < b.R + 6 && x + bw > b.L - 6 && y < b.B + 6 && y + bh > b.T - 6) ||
        (k !== 'inside' && boxes.some((b) => x < b.R && x + bw > b.L && y < b.B && y + bh > b.T));
      const order = r.place ? [r.place, 'below', 'above', 'left', 'right'] : ['below', 'above', 'left', 'right'];
      const key = order.find((k) => fits(cand[k]) && !overlaps(cand[k], k)) ?? order.find((k) => fits(cand[k]));
      const pos = key ? cand[key] : [clampX(cx - bw / 2), clampY(B + gap)];
      placed.push({ L: pos[0], T: pos[1], R: pos[0] + bw, B: pos[1] + bh });
      el.style.left = pos[0] + 'px';
      el.style.top = pos[1] + 'px';
      el.style.visibility = 'visible';
    });
  }, { rects: shot.rects, W: VIEWPORT.width, H: VIEWPORT.height });
  await page.screenshot({ path: dest });
  await page.close();
}

// ---------- Préparation commune ----------
async function homeReady(page) {
  await page.locator('.row-title').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(1200);
}

/** Connexion (compte créé par l'API), premier profil « Camille », accueil. Hors vidéo utile. */
async function bootstrap(s, creds = CREDS, name = 'Camille') {
  const { page } = s;
  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  const form = page.locator('#auth-form');
  await form.waitFor({ state: 'visible', timeout: 30_000 });
  await form.locator('input[name="username"]').fill(creds.username);
  await form.locator('input[name="password"]').fill(creds.password);
  await form.locator('button[type="submit"]').click();
  const add = page.locator('[data-pf-add]');
  await add.first().waitFor({ state: 'visible', timeout: 30_000 });
  await add.first().click();
  const editor = page.locator('form.pf-editor');
  await editor.waitFor({ state: 'visible' });
  await editor.locator('input[name="name"]').fill(name);
  await editor.locator('button[type="submit"]:visible').first().click();
  const pf = page.locator('.pf', { hasText: name });
  await pf.waitFor({ state: 'visible', timeout: 15_000 });
  await pf.click();
  await page.locator('.nav-avatar').waitFor({ state: 'visible', timeout: 30_000 });
  await homeReady(page);
}

const L = (fr, en) => ({ fr, en });

// ---------- Scénarios ----------
const SCENARIOS = {};

/** Avatar en haut à droite, puis « Changer de profil » : écran « Qui regarde ? ». */
async function openWhoWatches(s, shot) {
  const { page } = s;
  await click(s, page.locator('.nav-avatar'), 700);
  await page.locator('[data-nav-switch]').first().waitFor({ state: 'visible' });
  if (shot) {
    await snap(s, shot, [
      { loc: page.locator('.nav-avatar'), label: L('Ton avatar', 'Your avatar'), n: 1, place: 'left' },
      { loc: page.locator('[data-nav-switch]'), label: L('Changer de profil', 'Switch profile'), n: 2, place: 'left' },
    ]);
  }
  await click(s, page.locator('[data-nav-switch]'), 900);
  await page.locator('[data-pf-add]').first().waitFor({ state: 'visible' });
}

const editor = (page) => page.locator('form.pf-editor');
const saveBtn = (page) => editor(page).locator('[data-pfe-save]:visible').first();

SCENARIOS['creer-un-profil'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await openWhoWatches(s, '01-avatar');
  await sleep(300);
  await snap(s, '02-ajouter', [{ loc: page.locator('[data-pf-add]'), label: L('Ajouter un profil', 'Add a profile') }]);
  await click(s, page.locator('[data-pf-add]'), 900);
  const form = editor(page);
  await form.waitFor({ state: 'visible' });
  await typeIn(s, form.locator('input[name="name"]'), 'Léo', 300);
  await click(s, form.locator('[data-pfe-color]').nth(2), 500);
  await parkCursor(s);
  await snap(s, '03-nom-couleur', [
    { loc: form.locator('input[name="name"]'), label: L('Son prénom', 'Their name'), n: 1, place: 'inside' },
    { loc: form.locator('[data-pfe-studio]'), label: L('Un avatar (facultatif)', 'An avatar (optional)'), n: 2, place: 'right' },
    { loc: form.locator('.pfe-colors'), label: L('Une couleur', 'A colour'), n: 3, place: 'right' },
  ]);
  await scrollTo(s, form.locator('[data-pfe-pin="pin"]'), 'center', 900);
  await parkCursor(s);
  await snap(s, '04-code-pin', [
    { loc: form.locator('[data-pfe-pin="pin"]'), label: L('Code PIN : facultatif', 'PIN code: optional'), n: 1, place: 'inside' },
    { loc: saveBtn(page), label: L('Créer le profil', 'Create profile'), n: 2, place: 'below' },
  ]);
  await click(s, saveBtn(page), 0);
  const leo = page.locator('.pf', { hasText: 'Léo' });
  await leo.first().waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(900);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '05-profil-cree', [{ loc: leo, label: L('Le nouveau profil', 'The new profile') }]);
};

SCENARIOS['profil-enfant'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await openWhoWatches(s, null);
  await click(s, page.locator('[data-pf-add]'), 900);
  const form = editor(page);
  await form.waitFor({ state: 'visible' });
  await typeIn(s, form.locator('input[name="name"]'), 'Lina', 300);
  await scrollTo(s, form.locator('#pfe-s-kid'), 'start', 900);
  await click(s, form.locator('.pfe-switch-row'), 700);
  await form.locator('[data-kidage]').waitFor({ state: 'visible' });
  await scrollTo(s, form.locator('.pfe-switch-row'), 'center', 900);
  await parkCursor(s);
  await snap(s, '01-case-enfant', [{ loc: form.locator('.pfe-switch-row'), label: L('Active « Profil enfant »', 'Turn on “Kids profile”') }]);
  await scrollTo(s, form.locator('.pf-sections'), 'center', 900);
  await parkCursor(s);
  await snap(s, '02-rubriques', [
    { loc: form.locator('[data-kidage] .pfe-field').first(), label: L('Âge maximal', 'Maximum age'), n: 1, place: 'right' },
    { loc: form.locator('.pf-sections'), label: L('Rubriques autorisées', 'Allowed sections'), n: 2, place: 'right' },
  ]);
  await scrollTo(s, form.locator('[data-pfe-pin="parental"]'), 'center', 800);
  await click(s, form.locator('[data-pfe-pin="parental"] [data-pfe-digit="0"]'), 200);
  await page.keyboard.type(PARENTAL_CODE, { delay: 120 });
  await sleep(500);
  await parkCursor(s);
  await snap(s, '03-code-parental', [
    { loc: form.locator('[data-pfe-pin="parental"]'), label: L('Code parental (4 chiffres)', 'Parental code (4 digits)'), n: 1, place: 'inside' },
    { loc: saveBtn(page), label: L('Créer le profil', 'Create profile'), n: 2, place: 'below' },
  ]);
  await click(s, saveBtn(page), 0);
  const lina = page.locator('.pf', { hasText: 'Lina' });
  await lina.first().waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(700);
  // Après l'enregistrement, l'écran est en mode « Gérer les profils » : « Terminé » revient à « Qui regarde ? ».
  const done = page.locator('[data-pf-manage]', { hasText: /^\s*(Terminé|Done)\s*$/ });
  if (await done.count()) await click(s, done, 700);
  const reloaded = page.waitForEvent('load', { timeout: 30_000 }).catch(() => {});
  await click(s, lina, 0);
  await reloaded;
  await page.locator('.nav-avatar').waitFor({ state: 'visible', timeout: 30_000 });
  await homeReady(page);
  await parkCursor(s);
  await snap(s, '04-accueil-enfant', [{ loc: page.locator('.nav-avatar'), label: L('Profil enfant actif', 'Kids profile in use'), place: 'left' }]);
  await click(s, page.locator('.nav-avatar'), 700);
  await click(s, page.locator('[data-nav-switch]'), 700);
  await page.locator('.pin-back .pin').first().waitFor({ state: 'visible', timeout: 10_000 });
  await sleep(500);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '05-sortie-code', [{ loc: page.locator('.pin-back .pin'), label: L('Code parental demandé pour sortir', 'Parental code needed to leave'), place: 'below' }]);
};

async function settleOnSources(s) {
  const { page } = s;
  await click(s, page.locator('[data-set-cat="sources"]'), 0);
  await waitScrollSettled(page);
  await sleep(300);
}

SCENARIOS['ajouter-une-source'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await click(s, page.locator('.nav-avatar'), 600);
  await snap(s, '01-menu-reglages', [{ loc: page.locator('.nav-pop a[href="#/settings"], a[href="#/settings"]:visible'), label: L('Réglages', 'Settings'), place: 'left' }]);
  await click(s, page.locator('a[href="#/settings"]:visible'), 600);
  await page.locator('[data-set-addsrc="upstream"]').waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator('#set-la-msg', { hasText: /chargée|loaded/ }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await sleep(600);
  await settleOnSources(s);
  await parkCursor(s);
  await snap(s, '02-reglages-sources', [
    { loc: page.locator('[data-set-cat="sources"]'), label: L('Sources', 'Sources'), n: 1, place: 'right' },
    { loc: page.locator('[data-set-addsrc="upstream"]'), label: L('Ajouter un addon Stremio', 'Add a Stremio addon'), n: 2, place: 'below' },
  ]);
  await click(s, page.locator('[data-set-addsrc="upstream"]'), 400);
  const url = page.locator('.src-card [data-sf="url"]').first();
  await url.waitFor({ state: 'visible', timeout: 10_000 });
  await typeIn(s, url, ADDON_MANIFEST, 200);
  await parkCursor(s);
  await snap(s, '03-url-addon', [{ loc: url, label: L('Colle l’URL du manifest', 'Paste the manifest URL'), place: 'inside' }]);
  await page.keyboard.press('Tab');
  await page.locator('.src-card[data-status="ok"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await sleep(700);
  await page.locator('.src-card[data-status="ok"]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(500);
  await parkCursor(s);
  await snap(s, '04-addon-lu', [
    { loc: page.locator('.src-card[data-status="ok"]').first(), label: L('Addon reconnu : nom et logo', 'Addon recognised: name and logo'), n: 1, place: 'above' },
    { loc: page.locator('#set-la button[type="submit"]:visible').first(), label: L('Enregistrer', 'Save'), n: 2, place: 'above' },
  ]);
  await click(s, page.locator('#set-la button[type="submit"]:visible').first(), 0);
  await page.locator('#set-la-msg', { hasText: /enregistrée|saved/ }).waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(600);
  await page.evaluate(() => { location.hash = '#/movie/1001'; });
  await page.locator('#f-actions [data-play]').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(600);
  await click(s, page.locator('#f-actions [data-play]'), 300);
  const src = page.locator('text=Mon addon >> visible=true').first();
  await src.waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(800);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '05-fiche-sources', [{ loc: src, label: L('Les sources de ton addon', 'Your addon’s sources') }]);
};

const BOX_NAME = 'Ma box';

SCENARIOS['tv-en-direct'] = async (s) => {
  const { page } = s;
  await click(s, page.locator('.nav-avatar'), 400);
  await click(s, page.locator('a[href="#/settings"]:visible'), 500);
  await page.locator('.set-page').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#set-la-msg', { hasText: /chargée|loaded/ }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  s.clip.start = now(s);
  await click(s, page.locator('[data-set-cat="tv"]'), 0);
  await waitScrollSettled(page);
  await sleep(400);
  await parkCursor(s);
  await snap(s, '01-reglages-tv', [{ loc: page.locator('[data-set-cat="tv"]'), label: L('TV en direct', 'Live TV'), place: 'right' }]);
  await scrollTo(s, page.locator('[data-box-name]'), 'center', 700);
  await typeIn(s, page.locator('[data-box-name]'), BOX_NAME, 150);
  await typeIn(s, page.locator('[data-box-url]'), EXAMPLE_PLAYLIST_URL, 150);
  await typeIn(s, page.locator('[data-box-guide]'), EXAMPLE_GUIDE_URL, 150);
  await parkCursor(s);
  await snap(s, '02-formulaire', [
    { loc: page.locator('[data-box-name]'), label: L('Un nom (facultatif)', 'A name (optional)'), n: 1, place: 'inside' },
    { loc: page.locator('[data-box-url]'), label: L('Lien de la playlist M3U', 'M3U playlist link'), n: 2, place: 'inside' },
    { loc: page.locator('[data-box-guide]'), label: L('Lien du guide XMLTV (facultatif)', 'XMLTV guide link (optional)'), n: 3, place: 'inside' },
    { loc: page.locator('[data-box-add]'), label: L('Ajouter la playlist', 'Add playlist'), n: 4, place: 'right' },
  ]);
  await click(s, page.locator('[data-box-add]'), 0);
  await page.locator('#tv-box-msg', { hasText: /guide à jour|guide updated/ }).waitFor({ state: 'visible', timeout: 45_000 });
  await sleep(400);
  await click(s, page.locator('[data-back]').first(), 600);
  await page.locator('.nav-avatar').waitFor({ state: 'visible', timeout: 20_000 });
  await sleep(500);
  await parkCursor(s);
  await snap(s, '03-onglet-direct', [{ loc: page.locator('a[href="#/tv-live"]:visible').first(), label: L('Direct', 'Live') }]);
  await click(s, page.locator('a[href="#/tv-live"]:visible'), 300);
  await page.locator('#tv-title').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#epg .epg-cell:not(.epg-none)').first().waitFor({ state: 'visible', timeout: 25_000 });
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await waitScrollSettled(page);
  await parkCursor(s);
  await snap(s, '04-chaines', [
    { loc: page.locator('#epg .epg-row').first(), label: L('Tes chaînes, avec le badge « Box »', 'Your channels, with the “Box” badge'), place: 'below' },
  ]);
  await click(s, page.locator('#epg .epg-cell.is-now').first(), 500);
  await page.locator('#tv-detail .tvd-title').waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await waitScrollSettled(page);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '05-guide', [{ loc: page.locator('#tv-detail'), label: L('Le programme en cours', 'What’s on now'), place: 'below' }]);
};

// ---------- Outils des guides sociaux et réglages ----------
/** Va à une route de l'app et attend un élément. */
async function goTo(s, hash, ready) {
  await s.page.evaluate((h) => { location.hash = h; }, hash);
  if (ready) await s.page.locator(ready).first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(900);
}

/** Avatar > Réglages, page chargée. */
async function openSettings(s) {
  const { page } = s;
  await click(s, page.locator('.nav-avatar'), 400);
  await click(s, page.locator('a[href="#/settings"]:visible'), 500);
  await page.locator('.set-page').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#set-la-msg', { hasText: /chargée|loaded/ }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await sleep(400);
}

/** Catégorie des réglages (menu de gauche), défilement terminé. */
async function settingsCat(s, cat) {
  await click(s, s.page.locator(`[data-set-cat="${cat}"]`), 0);
  await waitScrollSettled(s.page);
  await sleep(300);
}

/** Ajoute des films à la bibliothèque depuis leur fiche (menu « … »), hors vidéo utile. */
async function addToLibrary(s, ids) {
  const { page } = s;
  for (const id of ids) {
    await goTo(s, `#/movie/${id}`, '[data-fiche-more]');
    await page.locator('[data-fiche-more]').click();
    await page.locator('.ctxmenu [data-ctx="lib"]').click();
    await sleep(700);
  }
}

/** Installe l'addon d'exemple (Réglages > Sources), hors vidéo utile : la watch party trouve alors une source. */
async function installExampleAddon(s) {
  const { page } = s;
  await goTo(s, '#/settings', '.set-page');
  await page.locator('#set-la-msg', { hasText: /chargée|loaded/ }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await page.locator('[data-set-addsrc="upstream"]').click();
  const url = page.locator('.src-card [data-sf="url"]').first();
  await url.fill(ADDON_MANIFEST);
  await url.press('Tab');
  await page.locator('.src-card[data-status="ok"]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await page.locator('#set-la button[type="submit"]:visible').first().click();
  await page.locator('#set-la-msg', { hasText: /enregistrée|saved/ }).waitFor({ state: 'visible', timeout: 15_000 });
}

/** État de capture pour la page du second compte : mêmes captures, autre page. */
const asLeo = (s, leo) => ({ ...s, page: leo.page, cursor: { x: 640, y: 400 } });

/** Panneau Amis ouvert (bouton en haut à droite). */
async function openSocial(s, pause = 900) {
  await click(s, s.page.locator('[data-soc-open]:visible'), pause);
  await s.page.locator('#ss-add').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Camille et Léo deviennent amis (sans vidéo utile) : demande par Nom#TAG, acceptée par Léo. */
async function befriend(s, leo) {
  const L2 = asLeo(s, leo);
  await openSocial(L2, 300);
  const handle = (await leo.page.locator('#ss-me-handle').getAttribute('aria-label')).replace(/^.* /, '');
  await leo.page.keyboard.press('Escape');
  await openSocial(s, 300);
  await s.page.locator('#ss-add input').fill(handle);
  await s.page.locator('#ss-add [type=submit]').click();
  await sleep(1500);
  await leo.page.reload();
  await leo.page.locator('[data-soc-open]:visible').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(1500);
  await openSocial(L2, 600);
  await leo.page.locator('[data-ss-act="accept"]').first().click();
  await sleep(1500);
  await s.page.keyboard.press('Escape');
  await sleep(500);
  return handle;
}

SCENARIOS['ajouter-des-amis'] = async (s) => {
  const { page } = s;
  const leo = await secondAccount(s);
  try {
    const L2 = asLeo(s, leo);
    await openSocial(L2, 300);
    const handle = (await leo.page.locator('#ss-me-handle').getAttribute('aria-label')).replace(/^.* /, '');
    await leo.page.keyboard.press('Escape');
    // Page calme (en-tête simple) : le panneau Amis s'ouvre sur la droite.
    await goTo(s, '#/library', '[data-soc-open]:visible');
    s.clip.start = now(s);
    await parkCursor(s);
    await snap(s, '01-bouton-amis', [{ loc: page.locator('[data-soc-open]:visible'), label: L('Amis', 'Friends'), place: 'left' }]);
    await openSocial(s);
    await parkCursor(s);
    await snap(s, '02-ton-tag', [
      { loc: page.locator('#ss-me-handle'), label: L('Ton Nom#TAG : clique pour le copier', 'Your Name#TAG: click to copy it'), n: 1, place: 'below' },
      { loc: page.locator('#ss-add'), label: L('Le Nom#TAG de ton ami', 'Your friend’s Name#TAG'), n: 2, place: 'below' },
    ]);
    await typeIn(s, page.locator('#ss-add input'), handle, 300);
    await parkCursor(s);
    await snap(s, '03-ajouter', [
      { loc: page.locator('#ss-add input'), label: L('Nom#TAG de ton ami', 'Your friend’s Name#TAG'), n: 1, place: 'below' },
      { loc: page.locator('#ss-add [type=submit]'), label: L('Ajouter', 'Add'), n: 2, place: 'below' },
    ]);
    await click(s, page.locator('#ss-add [type=submit]'), 1500);
    await parkCursor(s);
    await snap(s, '04-demande-envoyee', [{ loc: page.locator('.ss-panel:visible .ss-row, .ss-panel:visible li').first(), label: L('Demande envoyée : en attente', 'Request sent: pending'), place: 'below' }]);
    // Côté Léo : la demande arrive, il l'accepte.
    await leo.page.reload();
    await leo.page.locator('[data-soc-open]:visible').first().waitFor({ state: 'visible', timeout: 30_000 });
    await goTo(L2, '#/library', '[data-soc-open]:visible');
    await openSocial(L2, 600);
    await snap(L2, '05-accepter', [{ loc: leo.page.locator('[data-ss-act="accept"]').first(), label: L('Ton ami accepte', 'Your friend accepts'), place: 'below' }]);
    await leo.page.locator('[data-ss-act="accept"]').first().click();
    await sleep(2000);
    await parkCursor(s);
    s.clip.end = now(s);
    await snap(s, '06-ami-en-ligne', [{ loc: page.locator('.ss-panel:visible .ss-row, .ss-panel:visible li').first(), label: L('Vous êtes amis', 'You’re now friends'), place: 'below' }]);
  } finally {
    await leo.close();
  }
};

SCENARIOS['watch-party'] = async (s) => {
  const { page } = s;
  const leo = await secondAccount(s);
  try {
    await befriend(s, leo);
    await installExampleAddon(s);
    await goTo(s, '#/movie/1001', '[data-fiche-more]');
    await sleep(3500); // le message « Configuration enregistrée » disparaît
    s.clip.start = now(s);
    await parkCursor(s);
    await snap(s, '01-plus-actions', [{ loc: page.locator('[data-fiche-more]'), label: L('Plus d’actions', 'More actions'), place: 'right' }]);
    await click(s, page.locator('[data-fiche-more]'), 700);
    await parkCursor(s);
    await snap(s, '02-menu-fiche', [{ loc: page.locator('.ctxmenu [data-ctx="party"]'), label: L('Regarder avec…', 'Watch with…'), place: 'right' }]);
    await click(s, page.locator('.ctxmenu [data-ctx="party"]'), 1200);
    await parkCursor(s);
    await snap(s, '03-regarder-avec', [{ loc: page.locator('[data-ww-room]'), label: L('Ouvrir un salon pour ce titre', 'Open a room for this title'), place: 'below' }]);
    await click(s, page.locator('[data-ww-room]'), 1500);
    const friend = page.locator('input[type="checkbox"][name="friend"]').first();
    await friend.waitFor({ state: 'attached', timeout: 15_000 });
    await click(s, friend.locator('xpath=..'), 500);
    await parkCursor(s);
    await snap(s, '04-salon', [
      { loc: page.locator('input[name="vis"][value="private"]').locator('xpath=..'), label: L('Privé : amis invités seulement', 'Private: invited friends only'), n: 1, place: 'above' },
      { loc: friend.locator('xpath=ancestor::li[1]'), label: L('Coche les amis à inviter', 'Tick the friends to invite'), n: 2, place: 'right' },
      { loc: page.locator('[data-wp-mode="lobby"]'), label: L('Ouvrir le salon d’attente', 'Open the waiting room'), n: 3, place: 'below' },
    ]);
    await click(s, page.locator('[data-wp-mode="lobby"]'), 0);
    await page.locator('[data-pl-start]').first().waitFor({ state: 'visible', timeout: 30_000 });
    await sleep(3500);
    await parkCursor(s);
    s.clip.end = now(s);
    await snap(s, '05-salon-attente', [
      { loc: page.locator('[data-pl-copy]').first(), label: L('Lien à partager', 'Link to share'), n: 1, place: 'above' },
      { loc: page.locator('[data-pl-tab]').last(), label: L('Inviter d’autres amis', 'Invite more friends'), n: 2, place: 'below' },
      { loc: page.locator('[data-pl-start]').first(), label: L('Lancer quand tout le monde est prêt', 'Start when everyone is ready'), n: 3, place: 'above' },
    ]);
  } finally {
    await leo.close();
  }
};

SCENARIOS['inviter-un-proche'] = async (s) => {
  const { page } = s;
  await addToLibrary(s, [1001, 1003, 1004, 2002].filter((x) => x < 2000));
  await goTo(s, '#/', '.row-title');
  s.clip.start = now(s);
  await openSettings(s);
  const fold = page.locator('[data-tk-fold]');
  await scrollTo(s, fold, 'center', 900);
  await parkCursor(s);
  await snap(s, '01-billets', [{ loc: fold, label: L('Mes billets de parrainage', 'My invitation tickets'), place: 'below' }]);
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await click(s, fold, 900);
  const ticket = page.locator('[data-tk-ticket]').first();
  await ticket.waitFor({ state: 'visible', timeout: 15_000 });
  await scrollTo(s, ticket, 'center', 700);
  await parkCursor(s);
  await snap(s, '02-offrir', [{ loc: ticket, label: L('Offrir ce billet', 'Give this ticket'), place: 'below' }]);
  await click(s, ticket, 1200);
  const msg = page.locator('#tk-msg');
  await msg.waitFor({ state: 'visible', timeout: 15_000 });
  await scrollTo(s, page.locator('.tk-compose'), 'center', 700);
  await typeIn(s, msg, s.lang === 'en' ? 'Come and join me, the catalogue is huge!' : 'Viens me rejoindre, le catalogue est immense !', 300);
  const picks = page.locator('[data-tk-pick]');
  const n = Math.min(3, await picks.count());
  for (let i = 0; i < n; i++) await click(s, picks.nth(i), 500);
  await parkCursor(s);
  await snap(s, '03-billet', [
    { loc: msg, label: L('Ton mot', 'Your note'), n: 1, place: 'inside' },
    ...(n ? [{ loc: page.locator('.tk-grid-picks'), label: L('3 coups de cœur', '3 favourites'), n: 2, place: 'above' }] : []),
    { loc: page.locator('[data-tk-copy]').first(), label: L('Copier le lien', 'Copy the link'), n: n ? 3 : 2, place: 'below' },
  ]);
  await click(s, page.locator('[data-tk-copy]').first(), 1800);
  await scrollTo(s, page.locator('[data-tk-row]'), 'center', 800);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '04-envoye', [{ loc: page.locator('[data-tk-ticket]').first(), label: L('Billet envoyé, en attente', 'Ticket sent, pending'), place: 'below' }]);
};

SCENARIOS['importer-stremio'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await openSettings(s);
  const toggle = page.locator('[data-mg-toggle]');
  await scrollTo(s, toggle, 'center', 900);
  await parkCursor(s);
  await snap(s, '01-importer', [{ loc: toggle, label: L('Importer depuis une autre app', 'Import from another app'), place: 'below' }]);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await click(s, toggle, 900);
  const src = page.locator('[data-mg-src="stremio"]');
  await src.waitFor({ state: 'visible', timeout: 10_000 });
  await scrollTo(s, src, 'center', 600);
  await parkCursor(s);
  await snap(s, '02-compte-stremio', [
    { loc: src, label: L('Compte Stremio', 'Stremio account'), n: 1, place: 'right' },
    { loc: page.locator('[data-mg-src="stremio-file"]'), label: L('Ou ton fichier d’export', 'Or your export file'), n: 2, place: 'right' },
  ]);
  await click(s, src, 900);
  await page.locator('[data-mg-ack]').waitFor({ state: 'visible', timeout: 10_000 });
  await click(s, page.locator('[data-mg-ack]'), 900);
  const form = page.locator('#mg-stremio');
  await form.waitFor({ state: 'visible', timeout: 10_000 });
  await scrollTo(s, form, 'center', 600);
  await typeIn(s, form.locator('input[name="email"]'), 'camille@example.com', 200);
  await typeIn(s, form.locator('input[name="password"]'), 'motdepasse', 200);
  await parkCursor(s);
  await snap(s, '03-identifiants', [
    { loc: form.locator('input[name="email"]'), label: L('E-mail Stremio', 'Stremio email'), n: 1, place: 'inside' },
    { loc: form.locator('input[name="password"]'), label: L('Mot de passe Stremio', 'Stremio password'), n: 2, place: 'inside' },
    { loc: form.locator('[type="submit"]'), label: L('Lire ma bibliothèque', 'Read my library'), n: 3, place: 'right' },
  ]);
  await click(s, form.locator('[type="submit"]'), 0);
  const run = page.locator('[data-mg-run]');
  await run.waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(700);
  await scrollTo(s, run, 'center', 600);
  await parkCursor(s);
  await snap(s, '04-apercu', [
    { loc: page.locator('.mg-fs').first(), label: L('Décoche ce que tu ne veux pas', 'Untick what you don’t want'), n: 1, place: 'above' },
    { loc: run, label: L('Importer', 'Import'), n: 2, place: 'right' },
  ]);
  await click(s, run, 0);
  const done = page.locator('.si-actions a[data-libnav]');
  await done.waitFor({ state: 'visible', timeout: 60_000 });
  await sleep(800);
  await scrollTo(s, done, 'center', 600);
  await parkCursor(s);
  await snap(s, '05-termine', [{ loc: done, label: L('Voir ma bibliothèque', 'See my library'), place: 'below' }]);
  await click(s, done, 0);
  await page.locator('[data-libvis], .lib-grid, [data-info]').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  await sleep(1500);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '06-bibliotheque', []);
};

SCENARIOS['partager-sa-bibliotheque'] = async (s) => {
  const { page } = s;
  await addToLibrary(s, [1001, 1003, 1004, 1019]);
  await goTo(s, '#/', '.row-title');
  s.clip.start = now(s);
  await click(s, page.locator('.nav-drop-btn:visible').first(), 600);
  const libLink = page.locator('.nav-pop-explore:visible a[href="#/library"]').first();
  await parkCursor(s);
  await snap(s, '01-ma-liste', [
    { loc: page.locator('.nav-drop-btn:visible').first(), label: L('Explorer', 'Explore'), n: 1, place: 'left' },
    { loc: libLink, label: L('Ma liste', 'My list'), n: 2, place: 'right' },
  ]);
  await click(s, libLink, 0);
  const eye = page.locator('[data-libvis="movie:1019"]'); // sans bandeau « Top 10 »
  await eye.waitFor({ state: 'attached', timeout: 30_000 });
  await sleep(1000);
  await eye.waitFor({ state: 'visible', timeout: 10_000 });
  await parkCursor(s);
  await snap(s, '02-oeil', [{ loc: eye, label: L('L’œil barré : titre privé', 'Crossed-out eye: private title'), place: 'below' }]);
  await click(s, eye, 0); // clic direct, avant l'aperçu au survol de l'affiche
  await parkCursor(s);
  await sleep(1200);
  await snap(s, '03-titre-partage', [{ loc: eye, label: L('Œil ouvert : visible par tes amis', 'Open eye: your friends can see it'), place: 'below' }]);
  page.once('dialog', (d) => d.accept());
  await parkCursor(s);
  await snap(s, '04-tout-partager', [
    { loc: page.locator('[data-libshare="friends"]'), label: L('Tout partager', 'Share everything'), n: 1, place: 'below' },
    { loc: page.locator('[data-libshare="private"]'), label: L('Tout garder privé', 'Keep everything private'), n: 2, place: 'below' },
  ]);
  await click(s, page.locator('[data-libshare="friends"]'), 1800);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '05-partagee', [{ loc: page.locator('[data-libshare-note]'), label: L('Visible par tes amis', 'Visible to your friends'), place: 'below' }]);
};

/** Ligne de réglage (libellé + contrôle) qui contient l'élément donné. */
const rowOf = (loc) => loc.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " set-row ")][1]');

SCENARIOS['sous-titres-et-langues'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await openSettings(s);
  await settingsCat(s, 'audio');
  const audio = page.locator('[data-set-pref="lang-audio"]');
  await scrollTo(s, audio, 'center', 800);
  await parkCursor(s);
  await snap(s, '01-langue-audio', [
    { loc: page.locator('[data-set-cat="audio"]'), label: L('Audio', 'Audio'), n: 1, place: 'right' },
    { loc: audio, label: L('Langue audio principale', 'Main audio language'), n: 2, place: 'below' },
    { loc: page.locator('[data-set-pref="lang-audio2"]'), label: L('Si elle manque', 'If it’s missing'), n: 3, place: 'below' },
  ]);
  await audio.selectOption('fr').catch(() => {});
  await page.locator('[data-set-pref="lang-audio2"]').selectOption({ index: 0 }).catch(() => {});
  const subsSw = page.locator('[data-set-pref="lang-subs"]');
  await scrollTo(s, subsSw, 'center', 700);
  if ((await subsSw.getAttribute('aria-checked')) === 'false') await click(s, subsSw, 700);
  const subs = page.locator('[data-set-pref="lang-subtitles"]');
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '02-sous-titres', [
    { loc: rowOf(subsSw), label: L('Sous-titres quand l’audio n’est pas dans ta langue', 'Subtitles when the audio isn’t in your language'), n: 1, place: 'above' },
    { loc: subs, label: L('Langue des sous-titres', 'Subtitle language'), n: 2, place: 'below' },
  ]);
  const anime = page.locator('[data-set-pref="anime-on"]');
  await scrollTo(s, anime, 'center', 700);
  await parkCursor(s);
  await snap(s, '03-anime', [{ loc: rowOf(anime), label: L('Réglages à part pour les animes', 'Separate settings for anime'), place: 'above' }]);
};

SCENARIOS['lecture-confort'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  await openSettings(s);
  await settingsCat(s, 'playback');
  await parkCursor(s);
  await snap(s, '01-lancement', [
    { loc: page.locator('[data-set-cat="playback"]'), label: L('Lecture', 'Playback'), n: 1, place: 'right' },
    { loc: rowOf(page.locator('[data-set-pref="autoplay"]')), label: L('Lancer la meilleure source', 'Start the best source'), n: 2, place: 'below' },
  ]);
  const res = page.locator('[data-set-pref="max-resolution"]');
  await scrollTo(s, res, 'center', 800);
  await parkCursor(s);
  await snap(s, '02-qualite', [
    { loc: res, label: L('Résolution maximale', 'Maximum resolution'), n: 1, place: 'below' },
    { loc: page.locator('[data-set-pref="bandwidth"]'), label: L('Débit de ta connexion', 'Your connection speed'), n: 2, place: 'below' },
  ]);
  const intro = page.locator('[data-set-pref="skip-intro"]');
  await scrollTo(s, intro, 'center', 800);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '03-series', [
    { loc: rowOf(intro), label: L('Passer l’intro', 'Skip intro'), n: 1, place: 'above' },
    { loc: rowOf(page.locator('[data-set-pref="skip-next"]')), label: L('Épisode suivant automatique', 'Play next episode automatically'), n: 2, place: 'below' },
  ]);
  const buf = page.locator('[data-set-pref="buffer-level"]');
  await scrollTo(s, buf, 'center', 700);
  await parkCursor(s);
  await snap(s, '04-tampon', [{ loc: buf, label: L('Plus de mémoire tampon si ça saccade', 'More buffer if playback stutters'), place: 'below' }]);
};

SCENARIOS['nettoyer-recommandations'] = async (s) => {
  const { page } = s;
  s.clip.start = now(s);
  const tile = page.locator('.row .tile').first();
  await scrollTo(s, tile, 'center', 900);
  await tile.hover();
  await sleep(700);
  const more = tile.locator('.t-more');
  await click(s, more, 700);
  await parkCursor(s);
  await snap(s, '01-ne-plus-proposer', [{ loc: page.locator('.ctxmenu [data-ctx="hide"]'), label: L('Ne plus proposer', 'Don’t suggest again'), place: 'right' }]);
  await click(s, page.locator('.ctxmenu [data-ctx="hide"]'), 1500);
  await goTo(s, '#/movie/1004', '[data-fiche-more]');
  await parkCursor(s);
  await snap(s, '02-plus-actions', [{ loc: page.locator('[data-fiche-more]'), label: L('Plus d’actions', 'More actions'), place: 'right' }]);
  await click(s, page.locator('[data-fiche-more]'), 700);
  await parkCursor(s);
  await snap(s, '03-depuis-la-fiche', [{ loc: page.locator('.ctxmenu [data-ctx="hide"]'), label: L('Ne plus proposer sur l’accueil', 'Don’t suggest on Home'), place: 'right' }]);
  await click(s, page.locator('.ctxmenu [data-ctx="hide"]'), 1200);
  await page.keyboard.press('Escape').catch(() => {});
  await openSettings(s);
  await settingsCat(s, 'home');
  const hidden = page.locator('[data-home-hidden]');
  await scrollTo(s, hidden, 'center', 700);
  const genre = page.locator('[data-ban-genre="27"]');
  await click(s, genre, 900);
  await parkCursor(s);
  s.clip.end = now(s);
  await snap(s, '04-reglages-accueil', [
    { loc: hidden, label: L('Titres masqués : « Gérer » pour les remettre', 'Hidden titles: “Manage” to bring them back'), n: 1, place: 'above' },
    { loc: genre, label: L('Un genre à ne jamais proposer', 'A genre never to suggest'), n: 2, place: 'below' },
  ]);
};

const GUIDES = {
  'creer-un-profil': { en: 'create-a-profile', poster: '03-nom-couleur' },
  'profil-enfant': { en: 'kids-profile', poster: '01-case-enfant' },
  'ajouter-une-source': { en: 'add-a-source', poster: '03-url-addon' },
  'tv-en-direct': { en: 'live-tv', poster: '02-formulaire' },
  'inviter-un-proche': { en: 'invite-someone', poster: '03-billet', backend: 'worker' },
  'importer-stremio': { en: 'import-from-stremio', poster: '04-apercu', backend: 'worker', stremio: true },
  'ajouter-des-amis': { en: 'add-friends', poster: '03-ajouter', backend: 'worker' },
  'watch-party': { en: 'watch-party', poster: '05-salon-attente', backend: 'worker' },
  'partager-sa-bibliotheque': { en: 'share-your-library', poster: '02-oeil', backend: 'worker' },
  'sous-titres-et-langues': { en: 'subtitles-and-languages', poster: '01-langue-audio' },
  'lecture-confort': { en: 'playback-comfort', poster: '03-series' },
  'nettoyer-recommandations': { en: 'clean-up-recommendations', poster: '01-ne-plus-proposer' },
};

/** Faux compte Stremio (guide d'import) : connexion acceptée, bibliothèque de titres du catalogue factice. Lecture seule. */
const STREMIO_LIBRARY = [
  [1001, 'movie', 'Les Gardiens du phare', { timesWatched: 1, flaggedWatched: 1 }],
  [1003, 'movie', 'Le Dernier Cartographe', { timeOffset: 2_400_000, duration: 7_080_000 }],
  [1004, 'movie', 'Nuit polaire', {}],
  [1019, 'movie', 'La Maison des brumes', { timesWatched: 1, flaggedWatched: 1 }],
  [2002, 'series', 'Station Orion', {}],
  [2005, 'series', 'Ruelles de Lyon', {}],
];
function stremioResponse(pathname) {
  const method = pathname.split('/').pop();
  const now = Date.now();
  const result = method === 'login' ? { authKey: 'guide-auth-key', user: { email: 'camille@example.com' } }
    : method === 'datastoreGet' ? STREMIO_LIBRARY.map(([id, type, name, st], i) => ({
      _id: `tmdb:${id}`, type, name, removed: false, temp: false, _ctime: new Date(now - (i + 2) * 86_400_000).toISOString(),
      _mtime: new Date(now - (i + 1) * 86_400_000).toISOString(),
      state: { lastWatched: new Date(now - (i + 1) * 86_400_000).toISOString(), timeOffset: 0, duration: 0, timesWatched: 0, flaggedWatched: 0, ...st },
    }))
    : method === 'addonCollectionGet' ? { addons: [] }
    : {};
  return { status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' }, body: JSON.stringify({ result }) };
}

/** Catalogue factice, hôtes extérieurs bloqués, app pointée sur l'API locale, traduction anglaise. Renvoie les hôtes bloqués. */
async function prepareContext(context, lang, { stremio = false } = {}) {
  const blocked = new Set();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (stremio && url.hostname === 'api.strem.io') return route.fulfill(stremioResponse(url.pathname));
    if (url.hostname === 'image.tmdb.org') {
      return route.fulfill({ status: 200, contentType: 'image/webp', headers: { 'access-control-allow-origin': '*' }, body: posterBuffer(url.pathname) });
    }
    if (isLocalHost(url.hostname)) {
      const mock = catalogResponse(url.pathname, url.searchParams);
      if (mock) {
        const body = mock.body && mock.body.videos ? { ...mock.body, videos: { results: [] } } : mock.body;
        return route.fulfill({ status: mock.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
      }
      return route.continue();
    }
    if (FONT_HOSTS.has(url.hostname)) return route.continue();
    blocked.add(url.host);
    return route.abort();
  });
  await context.addInitScript(({ key, value, ak }) => {
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      if (localStorage.getItem(ak) === null) localStorage.setItem(ak, '0');
    } catch { /* stockage indisponible */ }
  }, { key: SETTINGS_KEY, value: JSON.stringify({ base: API_URL, mode: 'custom', custom: API_URL, config: '' }), ak: AUTOPLAY_KEY });
  if (lang === 'en') await context.addInitScript(translatorScript, { text: EN_TEXT, patterns: EN_PATTERNS, contexts: EN_CONTEXT });
  return blocked;
}

/**
 * Second compte (« Léo ») dans un autre contexte du même navigateur, sans vidéo : pour les guides à deux (amis, watch party).
 * Renvoie { page, handle (Nom#TAG), close() }.
 */
async function secondAccount(s, name = 'Léo') {
  const creds = { username: 'leo', password: 'guides-' + Math.random().toString(36).slice(2, 12) };
  await register(creds);
  const context = await s.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: s.lang === 'en' ? 'en-US' : 'fr-FR' });
  await prepareContext(context, s.lang);
  const page = await context.newPage();
  const s2 = { page, lang: s.lang };
  await bootstrap(s2, creds, name);
  await page.locator('.ss-handle, [data-social-toggle], [aria-label*="Amis"]').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  return { page, close: () => context.close() };
}

// ---------- Exécution d'un guide dans une langue ----------
async function runGuide(chromium, id, lang) {
  const dir = join(OUT, lang, id);
  const tmp = join(WORK, `${lang}-${id}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(dir, 'img'), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const api = await startApi(join(tmp, 'data'), GUIDES[id].backend);
  let browser = null;
  const report = [`## ${lang}/${id}`];
  try {
    await register();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      locale: lang === 'en' ? 'en-US' : 'fr-FR',
      permissions: ['clipboard-read', 'clipboard-write'],
      recordVideo: { dir: join(tmp, 'video'), size: VIEWPORT },
    });
    const blocked = await prepareContext(context, lang, { stremio: !!GUIDES[id].stremio });
    await context.addInitScript(CURSOR_SCRIPT);
    const page = await context.newPage();
    const s = { page, browser, lang, tmp, marks: {}, clip: {}, shots: [], cursor: { x: 640, y: 400 }, t0: Date.now(), errors: [], untranslated: [], debug: [] };
    page.on('pageerror', (e) => s.errors.push(e.message));
    const videoPromise = page.video();
    try {
      await bootstrap(s);
      await SCENARIOS[id](s);
      s.clip.end ??= now(s);
    } catch (err) {
      await page.screenshot({ path: join(tmp, 'echec.png') }).catch(() => {});
      throw err;
    } finally {
      await context.close();
    }
    if (s.debug.length) writeFileSync(join(tmp, 'debug.txt'), s.debug.join('\n\n'));
    for (const sh of s.shots) {
      const annotated = join(tmp, `${sh.name}-ann.png`);
      await annotate(browser, sh, annotated);
      const a = toWebp(annotated, join(dir, 'img', `${sh.name}.webp`), 2560, MAX_IMG.full);
      const b = toWebp(annotated, join(dir, 'img', `${sh.name}-1280.webp`), 1280, MAX_IMG.small);
      report.push(`img/${sh.name}.webp ${a.kb} Ko, -1280 ${b.kb} Ko`);
    }
    const poster = s.shots.find((x) => x.name === GUIDES[id].poster) ?? s.shots[0];
    runFfmpeg(['-i', poster.png, '-frames:v', '1', '-vf', 'scale=1280:-2:flags=lanczos', '-c:v', 'libwebp', '-quality', '80', join(dir, 'img', 'poster.webp')]);
    runFfmpeg(['-i', join(tmp, `${poster.name}-ann.png`), '-frames:v', '1', '-vf', 'scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630', '-q:v', '4', join(dir, 'img', 'og.jpg')]);
    const videoFile = await videoPromise.path();
    const from = Math.max(0, s.clip.start - 0.2);
    let dur = s.clip.end + 0.4 - from;
    const speed = dur > MAX_CLIP_SEC ? dur / MAX_CLIP_SEC : 1;
    runFfmpeg(['-ss', from.toFixed(2), '-i', videoFile, '-t', dur.toFixed(2), ...(speed > 1 ? ['-vf', `setpts=PTS/${speed.toFixed(3)}`] : []),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(dir, 'clip.mp4')]);
    report.push(`clip.mp4 ${Math.round(statSync(join(dir, 'clip.mp4')).size / 1024)} Ko, ${(dur / speed).toFixed(1)} s`);
    if (blocked.size) report.push(`hôtes bloqués : ${[...blocked].join(', ')}`);
    if (s.errors.length) report.push(`erreurs de page : ${s.errors.length} (ex. ${s.errors[0].slice(0, 160)})`);
    if (s.untranslated.length) report.push('NON TRADUIT :', ...[...new Set(s.untranslated)].map((t) => '  ' + t));
    return report;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopApi(api);
  }
}

/** Copie les sorties relues dans public/ : FR dans guides/<id>/, EN dans en/guides/<slug anglais>/. */
function install() {
  for (const lang of ['fr', 'en']) {
    const base = join(OUT, lang);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const dest = lang === 'fr' ? join(SITE_PUBLIC, 'guides', id) : join(SITE_PUBLIC, 'en', 'guides', GUIDES[id].en);
      mkdirSync(dest, { recursive: true });
      rmSync(join(dest, 'img'), { recursive: true, force: true });
      cpSync(join(base, id, 'img'), join(dest, 'img'), { recursive: true });
      cpSync(join(base, id, 'clip.mp4'), join(dest, 'clip.mp4'));
      console.log(`${lang}/${id} -> ${dest}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--install')) return install();
  const li = args.indexOf('--lang');
  const langs = li >= 0 ? [args[li + 1]] : ['fr', 'en'];
  const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');
  const wanted = ids.length ? ids : Object.keys(GUIDES);
  if (!isLocalHost(new URL(APP_URL).hostname)) throw new Error('CAPTURE_APP_URL doit pointer sur localhost');
  if (!(await up(APP_URL))) throw new Error(`l'app ne répond pas sur ${APP_URL}`);
  mkdirSync(WORK, { recursive: true });
  // CAPTURE_PLAYWRIGHT : chemin d'un autre paquet playwright (ex. celui préinstallé avec ses navigateurs et son ffmpeg).
  const { chromium } = createRequire(join(APP_DIR, 'package.json'))(process.env.CAPTURE_PLAYWRIGHT || 'playwright');
  const addon = await startExampleAddon();
  const tv = await startExampleTv();
  const report = [];
  try {
    for (const id of wanted) for (const lang of langs) report.push(...await runGuide(chromium, id, lang));
  } finally {
    addon.close();
    await tv.close();
  }
  console.log(report.join('\n'));
}

main().then(() => process.exit(0), (err) => { console.error(`ECHEC : ${err.stack || err.message}`); process.exit(1); });
