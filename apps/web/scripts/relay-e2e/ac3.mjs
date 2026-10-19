// Test headless : son E-AC-3 / AC-3 décodé par @mediabunny/ac3 dans le lecteur invité (Chromium, sans COOP/COEP).
//
// Génère avec ffmpeg un MP4 H.264 + E-AC-3 (ou MKV VP9 + E-AC-3 si H.264 est indisponible) et un MP4 H.264 + AC-3,
// les fait lire par GuestPlayer (harnais harness/) et vérifie : plan `audioDecoder:'ac3'`, AudioData programmé,
// position qui avance, pause, seek. Usage : node scripts/relay-e2e/ac3.mjs   (RELAY_E2E_OUT=<dossier> pour la sortie)
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.RELAY_E2E_OUT ?? join(here, '.out'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`);
};
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg a échoué : ${r.error?.message ?? r.stderr}`);
}

mkdirSync(out, { recursive: true });
const src = ['-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'];
ffmpeg([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'eac3', '-ac', '6', '-b:a', '384k', '-movflags', '+faststart', join(out, 'test-eac3.mp4')]);
ffmpeg([...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'ac3', '-ac', '2', '-movflags', '+faststart', join(out, 'test-ac3.mp4')]);
ffmpeg([...src, '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '25', '-c:a', 'eac3', '-ac', '6', join(out, 'test-eac3.mkv')]);

const server = await createServer({
  configFile: false,
  root: join(here, 'harness'),
  publicDir: out,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5192 },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function run(media) {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/?media=${media}`);
    await page.waitForFunction(() => window.__relay && (window.__relay.ready || window.__relay.error), null, { timeout: 60000 });
    const boot = await page.evaluate(() => ({ error: window.__relay.error, plan: window.__relay.plan, iso: crossOriginIsolated }));
    if (boot.error) {
      console.log(`${media} : ${boot.error}`);
      return false;
    }
    console.log(`${media} : plan ${JSON.stringify(boot.plan)}, crossOriginIsolated=${boot.iso}`);
    if (boot.plan?.kind !== 'native' || boot.plan.withoutAudio) {
      console.log(`${media} : pas de chemin audio natif (${JSON.stringify(boot.plan)})`);
      return false;
    }
    check(`${media} : sans COOP/COEP`, boot.iso === false);
    check(`${media} : décodeur wasm choisi`, boot.plan.audioDecoder === 'ac3', JSON.stringify(boot.plan));
    await page.evaluate(() => window.__relay.player.play());
    await sleep(2000);
    const s1 = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    await sleep(1000);
    const s2 = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    check(`${media} : AudioData programmé`, s1.st.audioChunks > 0 && s2.st.audioChunks > s1.st.audioChunks, `${s1.st.audioChunks} -> ${s2.st.audioChunks} segments`);
    check(`${media} : la position avance`, s2.pos - s1.pos > 0.7, `${s1.pos.toFixed(2)} -> ${s2.pos.toFixed(2)} s`);
    check(`${media} : audio d'avance borné`, s2.st.audioAheadSec > 0 && s2.st.audioAheadSec < 3, `${s2.st.audioAheadSec.toFixed(2)} s`);
    check(`${media} : vidéo décodée en parallèle`, s2.st.decodedFrames > 25, `${s2.st.decodedFrames} images`);
    await page.evaluate(() => window.__relay.player.pause());
    const p1 = await page.evaluate(() => window.__relay.player.getState().position);
    const c1 = (await page.evaluate(() => window.__relay.stats())).audioChunks;
    await sleep(600);
    const p2 = await page.evaluate(() => window.__relay.player.getState().position);
    const c2 = (await page.evaluate(() => window.__relay.stats())).audioChunks;
    check(`${media} : pause fige la position`, Math.abs(p2 - p1) < 0.02, `${p1.toFixed(2)} -> ${p2.toFixed(2)} s`);
    check(`${media} : pause ne programme plus d'audio au-delà de la marge`, c2 - c1 <= 40, `${c2 - c1} segments`);
    await page.evaluate(() => window.__relay.player.seek(3));
    await page.evaluate(() => window.__relay.player.play());
    await sleep(1500);
    const k = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    check(`${media} : seek à 3 s puis lecture`, k.pos > 3.8 && k.pos < 5.2, `position ${k.pos.toFixed(2)} s, ${k.st.seeks} seeks`);
    check(`${media} : audio programmé après le seek`, k.st.audioChunks - c2 > 20, `${k.st.audioChunks - c2} segments depuis la pause`);
    check(`${media} : aucune erreur`, errors.length === 0 && (await page.evaluate(() => window.__relay.errors.length)) === 0, errors.join(' | '));
    return true;
  } finally {
    await page.close();
  }
}

try {
  // H.264 n'est pas toujours décodable par le Chromium de Playwright : repli sur le MKV VP9.
  const h264 = await run('test-eac3.mp4');
  if (!h264) {
    console.log('H.264 indisponible ici : repli sur MKV VP9 + E-AC-3.');
    check('MKV VP9 + E-AC-3', await run('test-eac3.mkv'));
  } else {
    await run('test-ac3.mp4');
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `${failed} vérification(s) en échec` : 'tout est vert');
process.exit(failed ? 1 : 0);
