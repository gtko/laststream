// Test d'intégration headless à DEUX pages : hôte et invité, chacun dans son contexte Chromium, avec un vrai WebRTC en
// loopback (RTCPeerConnection et DataChannel « ranges » réels). L'hôte sert les plages d'un média (source URL factice, en
// mémoire) ; l'invité les reçoit par le DataChannel, les décode via WebCodecs et les peint sur un canvas. Le salon est un
// faux relais WebSocket (fake-party-relay.mjs) : ce n'est pas le serveur lastaddon, et rien n'est déployé.
// Une pause (ou un saut) côté invité doit mettre le salon, donc l'hôte, en pause (ou le recaler).
//
// Usage : npm run relay:e2e   (ou node scripts/relay-e2e/two-pages.mjs)
//   RELAY_E2E_OUT=<dossier>   fixtures et capture (défaut : scripts/relay-e2e/.out, ignoré par git)
//   RELAY_E2E_CODEC=vp9       force le WebM VP9/Opus (chemin de repli)
// Headless uniquement : aucune fenêtre visible.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SERVER_LIMITS, startFakePartyRelay } from './fake-party-relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.RELAY_E2E_OUT ?? join(here, '.out'));
const pagesRoot = join(here, 'two-pages');
const forceVp9 = process.env.RELAY_E2E_CODEC === 'vp9';
const ROOM = 'SALONTEST1';
const LAUNCH_ARGS = ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'];
/** Fragments de l'URL factice du média : aucun ne doit atteindre l'invité. */
const URL_MARKERS = ['relay-e2e.invalid', 'lien-factice'];
/** Borne d'une trame envoyée par le client (MAX_FRAME_BYTES, src/party/protocol.ts). */
const CLIENT_FRAME_BYTES = 4096;
const SHOT = join(out, 'relay-two-pages.png');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`);
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg a échoué : ${r.error?.message ?? r.stderr}`);
}

const probeFFmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (probeFFmpeg.error || probeFFmpeg.status !== 0) {
  console.error('ffmpeg introuvable dans le PATH : test e2e à deux pages impossible.');
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const testSource = ['-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=12'];
const h264 = 'two-pages-h264.mp4';
ffmpeg([...testSource, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(out, h264)]);

const vite = await createServer({
  configFile: false,
  root: pagesRoot,
  publicDir: out,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5192 },
});
await vite.listen();
const base = vite.resolvedUrls.local[0].replace(/\/$/, '');
const relay = await startFakePartyRelay();

async function probeCodecs(b) {
  const page = await b.newPage();
  try {
    await page.goto(`${base}/probe.html`);
    return await page.evaluate(async () => {
      const video = async (codec) => {
        try {
          return (await VideoDecoder.isConfigSupported({ codec })).supported === true;
        } catch {
          return false;
        }
      };
      const audio = async (codec) => {
        try {
          return (await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 })).supported === true;
        } catch {
          return false;
        }
      };
      return { avc: await video('avc1.640028'), vp9: await video('vp09.00.10.08'), aac: await audio('mp4a.40.2'), opus: await audio('opus') };
    });
  } finally {
    await page.close();
  }
}

/** Chromium headless : H.264/AAC d'abord (Playwright puis Chrome installé), sinon repli WebM VP9/Opus. */
async function launchBrowser() {
  if (!forceVp9) {
    for (const channel of [undefined, 'chrome']) {
      let candidate;
      try {
        candidate = await chromium.launch({ headless: true, channel, args: LAUNCH_ARGS });
      } catch (error) {
        console.log(`navigateur ${channel ?? 'chromium'} indisponible : ${String(error.message).split('\n')[0]}`);
        continue;
      }
      const caps = await probeCodecs(candidate);
      if (caps.avc && caps.aac) return { browser: candidate, label: channel ?? 'chromium (Playwright)', caps, media: h264 };
      console.log(`${channel ?? 'chromium'} : H.264/AAC non décodables (${JSON.stringify(caps)})`);
      await candidate.close();
    }
  }
  const candidate = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const caps = await probeCodecs(candidate);
  const webm = 'two-pages-vp9.webm';
  ffmpeg([...testSource, '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', join(out, webm)]);
  console.log(
    forceVp9
      ? 'RELAY_E2E_CODEC=vp9 : chemin WebM VP9/Opus forcé.'
      : 'LIMITE : H.264/AAC non décodables par les navigateurs disponibles ; repli sur le WebM VP9/Opus.',
  );
  return { browser: candidate, label: 'chromium (Playwright)', caps, media: webm };
}

