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
import { EN_TEXT, EN_PATTERNS } from './i18n-en.mjs';

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

async function startApi(dataDir) {
  if (await up(`${API_URL}/user/me`)) throw new Error(`${API_URL} répond déjà : arrête l'API existante`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(API_PORT), LASTADDON_DATA_DIR: dataDir, LASTADDON_SECRET: 'capture-guides-' + 'x'.repeat(32), LASTADDON_ALLOWED_ORIGINS: APP_URL },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API arrêtée au démarrage : ${err.slice(-400)}`);
    if (await up(`${API_URL}/user/me`)) return child;
    await sleep(300);
  }
  child.kill('SIGTERM');
  throw new Error('API lastAddon non joignable après 60 s');
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
}

async function register() {
  const res = await fetch(`${API_URL}/user/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CREDS) });
  if (res.status !== 201) throw new Error(`/user/register a répondu ${res.status}`);
}

// ---------- Traduction de l'interface (anglais) ----------
// Injecté dans la page : remplace les textes et attributs connus, au chargement puis à chaque changement du DOM.
function translatorScript({ text, patterns }) {
  const dict = new Map(Object.entries(text));
  const pats = patterns.map(([re, to]) => [new RegExp(re), to]);
  const norm = (s) => s.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  const tr = (raw) => {
    const key = norm(raw);
    if (!key) return null;
    if (dict.has(key)) return dict.get(key);
    for (const [re, to] of pats) if (re.test(key)) return key.replace(re, to);
    return null;
  };
  const fixNode = (n) => {
    const out = tr(n.nodeValue);
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
      if (k && /[a-zà-ÿ]{2}/i.test(k) && !dict.has(k) && !Object.values(text).includes(k)) seen.add(k);
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
async function bootstrap(s) {
  const { page } = s;
  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  const form = page.locator('#auth-form');
  await form.waitFor({ state: 'visible', timeout: 30_000 });
  await form.locator('input[name="username"]').fill(CREDS.username);
  await form.locator('input[name="password"]').fill(CREDS.password);
  await form.locator('button[type="submit"]').click();
  const add = page.locator('[data-pf-add]');
  await add.first().waitFor({ state: 'visible', timeout: 30_000 });
  await add.first().click();
  const editor = page.locator('form.pf-editor');
  await editor.waitFor({ state: 'visible' });
  await editor.locator('input[name="name"]').fill('Camille');
  await editor.locator('button[type="submit"]:visible').first().click();
  const pf = page.locator('.pf', { hasText: 'Camille' });
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

const GUIDES = {
  'creer-un-profil': { en: 'create-a-profile', poster: '03-nom-couleur' },
  'profil-enfant': { en: 'kids-profile', poster: '01-case-enfant' },
  'ajouter-une-source': { en: 'add-a-source', poster: '03-url-addon' },
  'tv-en-direct': { en: 'live-tv', poster: '02-formulaire' },
};

// ---------- Exécution d'un guide dans une langue ----------
async function runGuide(chromium, id, lang) {
  const dir = join(OUT, lang, id);
  const tmp = join(WORK, `${lang}-${id}`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(dir, 'img'), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const api = await startApi(join(tmp, 'data'));
  let browser = null;
  const report = [`## ${lang}/${id}`];
  try {
    await register();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      locale: lang === 'en' ? 'en-US' : 'fr-FR',
      recordVideo: { dir: join(tmp, 'video'), size: VIEWPORT },
    });
    const blocked = new Set();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
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
    if (lang === 'en') await context.addInitScript(translatorScript, { text: EN_TEXT, patterns: EN_PATTERNS });
    await context.addInitScript(CURSOR_SCRIPT);
    const page = await context.newPage();
    const s = { page, lang, tmp, marks: {}, clip: {}, shots: [], cursor: { x: 640, y: 400 }, t0: Date.now(), errors: [], untranslated: [], debug: [] };
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
