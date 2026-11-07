// Test e2e headless du maillage entre invités : UN hôte et DEUX invités (trois contextes Chromium) contre le vrai salon
// lastaddon (PartyRoom, lancé en local par `wrangler dev` depuis un worktree lastaddon), avec un vrai WebRTC en loopback et
// un vrai clip H.264 lu en HTTP par l'hôte. Le 2e invité doit recevoir une partie de ses octets du 1er (DataChannel « mesh »),
// et la lecture doit avancer chez les deux.
//
// Usage : LASTADDON_DIR=<worktree lastaddon> node scripts/relay-e2e/mesh.mjs
//   MESH_E2E_CLIP=<url>     clip lu par l'hôte (défaut : https://gtko.github.io/laststream-test-addon/media/test-720p.mp4)
//   MESH_E2E_WARMUP_MS=<ms> lecture du 1er invité avant l'arrivée du 2e (défaut 7000)
// Les secrets de `.dev.vars` sont aléatoires et le fichier est supprimé à la fin. Seuls les processus lancés ici sont arrêtés.
// Headless uniquement : aucune fenêtre visible.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, 'mesh');
const lastaddon = process.env.LASTADDON_DIR ? resolve(process.env.LASTADDON_DIR) : '';
if (!lastaddon || !existsSync(join(lastaddon, 'wrangler.test.jsonc'))) {
  console.error('LASTADDON_DIR doit pointer vers un worktree lastaddon (wrangler.test.jsonc introuvable).');
  process.exit(2);
}
const CLIP = process.env.MESH_E2E_CLIP ?? 'https://gtko.github.io/laststream-test-addon/media/test-720p.mp4';
const WARMUP_MS = Number(process.env.MESH_E2E_WARMUP_MS ?? 7000);
const WRANGLER_PORT = 8791;
const VITE_PORT = 5193;
const API = `http://127.0.0.1:${WRANGLER_PORT}`;
const WS = `ws://127.0.0.1:${WRANGLER_PORT}`;
const ORIGIN = `http://127.0.0.1:${VITE_PORT}`;
const LAUNCH_ARGS = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`);
}

const secret = () => randomBytes(24).toString('hex');
const ADMIN = secret();
const PASSWORD = `pw-${secret()}`;
const devVars = join(lastaddon, '.dev.vars');
const persist = mkdtempSync(join(tmpdir(), 'mesh-e2e-'));
let wrangler = null;
let vite = null;
let browser = null;

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function cleanup() {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  killTree(wrangler);
  rmSync(devVars, { force: true });
  await sleep(1500);
  try {
    rmSync(persist, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    console.log(`dossier temporaire conservé (fichiers encore ouverts) : ${persist}`);
  }
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
  let log = '';
  wrangler.stdout.on('data', (d) => (log += d));
  wrangler.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i += 1) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler s'est arrêté : ${log.slice(-600)}`);
    try {
      await fetch(`${API}/party/x`);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`wrangler dev ne répond pas : ${log.slice(-600)}`);
}

async function makeRoom() {
  const invite = await api('POST', '/__admin/invite', { headers: { 'x-admin-secret': ADMIN } });
  if (invite.status !== 200) throw new Error(`invitation système refusée (${invite.status})`);
  const name = `hote${Math.floor(Math.random() * 1e6)}`;
  const reg = await api('POST', '/user/register', { body: { username: name, password: PASSWORD, invite: invite.body.code } });
  if (reg.status !== 201) throw new Error(`inscription refusée (${reg.status} ${JSON.stringify(reg.body)})`);
  const login = await api('POST', '/user/login', { body: { username: name, password: PASSWORD } });
  const token = login.body.token;
  const profile = await api('POST', '/user/profiles', { token, body: { name, avatarColor: '#aa5500' } });
  const room = await api('POST', '/party', {
    token,
    body: { profileId: profile.body.id, visibility: 'private', title: 'Clip de test', media: { type: 'movie', tmdbId: 603 } },
  });
  if (room.status !== 201) throw new Error(`salon refusé (${room.status} ${JSON.stringify(room.body)})`);
  const id = room.body.room.id;
  const join = await api('POST', `/party/${id}/join`, { token, body: { profileId: profile.body.id } });
  return { id, token, profile: profile.body.id, hostWs: `${WS}${join.body.wsPath}` };
}

