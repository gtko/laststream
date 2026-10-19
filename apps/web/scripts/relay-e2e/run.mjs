// Test d'intégration headless du lecteur invité (src/relay/player/GuestPlayer).
//
// Génère un MP4 H.264 + AAC avec ffmpeg, lance Vite sur le harnais harness/ (publicDir = dossier de sortie),
// puis pilote Chromium en headless via Playwright. Le fichier est servi à l'octet près depuis un RangeReader en mémoire.
//
// Usage : node scripts/relay-e2e/run.mjs
//   RELAY_E2E_OUT=<dossier>   sortie hors dépôt (fixtures + capture d'écran). Défaut : scripts/relay-e2e/.out
//   RELAY_E2E_CODEC=vp9       force le WebM VP9/Opus (chemin de repli)
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.RELAY_E2E_OUT ?? join(here, '.out'));
const harnessRoot = join(here, 'harness');
const forceVp9 = process.env.RELAY_E2E_CODEC === 'vp9';
const LAUNCH_ARGS = ['--autoplay-policy=no-user-gesture-required'];
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
  console.error('ffmpeg introuvable dans le PATH : e2e relay impossible.');
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const testSource = ['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=5'];
ffmpeg([...testSource, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(out, 'test-h264.mp4')]);

const server = await createServer({
  configFile: false,
  root: harnessRoot,
  publicDir: out,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5191 },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

async function probeCodecs(browser) {
  const page = await browser.newPage();
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

// Navigateur : Chromium de Playwright d'abord, puis Chrome installé si H.264/AAC manquent.
let browser = null;
let caps = null;
let browserLabel = '';
if (!forceVp9) {
  for (const channel of [undefined, 'chrome']) {
    let candidate;
    try {
      candidate = await chromium.launch({ headless: true, channel, args: LAUNCH_ARGS });
    } catch (error) {
      console.log(`navigateur ${channel ?? 'chromium'} indisponible : ${String(error.message).split('\n')[0]}`);
      continue;
    }
    const found = await probeCodecs(candidate);
    if (found.avc && found.aac) {
      browser = candidate;
      caps = found;
      browserLabel = channel ?? 'chromium (Playwright)';
      break;
    }
    console.log(`${channel ?? 'chromium'} : H.264/AAC non décodables (${JSON.stringify(found)})`);
    await candidate.close();
  }
}

let media = 'test-h264.mp4';
let expected = { video: 'avc', audio: 'aac' };
if (!browser) {
  browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  caps = await probeCodecs(browser);
  browserLabel = 'chromium (Playwright)';
  media = 'test-vp9.webm';
  expected = { video: 'vp9', audio: 'opus' };
  ffmpeg([...testSource, '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', join(out, media)]);
  console.log(
    forceVp9
      ? 'RELAY_E2E_CODEC=vp9 : chemin WebM VP9/Opus forcé.'
      : 'LIMITE : H.264/AAC non décodables par les navigateurs disponibles ; repli sur le WebM VP9/Opus.',
  );
}
console.log(`navigateur : ${browserLabel} ; capacités ${JSON.stringify(caps)} ; média : ${media}`);

const pageErrors = [];
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${base}/?media=${media}`);
  await page.waitForFunction(() => window.__relay && (window.__relay.ready || window.__relay.error), null, { timeout: 60000 });
  const boot = await page.evaluate(() => ({ error: window.__relay.error, plan: window.__relay.plan }));
  check('chargement : décodage natif choisi', !boot.error && boot.plan?.kind === 'native', boot.error ?? JSON.stringify(boot.plan));
  if (boot.error || boot.plan?.kind !== 'native') throw new Error('lecture impossible, arrêt du scénario');

  await page.evaluate(() => window.__relay.player.play());
  await sleep(1500);
  const s1 = await page.evaluate(() => window.__relay.sample());
  await page.screenshot({ path: join(out, 'relay-e2e.png') });
  await sleep(1000);
  const s2 = await page.evaluate(() => window.__relay.sample());
  check(
    'image peinte : pixels non vides sur le canvas',
    s1.lit > 0.3 && s1.colors > 20,
    `${(s1.lit * 100).toFixed(0)} % de pixels allumés, ${s1.colors} couleurs, canvas ${s1.width}x${s1.height}`,
  );
  check(
    'lecture avance sur l’horloge maîtresse',
    s2.playing && s2.position - s1.position > 0.7,
    `position ${s1.position.toFixed(2)} s -> ${s2.position.toFixed(2)} s`,
  );
  check('images qui changent au fil du temps', s1.hash !== s2.hash);

  let stats = await page.evaluate(() => window.__relay.stats());
  check(
    'décodage vidéo et audio',
    stats.videoCodec === expected.video && stats.audioCodec === expected.audio && stats.decodedFrames > 25 && stats.audioChunks > 0,
    `vidéo ${stats.videoCodec} (${stats.decodedFrames} images, ${stats.droppedFrames} écartées), audio ${stats.audioCodec} (${stats.audioChunks} segments)`,
  );

  const eventsBefore = await page.evaluate(() => window.__relay.events.length);
  await page.evaluate(() => window.__relay.room({ playing: true, position: 4, at: Date.now() }));
  await sleep(700);
  const s3 = await page.evaluate(() => window.__relay.sample());
  stats = await page.evaluate(() => window.__relay.stats());
  check(
    'salon : écart > 0,5 s recalé par seek',
    s3.position >= 3.95 && s3.position <= 5 && stats.lastDriftSec < -0.5,
    `position ${s3.position.toFixed(2)} s, dérive mesurée ${stats.lastDriftSec.toFixed(2)} s, ${stats.seeks} seeks`,
  );
  const eventsAfter = await page.evaluate(() => window.__relay.events.length);
  check('salon : applyRoomState n’émet aucun événement utilisateur', eventsAfter === eventsBefore);

  await page.evaluate(() => window.__relay.player.pause());
  const p1 = await page.evaluate(() => window.__relay.player.getState());
  await sleep(500);
  const p2 = await page.evaluate(() => window.__relay.player.getState());
  const lastPause = await page.evaluate(() => window.__relay.events.at(-1));
  check(
    'pause utilisateur : position figée et événement émis',
    !p2.playing && Math.abs(p2.position - p1.position) < 0.01 && lastPause.type === 'pause',
    `position ${p2.position.toFixed(2)} s`,
  );

  await page.evaluate(() => window.__relay.player.seek(1));
  await sleep(400);
  const k = await page.evaluate(() => ({
    state: window.__relay.player.getState(),
    last: window.__relay.events.at(-1),
    shot: window.__relay.sample(),
  }));
  check(
    'seek utilisateur sur image clé : position 1 s, événement seek, image affichée',
    Math.abs(k.state.position - 1) < 0.01 && k.last.type === 'seek' && k.shot.lit > 0.3,
    `position ${k.state.position.toFixed(2)} s, ${k.shot.colors} couleurs`,
  );

  const endedBefore = await page.evaluate(() => window.__relay.ended());
  await page.evaluate(() => window.__relay.player.play());
  const endedInTime = await page
    .waitForFunction((n) => window.__relay.ended() > n, endedBefore, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const end = await page.evaluate(() => window.__relay.player.getState());
  check(
    'fin du média détectée (onEnded)',
    endedInTime && !end.playing && Math.abs(end.position - end.duration) < 0.1,
    `position ${end.position.toFixed(2)} s / durée ${end.duration.toFixed(2)} s`,
  );

  const served = await page.evaluate(() => window.__relay.served);
  const fileSize = statSync(join(out, media)).size;
  check('lecture à la demande par plages', served.reads > 0, `${served.reads} plages, ${served.bytes} octets servis sur ${fileSize}`);
  const playerErrors = await page.evaluate(() => window.__relay.errors);
  check('aucune erreur du lecteur ni de la page', playerErrors.length === 0 && pageErrors.length === 0, [...playerErrors, ...pageErrors].join(' | '));

  await page.close();
} catch (error) {
  check('scénario e2e terminé sans exception', false, error.message);
} finally {
  await browser.close();
  await server.close();
}

const passed = checks.filter((c) => c.ok).length;
console.log(`RÉSULTAT : ${passed}/${checks.length} contrôles OK (capture : ${join(out, 'relay-e2e.png')})`);
process.exit(passed === checks.length ? 0 : 1);
