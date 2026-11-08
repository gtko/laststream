// Test e2e headless de la watch party v1 : le vrai salon lastaddon (wrangler dev, depuis LASTADDON_DIR), un hôte simulé
// (page harnais party/host.ts : PartyClient + HostRelaySession sur un clip H.264 + AAC servi en HTTP Range) et des invités qui
// utilisent la VRAIE page invitée de l'application (#/party/join/<id>?t=<jeton>, servie par Vite depuis ce dépôt).
//
// Contrôles :
//   (a) entrée d'un invité pendant la lecture : le salon se met en pause, `wait` liste son pseudo, « En attente de <pseudo>… »
//       est affiché sur sa page, et la lecture reprend seule quand son tampon atteint le seuil (45 s au plus) ;
//   (b) chat dans les deux sens (l'invité écrit -> l'hôte reçoit ; l'hôte écrit -> l'invité voit), texte HTML échappé ;
//   (c) plein écran disponible (document.fullscreenEnabled, bouton présent, clic et touche F sans erreur) ;
//   (d) pause manuelle pendant l'attente : une fois l'attente terminée, la lecture n'est pas relancée ;
//   (e) réactions en direct (LAST-1621) : une réaction envoyée par une page apparaît chez l'autre en moins de 2 s sous forme
//       d'élément flottant visible (page invitée, et panneau du lecteur src/ui/partypanel.js branché sur un vrai PartyClient
//       via party/live.html) ; l'émetteur voit aussi sa propre réaction. Le lecteur vidéo complet n'est pas lancé : seuls le
//       panneau, le bridge et le client du salon le sont.
// Captures (--shots <dossier>) : commandes, infos « i », sous-titres, chat, bandeau d'attente, plein écran (invité) et panneau hôte
// (page harnais party/panel.ts avec données factices).
//
// Usage : LASTADDON_DIR=<worktree lastaddon> node scripts/relay-e2e/party.mjs [--shots <dossier>]
//   ou : npm run relay:e2e:party -- --shots <dossier>   (LASTADDON_DIR doit être défini dans l'environnement)
// Sécurité : aucune URL ni jeton n'est imprimé (masqués). Les secrets de `.dev.vars` sont aléatoires ; le fichier est créé pour le
// test et supprimé à la fin. Seuls les processus lancés ici sont arrêtés. Headless uniquement : aucune fenêtre visible.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '..', '..');
const lastaddon = process.env.LASTADDON_DIR ? resolve(process.env.LASTADDON_DIR) : '';
if (!lastaddon || !existsSync(join(lastaddon, 'wrangler.test.jsonc'))) {
  console.error('LASTADDON_DIR doit pointer vers un worktree lastaddon (wrangler.test.jsonc introuvable).');
  process.exit(2);
}
const argv = process.argv.slice(2);
const shotsAt = argv.indexOf('--shots');
if (shotsAt >= 0 && !argv[shotsAt + 1]) {
  console.error('--shots exige un dossier de sortie.');
  process.exit(2);
}
const SHOTS = shotsAt >= 0 ? resolve(argv[shotsAt + 1]) : '';