async function guestWs(room, name) {
  const inv = await api('POST', `/party/${room.id}/invite`, { token: room.token, body: { profileId: room.profile } });
  if (inv.status !== 201) throw new Error(`invitation refusée (${inv.status} ${JSON.stringify(inv.body)})`);
  return `${WS}/party/${room.id}/ws?t=${encodeURIComponent(inv.body.token)}&name=${name}`;
}

async function launch() {
  for (const channel of ['chrome', undefined]) {
    let b;
    try {
      b = await chromium.launch({ headless: true, channel, args: LAUNCH_ARGS });
    } catch (e) {
      console.log(`navigateur ${channel ?? 'chromium'} indisponible : ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const page = await b.newPage();
    await page.goto(`${ORIGIN}/probe.html`);
    const avc = await page.evaluate(async () => {
      try {
        return (await VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })).supported === true;
      } catch {
        return false;
      }
    });
    await page.close();
    if (avc) return { browser: b, label: channel ?? 'chromium (Playwright)' };
    console.log(`${channel ?? 'chromium'} : H.264 non décodable`);
    await b.close();
  }
  throw new Error('aucun navigateur ne décode H.264');
}

const phaseOk = (p) => p === 'ready';
const phaseDead = (p) => ['host-lost', 'refused', 'unsupported', 'ended'].includes(p);

try {
  mkdirSync(persist, { recursive: true });
  vite = await createServer({ configFile: false, root: pagesRoot, logLevel: 'warn', server: { host: '127.0.0.1', port: VITE_PORT, strictPort: true } });
  await vite.listen();
  await startWrangler();
  console.log('salon lastaddon local prêt (wrangler dev) ; création du salon…');
  const room = await makeRoom();

  const picked = await launch();
  browser = picked.browser;
  console.log(`navigateur : ${picked.label} ; clip : ${CLIP}`);
  const errors = [];
  const open = async (who, url) => {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 420 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`);
    });
    await page.goto(url);
    return page;
  };

  const host = await open('hôte', `${ORIGIN}/host.html?${new URLSearchParams({ ws: room.hostWs, media: CLIP })}`);
  await host.waitForFunction(() => window.__host && (window.__host.ready || window.__host.error), null, { timeout: 30000 });
  const bootErr = await host.evaluate(() => window.__host.error);
  if (bootErr) throw new Error(`hôte : ${bootErr}`);
  await host.waitForFunction(() => window.__host.status() === 'open' && window.__host.state() !== null, null, { timeout: 20000 });

  const readyOrDead = (page) =>
    page.waitForFunction(
      () => ['ready', 'host-lost', 'refused', 'unsupported', 'ended'].includes(window.__guest?.view().phase),
      null,
      { timeout: 90000 },
    );

  // Invité 1 : seul avec l'hôte, il lit le clip et remplit son cache.
  const g1 = await open('invité 1', `${ORIGIN}/guest.html?${new URLSearchParams({ ws: await guestWs(room, 'Ana') })}`);
  await readyOrDead(g1);
  const v1 = await g1.evaluate(() => window.__guest.view());
  check('invité 1 : prêt', phaseOk(v1.phase), `phase ${v1.phase}${v1.message ? ` (${v1.message})` : ''}`);
  if (!phaseOk(v1.phase)) throw new Error('invité 1 non prêt');
  await g1.evaluate(() => window.__guest.play());
  await sleep(WARMUP_MS);
  const w1 = await g1.evaluate(() => ({ view: window.__guest.view(), ch: window.__guest.channels() }));
  check('invité 1 : lecture en cours, octets reçus de l’hôte', w1.view.position > 2 && w1.view.bytesReceived > 1_000_000, `position ${w1.view.position.toFixed(1)} s, ${w1.view.bytesReceived} o de l’hôte`);

  // Invité 2 : arrive après ; ses morceaux doivent venir en partie de l'invité 1.
  const g2 = await open('invité 2', `${ORIGIN}/guest.html?${new URLSearchParams({ ws: await guestWs(room, 'Bob') })}`);
  await readyOrDead(g2);
  const v2 = await g2.evaluate(() => window.__guest.view());
  check('invité 2 : prêt', phaseOk(v2.phase), `phase ${v2.phase}${v2.message ? ` (${v2.message})` : ''}`);
  if (!phaseOk(v2.phase)) throw new Error('invité 2 non prêt');
  await g2.evaluate(() => window.__guest.play());
  await sleep(9000);

  const snap = async (page) => page.evaluate(() => ({ view: window.__guest.view(), ch: window.__guest.channels(), paint: window.__guest.sample() }));
  const s1 = await snap(g1);
  const s2 = await snap(g2);
  const hostCh = await host.evaluate(() => ({ ch: window.__host.channels(), stats: window.__host.stats() }));
  const fromMesh2 = s2.ch.mesh?.received ?? 0;
  const fromHost2 = s2.ch.ranges?.received ?? 0;
  const share = fromMesh2 / Math.max(1, fromMesh2 + fromHost2);
  console.log(`invité 1 : position ${s1.view.position.toFixed(1)} s, ranges ${s1.ch.ranges?.received ?? 0} o, mesh reçu ${s1.ch.mesh?.received ?? 0} o / servi ${s1.ch.mesh?.sent ?? 0} o, pairs ${s1.view.meshPeers}`);
  console.log(`invité 2 : position ${s2.view.position.toFixed(1)} s, ranges ${fromHost2} o, mesh reçu ${fromMesh2} o / servi ${s2.ch.mesh?.sent ?? 0} o, pairs ${s2.view.meshPeers}`);
  if (s2.view.meshPeers < 1) console.log('diagnostic invité 2 :', JSON.stringify(await g2.evaluate(() => window.__guest.debug())));
  console.log(`hôte : ${hostCh.stats.bytesSent} o envoyés (DataChannel ranges envoyé ${hostCh.ch.ranges?.sent ?? 0} o)`);

  check('maillage : invité 2 lié à l’invité 1 (DataChannel « mesh » ouvert)', s2.view.meshPeers >= 1 && s1.view.meshPeers >= 1, `liens ${s1.view.meshPeers}/${s2.view.meshPeers}`);
  check(
    'invité 2 : une partie de ses octets vient de l’invité 1',
    fromMesh2 > 0 && s2.view.bytesFromPeers > 0 && s1.view.bytesServed > 0,
    `${s2.view.bytesFromPeers} o de fichier via pairs (application), ${fromMesh2} o reçus sur le DataChannel mesh contre ${fromHost2} o sur ranges : part pairs ${(share * 100).toFixed(0)} %`,
  );
  check(
    'lecture qui avance chez les deux invités',
    s1.view.position > w1.view.position + 3 && s2.view.position > 3 && s1.view.playing && s2.view.playing,
    `invité 1 ${w1.view.position.toFixed(1)} -> ${s1.view.position.toFixed(1)} s, invité 2 ${s2.view.position.toFixed(1)} s`,
  );
  check('canvas peint chez les deux invités', s1.paint.lit > 0.2 && s2.paint.lit > 0.2, `${(s1.paint.lit * 100).toFixed(0)} % / ${(s2.paint.lit * 100).toFixed(0)} % de pixels allumés, ${s1.paint.colors}/${s2.paint.colors} couleurs`);
  check('aucune erreur de page ni de console', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (error) {
  check('scénario e2e terminé sans exception', false, error.message);
} finally {
  await cleanup();
}

const passed = checks.filter((c) => c.ok).length;
console.log(`RÉSULTAT : ${passed}/${checks.length} contrôles OK`);
process.exitCode = passed === checks.length ? 0 : 1;