let browser = null;
try {
  const picked = await launchBrowser();
  browser = picked.browser;
  console.log(`navigateur : ${picked.label} ; capacités ${JSON.stringify(picked.caps)} ; média : ${picked.media}`);

  // Deux contextes distincts (deux utilisateurs) dans le même navigateur.
  const hostCtx = await browser.newContext({ viewport: { width: 900, height: 420 } });
  const guestCtx = await browser.newContext({ viewport: { width: 900, height: 620 } });
  const hostPage = await hostCtx.newPage();
  const guestPage = await guestCtx.newPage();
  const pageErrors = [];
  for (const [page, who] of [
    [hostPage, 'hôte'],
    [guestPage, 'invité'],
  ]) {
    page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`${who} console: ${m.text()}`);
    });
  }

  // Trames WebSocket reçues par l'invité (vues par le navigateur, indépendamment de l'application).
  const wire = { sockets: 0, textFrames: 0, textBytes: 0, binaryFrames: 0, urlLeaks: 0 };
  guestPage.on('websocket', (ws) => {
    if (!ws.url().includes('/party/')) return;
    wire.sockets += 1;
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') {
        wire.textFrames += 1;
        wire.textBytes += Buffer.byteLength(payload);
        if (URL_MARKERS.some((m) => payload.includes(m))) wire.urlLeaks += 1;
      } else {
        wire.binaryFrames += 1;
        const text = payload.toString('latin1');
        if (URL_MARKERS.some((m) => text.includes(m))) wire.urlLeaks += 1;
      }
    });
  });

  const query = (extra) => new URLSearchParams({ relay: relay.url, room: ROOM, ...extra }).toString();

  await hostPage.goto(`${base}/host.html?${query({ media: picked.media })}`);
  await hostPage.waitForFunction(() => window.__host && (window.__host.ready || window.__host.error), null, { timeout: 60000 });
  const hostBoot = await hostPage.evaluate(() => window.__host.error);
  if (hostBoot) throw new Error(`hôte : ${hostBoot}`);
  await hostPage.waitForFunction(() => window.__host.status() === 'open' && window.__host.state() !== null, null, { timeout: 20000 });

  await guestPage.goto(`${base}/guest.html?${query({})}`);
  await guestPage.waitForFunction(
    () => {
      const phase = window.__guest?.view().phase;
      return phase === 'ready' || ['host-lost', 'refused', 'unsupported', 'ended'].includes(phase);
    },
    null,
    { timeout: 60000 },
  );

  // 1 et 2 : connexion WebRTC, canal « ranges » ouvert.
  const guestReady = await guestPage.evaluate(() => window.__guest.view());
  const hostLinks = await hostPage.evaluate(() => window.__host.stats());
  check(
    'connexion : invité prêt, hôte lié à l’invité',
    guestReady.phase === 'ready' && hostLinks.links >= 1 && hostLinks.guests >= 1,
    `phase ${guestReady.phase}, liaisons ${hostLinks.links}, invités ${hostLinks.guests}`,
  );
  const dcOpen = await guestPage.evaluate(() => window.__guest.dc());
  check('canal « ranges » ouvert côté invité', dcOpen.label === 'ranges' && dcOpen.channelState === 'open', `libellé ${dcOpen.label}, état ${dcOpen.channelState}`);

  // Lecture : l'invité lance, le salon (donc l'hôte) doit passer en lecture ; l'image doit être peinte.
  await guestPage.click('#play');
  const playedOnHost = await hostPage
    .waitForFunction(() => window.__host.state()?.playing === true, null, { timeout: 8000 })
    .then(() => true, () => false);
  await sleep(1500);
  const painted = await guestPage.evaluate(() => window.__guest.sample());
  await guestPage.screenshot({ path: SHOT });
  check(
    'canvas invité peint : pixels non vides (WebCodecs)',
    painted.lit > 0.3 && painted.colors > 20,
    `${(painted.lit * 100).toFixed(0)} % de pixels allumés, ${painted.colors} couleurs, canvas ${painted.width}x${painted.height}`,
  );

  // 4 : pause côté invité -> salon et hôte en pause.
  const hostBeforePause = await hostPage.evaluate(() => window.__host.state());
  await guestPage.click('#pause');
  const pausedOnHost = await hostPage
    .waitForFunction(() => window.__host.state()?.playing === false, null, { timeout: 8000 })
    .then(() => true, () => false);
  const hostPaused = await hostPage.evaluate(() => window.__host.state());
  const guestPaused = await guestPage.evaluate(() => window.__guest.view());
  check(
    'pause invité -> hôte en pause (après lecture propagée)',
    playedOnHost && pausedOnHost && hostPaused.playing === false,
    `hôte : lecture ${hostBeforePause?.playing} -> ${hostPaused.playing}, position ${hostPaused.pos.toFixed(2)} s ; invité ${guestPaused.position.toFixed(2)} s`,
  );

  // 5 : saut de 5 s côté invité (en pause) -> salon recalé, image affichée.
  await sleep(300);
  await guestPage.click('#seek');
  await sleep(900);
  const hostSeek = await hostPage.evaluate(() => window.__host.state());
  const guestSeek = await guestPage.evaluate(() => window.__guest.view());
  const seekPaint = await guestPage.evaluate(() => window.__guest.sample());
  check(
    'seek invité (+5 s) -> hôte recalé, image affichée',
    hostSeek.pos >= hostPaused.pos + 4 && Math.abs(hostSeek.pos - guestSeek.position) <= 0.5 && !hostSeek.playing && seekPaint.lit > 0.3,
    `hôte ${hostSeek.pos.toFixed(2)} s (était ${hostPaused.pos.toFixed(2)} s), invité ${guestSeek.position.toFixed(2)} s, ${seekPaint.colors} couleurs`,
  );

  // 6 et 7 : les octets arrivent par le DataChannel seulement ; l'URL du média n'atteint jamais l'invité.
  const dcEnd = await guestPage.evaluate(() => window.__guest.dc());
  const viewEnd = await guestPage.evaluate(() => window.__guest.view());
  const playerStats = await guestPage.evaluate(() => window.__guest.stats());
  check(
    'octets reçus par l’invité uniquement via DataChannel',
    viewEnd.bytesReceived > 0 && dcEnd.bytes > 0 && wire.binaryFrames === 0 && wire.textBytes < dcEnd.bytes,
    `DataChannel ${dcEnd.bytes} o en ${dcEnd.messages} messages (${playerStats?.decodedFrames ?? 0} images décodées) ; WebSocket ${wire.textFrames} trames texte de ${wire.textBytes} o, ${wire.binaryFrames} binaires`,
  );
  // Témoin : la source de l'hôte a bien servi des octets depuis l'URL factice, et les marqueurs la couvrent.
  const hostSource = await hostPage.evaluate(() => ({ url: window.__host.sourceUrl, sent: window.__host.stats().bytesSent }));
  check(
    'URL du média absente des trames reçues par l’invité (WebSocket et DataChannel)',
    wire.urlLeaks === 0 && dcEnd.leaks === 0 && wire.sockets > 0 && hostSource.sent > 0 && URL_MARKERS.every((m) => hostSource.url.includes(m)),
    `${wire.urlLeaks} trame(s) WebSocket et ${dcEnd.leaks} message(s) DataChannel avec un marqueur ; l’hôte a servi ${hostSource.sent} o depuis l’URL factice`,
  );

  // 8 : tailles de la signalisation rtc (SDP et ICE) face aux limites client et serveur.
  const rs = relay.stats().rtc;
  check(
    'signalisation rtc dans les limites : client 4 Ko, serveur 16 Kio de données et 64 Kio de trame',
    rs.count > 0 &&
      rs.rejected === 0 &&
      rs.undelivered === 0 &&
      rs.maxFrameBytes <= CLIENT_FRAME_BYTES &&
      rs.maxDataBytes <= SERVER_LIMITS.rtcDataBytes &&
      rs.maxFrameBytes <= SERVER_LIMITS.rtcFrameChars,
    `${rs.count} trames rtc, max trame ${rs.maxFrameBytes} o, max données ${rs.maxDataBytes} o, rejets ${rs.rejected}, max par type ${JSON.stringify(rs.maxByKind)}`,
  );

  // 9 : aucune erreur de page ni de console.
  check('aucune erreur de page ni de console', pageErrors.length === 0, pageErrors.join(' | '));
  // 10 : capture écrite.
  check('capture d’écran écrite', existsSync(SHOT) && statSync(SHOT).size > 0, SHOT);

  await hostPage.close();
  await guestPage.close();
} catch (error) {
  check('scénario e2e terminé sans exception', false, error.message);
} finally {
  await browser?.close();
  await vite.close();
  await relay.close();
}

const passed = checks.filter((c) => c.ok).length;
console.log(`RÉSULTAT : ${passed}/${checks.length} contrôles OK (capture : ${SHOT})`);
process.exitCode = passed === checks.length ? 0 : 1;
