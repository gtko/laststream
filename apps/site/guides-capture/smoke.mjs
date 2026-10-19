// Smoke test headless : l'app Laststream (Vite, port 8080) connectée à une API lastAddon locale (port 7000).
// Connexion avec un compte de test, puis capture de l'écran « Qui regarde ? » et d'une vidéo (1280x800).
//
// Usage : voir README.md. Navigateur toujours headless. Refuse toute adresse non locale et bloque toute requête
// vers un autre hôte que localhost (aucun appel vers la production).
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// laststream-site/guides-capture -> laststream/laststream-app (Playwright est dans ses devDependencies).
const APP_DIR = resolve(here, '..', '..', 'laststream-app');
const OUT = join(here, 'out');
const ENV_FILE = join(here, '.env.test');
const APP_URL = (process.env.SMOKE_APP_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const API_URL = (process.env.SMOKE_API_URL ?? 'http://localhost:7000').replace(/\/+$/, '');
const VIEWPORT = { width: 1280, height: 800 };
// Clé de stockage des réglages serveur (SETTINGS_STORAGE_KEY dans src/data/config.ts). Surcharge posée par le test
// dans le navigateur de test : le code de l'app n'est pas modifié et aucune variable d'environnement Vite n'est requise.
const SETTINGS_KEY = 'laststream.lastaddon';

function isLocalHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

function assertLocal(raw, label) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} : protocole non supporté`);
  if (!isLocalHost(url.hostname)) throw new Error(`${label} doit pointer sur localhost (refus de cibler un hôte distant)`);
}

/** Lit SMOKE_USERNAME / SMOKE_PASSWORD dans .env.test ; le crée avec des valeurs générées s'il n'existe pas. */
function loadCredentials() {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, [
      '# Identifiants de test générés par smoke.mjs (compte local uniquement). Ne pas commiter.',
      `SMOKE_USERNAME=smoke${randomBytes(3).toString('hex')}`,
      `SMOKE_PASSWORD=${randomBytes(18).toString('base64url')}`,
      '',
    ].join('\n'), { mode: 0o600 });
    console.log('.env.test créé avec des identifiants de test générés (valeurs non affichées).');
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
    });
    return { status: res.status, error: (await res.json().catch(() => ({}))).error };
  } catch {
    throw new Error(`API lastAddon injoignable sur ${API_URL} : lance-la (voir README)`);
  }
}

/**
 * Garantit le compte de test sur l'API locale : connexion si le compte existe, sinon inscription (seul le premier
 * compte d'un stockage vierge s'inscrit sans lien). Le serveur refuse l'inscription d'un nom déjà pris (403) avant
 * de le signaler, donc on se connecte d'abord.
 */
async function ensureAccount(creds) {
  const login = await postJson('/user/login', creds);
  if (login.status === 200) return 'compte de test présent';
  if (login.status !== 401) throw new Error(`/user/login a répondu ${login.status}${login.error ? ` (${login.error})` : ''} (voir README)`);
  const reg = await postJson('/user/register', creds);
  if (reg.status === 201) return 'compte de test créé';
  throw new Error(`/user/register a répondu ${reg.status}${reg.error ? ` (${reg.error})` : ''} : mot de passe de .env.test différent du compte existant, ou stockage non vierge. Supprime guides-capture/.smoke-data et relance l'API (voir README)`);
}

async function main() {
  assertLocal(APP_URL, 'SMOKE_APP_URL');
  assertLocal(API_URL, 'SMOKE_API_URL');
  mkdirSync(OUT, { recursive: true });

  const creds = loadCredentials();
  console.log(`${await ensureAccount(creds)}.`);

  // Playwright vient de laststream-app/node_modules (pas de npm install dans guides-capture).
  const { chromium } = createRequire(join(APP_DIR, 'package.json'))('playwright');
  const browser = await chromium.launch({ headless: true });
  const videoTmp = join(OUT, '.video-tmp');
  rmSync(videoTmp, { recursive: true, force: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'fr-FR',
    recordVideo: { dir: videoTmp, size: VIEWPORT },
  });

  const blocked = new Set();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || isLocalHost(url.hostname)) return route.continue();
    blocked.add(url.host);
    return route.abort();
  });

  await context.addInitScript(({ key, value }) => {
    try {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    } catch (_) { /* stockage indisponible : l'app demandera le serveur */ }
  }, { key: SETTINGS_KEY, value: JSON.stringify({ base: API_URL, mode: 'custom', custom: API_URL, config: '' }) });

  const page = await context.newPage();
  const video = page.video();
  let failure = null;
  try {
    await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
    const form = page.locator('#auth-form');
    await form.waitFor({ state: 'visible', timeout: 30_000 });
    await form.locator('input[name="username"]').fill(creds.username);
    await form.locator('input[name="password"]').fill(creds.password);
    await form.locator('button[type="submit"]').click();

    await page.locator('h1.auth-title', { hasText: 'Qui regarde ?' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'smoke-qui-regarde.png') });
    await page.waitForTimeout(1000);
  } catch (err) {
    failure = err;
    await page.screenshot({ path: join(OUT, 'smoke-echec.png') }).catch(() => {});
  }

  // Fermer le contexte finalise la vidéo ; on la copie ensuite vers out/smoke.webm.
  await context.close();
  await browser.close();
  const recorded = await video?.path().catch(() => null);
  if (recorded && existsSync(recorded)) copyFileSync(recorded, join(OUT, 'smoke.webm'));
  rmSync(videoTmp, { recursive: true, force: true });

  if (blocked.size > 0) console.log(`requêtes vers d'autres hôtes bloquées : ${[...blocked].join(', ')}`);
  if (failure) throw failure;
  console.log('OK : écran « Qui regarde ? » affiché.');
  console.log(`  capture : ${join(OUT, 'smoke-qui-regarde.png')}`);
  console.log(`  vidéo   : ${join(OUT, 'smoke.webm')}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`ECHEC : ${err.message}`);
    process.exit(1);
  },
);