const WRANGLER_PORT = 8792;
const VITE_PORT = 5194;
const CLIP_PORT = 5195;
const API = `http://127.0.0.1:${WRANGLER_PORT}`;
const WS = `ws://127.0.0.1:${WRANGLER_PORT}`;
const ORIGIN = `http://127.0.0.1:${VITE_PORT}`;
const CLIP_BASE = `http://127.0.0.1:${CLIP_PORT}`;
const CLIP_URL = `${CLIP_BASE}/clip.mp4`;
const LAUNCH_ARGS = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const VIEWPORT = { width: 1280, height: 720 };
const WAIT_LIMIT_MS = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Masque URL et jetons avant toute impression. */
function redact(text) {
  return String(text)
    .replace(/(?:https?|wss?):\/\/[^\s'")]+/gi, '<url masquée>')
    .replace(/([?&]t=)[^&\s'")]+/g, '$1***')
    .replace(/(sessionToken|token)(["']?\s*[:=]\s*["']?)[^\s,'"}]+/gi, '$1$2***');
}
const log = (msg) => console.log(redact(msg));

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${detail ? ` : ${detail}` : ''}`);
}

const secret = () => randomBytes(24).toString('hex');
const ADMIN = secret();
const PASSWORD = `pw-${secret()}`;
const devVars = join(lastaddon, '.dev.vars');
const tmp = mkdtempSync(join(tmpdir(), 'party-e2e-'));
const persist = join(tmp, 'state');
const clipPath = join(tmp, 'clip.mp4');
const shots = [];
const pageErrors = [];
/** Trames « buf » envoyées par les invités (tampon annoncé au salon), pour le diagnostic. */
const bufTrace = [];
const t0 = Date.now();
/** Chronologie (secondes depuis le début) : connexions des invités et changements de lecture / d'attente vus par l'hôte. */
const timeline = [];
const note = (text) => timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)} ${text}`);
let wrangler = null;
let vite = null;
let clipServer = null;
let browser = null;
let wranglerLog = '';

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function cleanup() {
  await browser?.close().catch(() => undefined);
  if (clipServer) {
    clipServer.closeAllConnections?.();
    await new Promise((r) => clipServer.close(() => r()));
  }
  await vite?.close().catch(() => undefined);
  killTree(wrangler);
  rmSync(devVars, { force: true });
  await sleep(1500);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    log('dossier temporaire conservé (fichiers encore ouverts)');
  }
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg a échoué : ${r.error?.message ?? r.stderr}`);
}

/** Clip de 60 s en H.264 + AAC, généré localement (aucun téléchargement). */
function makeClip() {
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=60:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', clipPath,
  ]);
}

/** Serveur du clip : HTTP Range et CORS (la page hôte lit le clip par plages). */
function serveClip() {
  return new Promise((resolveServe, reject) => {
    const server = createHttpServer((req, res) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'range');
      res.setHeader('access-control-expose-headers', 'content-range, content-length, accept-ranges');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const size = statSync(clipPath).size;
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-type', 'video/mp4');
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (!m) {
        res.writeHead(200, { 'content-length': size });
        if (req.method === 'HEAD') res.end();
        else createReadStream(clipPath).pipe(res);
        return;
      }
      let start;
      let end;
      if (m[1] === '') {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') res.end();
      else createReadStream(clipPath, { start, end }).pipe(res);
    });
    server.once('error', reject);
    server.listen(CLIP_PORT, '127.0.0.1', () => resolveServe(server));
  });
}

async function api(method, path, { token, body, headers } = {}) {
  const h = { 'x-forwarded-for': '10.1.2.3', ...(headers ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function startWrangler() {
  writeFileSync(devVars, `LASTADDON_SECRET=${secret()}\nRANGE_SECRET=${secret()}\nADMIN_SECRET=${ADMIN}\nLASTADDON_ALLOWED_ORIGINS=${ORIGIN}\n`);
  const bin = join(lastaddon, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  wrangler = spawn(process.execPath, [bin, 'dev', '-c', 'wrangler.test.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(WRANGLER_PORT), '--persist-to', persist], {
    cwd: lastaddon,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  wrangler.stdout.on('data', (d) => (wranglerLog += d));
  wrangler.stderr.on('data', (d) => (wranglerLog += d));
  for (let i = 0; i < 120; i += 1) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler s'est arrêté : ${redact(wranglerLog).slice(-400)}`);
    try {
      await fetch(`${API}/party/x`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`wrangler dev ne répond pas : ${redact(wranglerLog).slice(-400)}`);
}

/** Compte hôte, profil, salon, et adresse WebSocket de l'hôte. */
async function makeRoom() {
  const invite = await api('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  if (invite.status !== 200) throw new Error(`invitation système refusée (${invite.status})`);
  const name = `hote${Math.floor(Math.random() * 1e6)}`;
  const reg = await api('POST', '/user/register', { body: { username: name, password: PASSWORD, invite: invite.body.code } });
  if (reg.status !== 201) throw new Error(`inscription refusée (${reg.status})`);
  const login = await api('POST', '/user/login', { body: { username: name, password: PASSWORD } });
  const token = login.body.token;
  const profile = await api('POST', '/user/profiles', { token, body: { name, avatarColor: '#aa5500' } });
  const room = await api('POST', '/party', {
    token,
    body: { profileId: profile.body.id, visibility: 'private', title: 'Clip de test', media: { type: 'movie', tmdbId: 603 } },
  });
  if (room.status !== 201) throw new Error(`salon refusé (${room.status})`);
  const id = room.body.room.id;
  const join = await api('POST', `/party/${id}/join`, { token, body: { profileId: profile.body.id } });
  return { id, token, profile: profile.body.id, hostWs: `${WS}${join.body.wsPath}` };
}

/** Adresse de la page invitée (#/party/join/<id>?t=<jeton>) pour un nouvel invité. */
async function inviteUrl(room) {
  const inv = await api('POST', `/party/${room.id}/invite-link`, { token: room.token, body: { profileId: room.profile } });
  if (inv.status !== 201) throw new Error(`lien d’invitation refusé (${inv.status})`);
  return `${ORIGIN}/#/party/join/${encodeURIComponent(room.id)}?t=${encodeURIComponent(inv.body.token)}`;
}

/** Premier navigateur qui décode H.264 (Chrome système, sinon Chromium de Playwright). */
async function launch() {
  for (const channel of ['chrome', undefined]) {
    let b;
    try {
      b = await chromium.launch({ headless: true, channel, args: LAUNCH_ARGS });
    } catch (e) {
      log(`navigateur ${channel ?? 'chromium'} indisponible : ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const page = await b.newPage();
    await page.goto(`${ORIGIN}/scripts/relay-e2e/party/probe.html`);
    const avc = await page.evaluate(async () => {
      try {
        return (await VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })).supported === true;
      } catch {
        return false;
      }
    });
    await page.close();
    if (avc) return { browser: b, label: channel ?? 'chromium (Playwright)' };
    await b.close();
  }
  throw new Error('aucun navigateur ne décode H.264');
}

/** Dans la page invitée : journal des bandeaux « En attente de… » affichés (même s'ils disparaissent ensuite). */
const WAIT_RECORDER = () => {
  window.__waitLog = [];
  const read = () => {
    const t = document.querySelector('.gp-wait:not([hidden]) .gp-wait-t');
    const s = t && t.textContent ? t.textContent.trim() : '';
    if (s && window.__waitLog[window.__waitLog.length - 1] !== s) window.__waitLog.push(s);
  };
  new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  read();
};
/** Vrai quand les commandes du lecteur invité sont actives (lecteur prêt). */
const PLAYER_READY = () => {
  const play = document.querySelector('[data-gp="play"]');
  const player = document.querySelector('[data-pj-player]');
  return !!play && !play.disabled && !!player && !player.hidden;
};

/** Ouvre la page invitée de l'application dans un contexte isolé, saisit le pseudo et rejoint le salon. */
async function openGuest(who, url) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await ctx.addInitScript((settings) => {
    try {
      localStorage.setItem('laststream.lastaddon', settings);
      localStorage.setItem('ls.debug', '1');
    } catch {
      // stockage bloqué : la page reste utilisable
    }
  }, JSON.stringify({ base: API, config: 'e2e', mode: 'custom', custom: API }));
  // Pas de réseau externe (polices, affiches) : seules l'application locale et le clip local répondent.
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith(API) || u.startsWith(CLIP_BASE) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${redact(e.message)}`));
  page.on('console', (m) => {
    // Les requêtes externes bloquées (polices, affiches) journalisent « Failed to load resource » : sans effet ici.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(`${who} console: ${redact(m.text())}`);
  });
  page.on('dialog', (d) => d.dismiss());
  page.on('websocket', (ws) => {
    note(`${who} : connexion au salon`);
    ws.on('close', () => note(`${who} : connexion fermée`));
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"t":"buf"')) bufTrace.push(`${who} ${f.payload.slice(0, 70)}`);
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pj-join]', { state: 'visible', timeout: 60000 });
  await page.evaluate(WAIT_RECORDER);
  await page.fill('.pj-form input[name="name"]', who);
  await page.click('[data-pj-join]');
  return { ctx, page, who };
}

async function shot(page, file) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, file);
  await page.screenshot({ path, type: 'png' });
  const b = readFileSync(path);
  shots.push({ file, w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length });
}

/** Réaffiche les commandes (elles s'effacent après un moment de lecture sans souris). */
async function wakeControls(page) {
  const box = await page.locator('.gp').boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
async function clickControl(page, selector) {
  await wakeControls(page);
  await page.click(selector);
}

let lastHostKey = '';
const watch = setInterval(async () => {
  if (!hostPage || hostPage.isClosed()) return;
  const v = await hostPage.evaluate(() => ({ p: window.__host.state()?.playing ?? null, w: (window.__host.waiting()?.who ?? []).join(',') })).catch(() => null);
  if (!v) return;
  const key = `${v.p}|${v.w}`;
  if (key !== lastHostKey) {
    lastHostKey = key;
    note(`hôte : ${v.p ? 'lecture' : 'pause'}, attente ${v.w || 'aucune'}`);
  }
}, 250);

/** Panneau hôte rendu par le vrai module (src/ui/partypanel.js) avec un salon factice : participants, attente, lien, chat. */
async function hostPanelShot() {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`panneau: ${redact(e.message)}`));
  await page.goto(`${ORIGIN}/scripts/relay-e2e/party/panel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__panel?.ready === true, null, { timeout: 60000 });
  const info = await page.evaluate(() => window.__panel);
  await shot(page, '07-hote-panneau.png');
  await ctx.close();
  check('p1', 'panneau hôte : participants, bandeau d’attente, lien d’invitation', info.users === 3 && info.waitVisible && info.waitText.includes('Bob') && info.inviteLink.includes('/#/party/join/'),
    `${info.users} participants, attente « ${info.waitText.trim()} »`);
  check('p2', 'panneau hôte : chat affiché en texte (HTML échappé)', info.chatTags === 0 && info.chatText.includes('<b>gras</b>'), `${info.chatTags} balise(s) active(s)`);
}

/** Élément flottant réellement visible : taille non nulle, non transparent, non masqué, dans la fenêtre. */
const VISIBLE_FLOAT = (selector) => {
  return [...document.querySelectorAll(selector)].some((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0
      && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  });
};
/** Attend une condition en page ; renvoie le délai (ms) ou -1 si elle n'arrive pas dans `limit`. */
async function within(page, fn, arg, limit = 2000) {
  const t = Date.now();
  const ok = await page.waitForFunction(fn, arg, { timeout: limit, polling: 25 }).then(() => true, () => false);
  return ok ? Date.now() - t : -1;
}

/** Chemin du WebSocket invité (même forme que guestWsPath de src/party/join.ts). */
const guestWsPath = (roomId, token, name) => `/party/${encodeURIComponent(roomId)}/ws?t=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;

const hostPlaying = (host) => host.evaluate(() => window.__host.state()?.playing === true);

let hostPage = null;
let ana = null;
try {
  makeClip();
  mkdirSync(persist, { recursive: true });
  clipServer = await serveClip();
  vite = await createServer({
    configFile: join(APP, 'vite.config.ts'),
    root: APP,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: VITE_PORT, strictPort: true },
  });
  await vite.listen();
  await startWrangler();
  log('salon lastaddon local prêt (wrangler dev) ; création du salon…');
  const room = await makeRoom();

  const picked = await launch();
  browser = picked.browser;
  log(`navigateur : ${picked.label} ; clip local de 60 s`);
  await hostPanelShot();

  // Hôte simulé : vrai PartyClient et HostRelaySession sur le clip.
  const hostCtx = await browser.newContext({ viewport: { width: 900, height: 420 } });
  hostPage = await hostCtx.newPage();
  hostPage.on('pageerror', (e) => pageErrors.push(`hôte: ${redact(e.message)}`));
  hostPage.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(`hôte console: ${redact(m.text())}`);
  });
  hostPage.on('response', (r) => {
    if (r.status() >= 400) pageErrors.push(`hôte HTTP ${r.status()} : ${redact(r.url())}`);
  });
  await hostPage.goto(`${ORIGIN}/scripts/relay-e2e/party/host.html?${new URLSearchParams({ ws: room.hostWs, media: CLIP_URL })}`);
  await hostPage.waitForFunction(() => window.__host && (window.__host.ready || window.__host.error), null, { timeout: 60000 });
  const hostBoot = await hostPage.evaluate(() => window.__host.error);
  if (hostBoot) throw new Error(`hôte : ${hostBoot}`);
  await hostPage.waitForFunction(() => window.__host.status() === 'open' && window.__host.state() !== null, null, { timeout: 30000 });
  // La lecture est en cours avant l'arrivée de l'invité : son entrée doit donc suspendre le salon.
  await hostPage.evaluate(() => window.__host.play());
  await hostPage.waitForFunction(() => window.__host.state()?.playing === true, null, { timeout: 15000 });
  await sleep(1500);

  // ---- (a) entrée d'un invité pendant la lecture ----
  ana = await openGuest('Ana', await inviteUrl(room));
  await hostPage.waitForFunction(() => (window.__host.waiting()?.who ?? []).includes('Ana'), null, { timeout: 60000, polling: 50 });
  const tWait = Date.now();
  const paused = await hostPage.evaluate(() => window.__host.state()?.playing === false);
  const who = await hostPage.evaluate(() => window.__host.waiting()?.who ?? []);
  check('a1', 'entrée de l’invité : salon en pause, wait liste son pseudo', paused && who.includes('Ana'), `pause ${paused ? 'oui' : 'non'}, attente : ${who.join(', ')}`);
  await ana.page.waitForFunction(PLAYER_READY, null, { timeout: 120000, polling: 200 });
  await ana.page.waitForFunction(() => window.__waitLog.some((s) => s.includes('En attente de Ana')), null, { timeout: 30000, polling: 50 }).catch(() => undefined);
  const banner = await ana.page.evaluate(() => window.__waitLog.find((s) => s.includes('En attente de')) ?? '');
  check('a2', 'bandeau « En attente de <pseudo>… » affiché sur la page invitée', banner.startsWith('En attente de Ana'), banner ? `« ${banner} »` : 'absent');
  await hostPage.waitForFunction(
    () => window.__host.state()?.playing === true && (window.__host.waiting()?.who ?? []).length === 0,
    null,
    { timeout: WAIT_LIMIT_MS + 15000, polling: 200 },
  ).catch(() => undefined);
  const resumed = await hostPage.evaluate(() => window.__host.state()?.playing === true && (window.__host.waiting()?.who ?? []).length === 0);
  const elapsed = Date.now() - tWait;
  // Reprise attendue par le tampon (seuil de 10 s) : une reprise au délai de 45 s signale un tampon qui ne se remplit pas.
  check('a3', 'reprise automatique quand le tampon atteint le seuil', resumed && elapsed < WAIT_LIMIT_MS - 10000,
    `reprise après ${(elapsed / 1000).toFixed(1)} s (${resumed ? 'lecture relancée' : 'lecture toujours en pause'})`);
  await ana.page.waitForFunction(() => document.querySelector('[data-gp="play"]')?.getAttribute('aria-label')?.startsWith('Pause'), null, { timeout: 20000 }).catch(() => undefined);
  const anaPlaying = await ana.page.evaluate(() => document.querySelector('[data-gp="play"]')?.getAttribute('aria-label')?.startsWith('Pause') === true);
  check('a4', 'lecture en cours sur la page invitée après la reprise', anaPlaying && resumed);

  // Commandes visibles pendant la lecture.
  await sleep(500);
  await wakeControls(ana.page);
  await shot(ana.page, '01-invite-lecture-commandes.png');

  // Panneau d'infos « i ».
  await clickControl(ana.page, '[data-gp="info"]');
  await sleep(300);
  await shot(ana.page, '02-infos.png');
  await clickControl(ana.page, '[data-gp="info"]');

  // Sous-titres : piste de test envoyée par l'hôte, menu ouvert.
  await hostPage.evaluate(() => window.__host.setSubtitles([{ id: 'fr', lang: 'fr', label: 'Français', vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:59.000\nSous-titre de test\n' }]));
  await ana.page.waitForFunction(() => {
    const b = document.querySelector('[data-id="subs"]');
    return !!b && !b.hidden;
  }, null, { timeout: 20000 });
  await clickControl(ana.page, '[data-id="subs"]');
  await ana.page.waitForFunction(() => {
    const p = document.querySelector('.gs-pop');
    return !!p && !p.hidden && p.querySelectorAll('.gs-item').length >= 2;
  }, null, { timeout: 10000 });
  await shot(ana.page, '03-sous-titres.png');
  // Fermeture du menu par son bouton : Échap remonte jusqu'au gestionnaire global et quitte la page invitée (voir le rapport).
  await clickControl(ana.page, '[data-id="subs"]');

  // ---- (b) chat dans les deux sens, texte échappé ----
  await clickControl(ana.page, '[data-id="chat"]');
  await ana.page.waitForFunction(() => {
    const d = document.querySelector('.gc');
    return !!d && !d.hidden;
  }, null, { timeout: 10000 });
  await ana.page.fill('.gc-input', 'Bonjour de Ana');
  await ana.page.press('.gc-input', 'Enter');
  const toHost = await hostPage.waitForFunction(() => window.__host.chat().some((l) => l.text === 'Bonjour de Ana'), null, { timeout: 15000 }).then(() => true, () => false);
  check('b1', 'chat : l’invité écrit, l’hôte reçoit', toHost);
  await hostPage.evaluate(() => window.__host.sendChat('Salut Ana'));
  const toGuest = await ana.page.waitForFunction(() => [...document.querySelectorAll('.gc-log .gc-text')].some((e) => e.textContent === 'Salut Ana'), null, { timeout: 15000 }).then(() => true, () => false);
  check('b2', 'chat : l’hôte écrit, l’invité voit le message', toGuest);
  const html = '<img src=x onerror="window.__xss=1"><b>gras</b>';
  await hostPage.evaluate((t) => window.__host.sendChat(t), html);
  const escaped = await ana.page.waitForFunction((t) => [...document.querySelectorAll('.gc-log .gc-text')].some((e) => e.textContent === t), html, { timeout: 15000 }).then(() => true, () => false);
  const inert = await ana.page.evaluate(() => document.querySelectorAll('.gc-log img, .gc-log b').length === 0 && window.__xss === undefined);
  check('b3', 'chat : le HTML reçu est affiché comme texte (échappé)', escaped && inert, escaped ? '' : 'message absent du journal de l’invité');
  await shot(ana.page, '04-chat.png');
  await clickControl(ana.page, '[data-gc="close"]');

  // ---- (c) plein écran ----
  await wakeControls(ana.page);
  const fsAvailable = await ana.page.evaluate(() => ({
    enabled: document.fullscreenEnabled === true,
    button: !!document.querySelector('[data-gp="full"]') && !document.querySelector('[data-gp="full"]').hidden,
  }));
  const errBefore = pageErrors.length;
  await ana.page.click('[data-gp="full"]');
  await sleep(400);
  const fsOn = await ana.page.evaluate(() => document.fullscreenElement !== null);
  await shot(ana.page, '06-plein-ecran.png');
  await ana.page.keyboard.press('f');
  await sleep(300);
  await ana.page.keyboard.press('f');
  await sleep(300);
  if (await ana.page.evaluate(() => document.fullscreenElement !== null)) await ana.page.evaluate(() => document.exitFullscreen?.());
  check('c1', 'plein écran disponible (document.fullscreenEnabled, bouton présent)', fsAvailable.enabled && fsAvailable.button, `fullscreenEnabled=${fsAvailable.enabled}, bouton=${fsAvailable.button}`);
  check('c2', 'plein écran : clic et touche F sans erreur', pageErrors.length === errBefore, `plein écran engagé par le navigateur : ${fsOn ? 'oui' : 'non (headless)'}`);

  // ---- (d) pause manuelle pendant l'attente ----
  if (!(await hostPlaying(hostPage))) {
    await hostPage.evaluate(() => window.__host.play());
    await hostPage.waitForFunction(() => window.__host.state()?.playing === true, null, { timeout: 15000 });
  }
  // Bob arrive pendant la lecture : son attente ouvre, l'hôte met en pause à la main avant la fin de l'attente.
  const bob = await openGuest('Bob', await inviteUrl(room));
  await hostPage.waitForFunction(() => (window.__host.waiting()?.who ?? []).includes('Bob'), null, { timeout: 60000, polling: 20 });
  await hostPage.evaluate(() => window.__host.pause());
  await ana.page.waitForFunction(() => window.__waitLog.some((s) => s.includes('En attente de Bob')), null, { timeout: 15000, polling: 30 }).catch(() => undefined);
  await shot(ana.page, '05-attente.png');
  const bannerBob = await ana.page.evaluate(() => window.__waitLog.some((s) => s.includes('En attente de Bob')));
  check('d0', 'bandeau « En attente de Bob… » visible sur la page de Ana', bannerBob);
  await hostPage.waitForFunction(() => (window.__host.waiting()?.who ?? []).length === 0, null, { timeout: WAIT_LIMIT_MS + 15000, polling: 200 }).catch(() => undefined);
  const closed = await hostPage.evaluate(() => (window.__host.waiting()?.who ?? []).length === 0);
  let resumedAfterPause = false;
  for (let i = 0; i < 16; i += 1) {
    await sleep(250);
    if (await hostPlaying(hostPage)) resumedAfterPause = true;
  }
  check('d1', 'pause manuelle pendant l’attente : pas de reprise à la fin de l’attente', closed && !resumedAfterPause,
    `attente terminée ${closed ? 'oui' : 'non'}, lecture relancée ${resumedAfterPause ? 'oui' : 'non'}`);
  await bob.ctx.close();

  // ---- (e) réactions en direct ----
  // Page invitée (Ana) : elle réagit depuis le tiroir de chat, l'hôte la reçoit ; l'hôte réagit, elle voit l'emoji flotter.
  await clickControl(ana.page, '[data-id="chat"]');
  await ana.page.waitForSelector('.gc-react button:not([disabled])', { timeout: 10000 });
  const nHost = (await hostPage.evaluate(() => window.__host.reacts().length));
  await ana.page.click('.gc-react button');
  const dAna = await within(hostPage, (n) => window.__host.reacts().length > n && window.__host.reacts().slice(n).some((r) => r.by === 'Ana'), nHost);
  check('e1', 'réaction de l’invité : l’hôte la reçoit en moins de 2 s', dAna >= 0, dAna >= 0 ? `${dAna} ms` : 'non reçue');
  const dOwn = await within(ana.page, VISIBLE_FLOAT, '.gc-fl');
  check('e2', 'réaction de l’invité : l’émetteur voit son propre emoji flotter', dOwn >= 0, dOwn >= 0 ? `${dOwn} ms` : 'aucun emoji visible');
  await sleep(2000);
  await hostPage.evaluate(() => window.__host.sendReact('🔥'));
  const dGuestFloat = await within(ana.page, VISIBLE_FLOAT, '.gc-fl');
  check('e3', 'réaction de l’hôte : emoji flottant visible chez l’invité en moins de 2 s', dGuestFloat >= 0, dGuestFloat >= 0 ? `${dGuestFloat} ms` : 'aucun emoji visible');

  // Panneau du lecteur (src/ui/partypanel.js) sur un vrai client du salon : Zoe, invitée par lien.
  const zInv = await api('POST', `/party/${room.id}/invite-link`, { token: room.token, body: { profileId: room.profile } });
  const zEntry = await api('POST', `/party/${room.id}/guest`, { body: { token: zInv.body.token, name: 'Zoe' } });
  if (zEntry.status !== 200 && zEntry.status !== 201) throw new Error(`entrée invitée refusée (${zEntry.status})`);
  const zoeWs = `${WS}${guestWsPath(room.id, zEntry.body.sessionToken, zEntry.body.name ?? 'Zoe')}`;
  const zCtx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const zoe = await zCtx.newPage();
  zoe.on('pageerror', (e) => pageErrors.push(`Zoe: ${redact(e.message)}`));
  await zoe.goto(`${ORIGIN}/scripts/relay-e2e/party/live.html?${new URLSearchParams({ ws: zoeWs })}`, { waitUntil: 'domcontentloaded' });
  await zoe.waitForFunction(() => window.__live && (window.__live.ready || window.__live.error), null, { timeout: 60000 });
  await zoe.waitForFunction(() => window.__live.status() === 'open', null, { timeout: 30000 });
  await zoe.evaluate(() => window.__live.openPanel());
  await sleep(1200);
  await hostPage.evaluate(() => window.__host.sendReact('😂'));
  const dZoe = await within(zoe, VISIBLE_FLOAT, '.lp-party-floats .ps-float');
  check('e4', 'panneau du lecteur : réaction de l’hôte, élément flottant visible en moins de 2 s', dZoe >= 0, dZoe >= 0 ? `${dZoe} ms` : 'aucun élément flottant visible');
  if (dZoe < 0) {
    log(`diagnostic panneau : ${JSON.stringify(await zoe.evaluate(() => ({
      status: window.__live.status(), closeCode: window.__live.closeCode, reacts: window.__live.reacts(), floats: document.querySelector('.lp-party-floats')?.outerHTML.slice(0, 400) ?? null,
      panelHidden: document.querySelector('.lp-party')?.hidden ?? null, band: document.querySelector('.ps-band')?.hidden ?? null,
    })).catch((e) => String(e.message).slice(0, 200)))}`);
  }
  await sleep(3400);
  const nHost2 = await hostPage.evaluate(() => window.__host.reacts().length);
  await zoe.waitForSelector('[data-wp-react]', { timeout: 10000 });
  await zoe.click('[data-wp-react]');
  const dZoeSent = await within(hostPage, (n) => window.__host.reacts().slice(n).some((r) => r.by === 'Zoe'), nHost2);
  check('e5', 'panneau du lecteur : sa réaction arrive à l’hôte en moins de 2 s', dZoeSent >= 0, dZoeSent >= 0 ? `${dZoeSent} ms` : 'non reçue');
  const dZoeOwn = await within(zoe, VISIBLE_FLOAT, '.lp-party-floats .ps-float');
  check('e6', 'panneau du lecteur : l’émetteur voit sa propre réaction tout de suite', dZoeOwn >= 0, dZoeOwn >= 0 ? `${dZoeOwn} ms` : 'aucun élément flottant visible');
  await shot(zoe, '08-lecteur-reaction.png');
  await zCtx.close();
} catch (error) {
  check('e2e', 'scénario terminé sans exception', false, error.message);
  if (hostPage) log(`diagnostic hôte : ${JSON.stringify(await hostPage.evaluate(() => ({ ready: window.__host?.ready, error: window.__host?.error, status: window.__host?.status?.(), state: window.__host?.state?.(), waiting: window.__host?.waiting?.(), chat: window.__host?.chat?.().length })).catch((e) => String(e.message).slice(0, 200)))}`);
  if (ana) log(`diagnostic invitée : ${JSON.stringify(await ana.page.evaluate(() => ({ view: document.querySelector('[data-pj-status]')?.textContent, waitLog: window.__waitLog, label: document.querySelector('[data-gp="play"]')?.getAttribute('aria-label'), ls: window.__lsRelayStats ?? null })).catch((e) => String(e.message).slice(0, 200)))}`);
  log(`trames buf (${bufTrace.length}) : ${bufTrace.slice(-8).join(' | ')}`);
} finally {
  clearInterval(watch);
  log(`chronologie : ${timeline.slice(0, 60).join(' ; ')}`);
  if (SHOTS && shots.length) log(`captures : ${shots.map((s) => `${s.file} ${s.w}x${s.h} ${s.bytes} o`).join(' ; ')}`);
  await cleanup();
}

const failed = results.filter((c) => !c.ok);
log(`erreurs de page : ${pageErrors.length}${pageErrors.length ? ` (${redact(pageErrors.slice(0, 3).join(' | '))})` : ''}`);
log(`RÉSULTAT : ${results.length - failed.length}/${results.length} contrôles PASS`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
