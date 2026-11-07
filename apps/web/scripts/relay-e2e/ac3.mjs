// Test headless : son E-AC-3 / AC-3 décodé par @mediabunny/ac3 dans le lecteur invité (Chromium, sans COOP/COEP).
//
// Génère avec ffmpeg un MP4 H.264 + E-AC-3 (ou MKV VP9 + E-AC-3 si H.264 est indisponible) et un MP4 H.264 + AC-3,
// les fait lire par GuestPlayer (harnais harness/) et vérifie : plan `audioDecoder:'ac3'`, AudioData programmé,
// position qui avance, pause, reprise, seek, et un blocage du fil principal pendant la lecture.
// Usage : node scripts/relay-e2e/ac3.mjs   (RELAY_E2E_OUT=<dossier> pour la sortie ; RELAY_E2E_BLOCK_MS=<ms>, 2000 par défaut)
//
// Mesure des segments audio : chaque AudioBufferSourceNode.start() est journalisé côté page (indépendant du lecteur).
// Pour deux segments consécutifs, écart = début(n) − fin(n−1), fin = début + (durée − décalage). Un écart nul est
// attendu : positif = silence (sous-alimentation), négatif = chevauchement. Les seeks sont marqués et exclus.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.RELAY_E2E_OUT ?? join(here, '.out'));
/** Durée (ms) du blocage du fil principal pendant la lecture. */
const BLOCK_MS = Number(process.env.RELAY_E2E_BLOCK_MS ?? '2000');
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

/** Exécuté dans la page avant le chargement : journal des départs de segments et des tâches longues. */
function instrument() {
  const log = [];
  window.__audioLog = log;
  // Contextes audio créés par la page : leur état (suspendu ou non) avant et pendant la pause est vérifié.
  const Ctx = window.AudioContext;
  window.__ctxs = [];
  window.AudioContext = class extends Ctx {
    constructor(...args) {
      super(...args);
      window.__ctxs.push(this);
    }
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (log.length < 50000) {
      log.push({ when: args[0] ?? 0, offset: args[1] ?? 0, dur: this.buffer ? this.buffer.duration : 0, rate: this.context.sampleRate });
    }
    return start.apply(this, args);
  };
  window.__longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (window.__longtasks.length < 10000) window.__longtasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Tâches longues non observables dans ce navigateur : compteur vide.
  }
}

/** Exécuté dans la page : écarts entre segments consécutifs (un `null` marque un seek, qui les sépare). */
function segStats() {
  let prevEnd = null;
  let n = 0;
  let maxGap = 0;
  let silence = 0;
  let late = 0;
  let maxLate = 0;
  let rate = 0;
  let worst = null;
  let prev = null;
  let idx = 0;
  for (const e of window.__audioLog) {
    idx++;
    if (e === null) {
      prevEnd = null;
      prev = null;
      continue;
    }
    n++;
    rate = e.rate;
    if (e.offset > 0) {
      late++;
      maxLate = Math.max(maxLate, e.offset);
    }
    if (prevEnd !== null) {
      const gap = e.when - prevEnd;
      if (Math.abs(gap) > maxGap) worst = { gap, at: idx, prev, cur: e };
      maxGap = Math.max(maxGap, Math.abs(gap));
      if (gap > 0) silence += gap;
    }
    prevEnd = e.when + (e.dur - e.offset);
    prev = e;
  }
  return { n, maxGapMs: maxGap * 1000, silenceMs: silence * 1000, late, maxLateMs: maxLate * 1000, rate, worst };
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
const summary = [];

/** Ouvre la page, attend le chargement ; renvoie `null` si le chemin audio natif AC-3 n'est pas disponible. */
async function openPage(media) {
  const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(instrument);
  await page.goto(`${base}/?media=${media}`);
  await page.waitForFunction(() => window.__relay && (window.__relay.ready || window.__relay.error), null, { timeout: 60000 });
  const boot = await page.evaluate(() => ({ error: window.__relay.error, plan: window.__relay.plan, iso: crossOriginIsolated }));
  if (boot.error) {
    console.log(`${media} : ${boot.error}`);
    await page.close();
    return null;
  }
  console.log(`${media} : plan ${JSON.stringify(boot.plan)}, crossOriginIsolated=${boot.iso}`);
  if (boot.plan?.kind !== 'native' || boot.plan.withoutAudio) {
    console.log(`${media} : pas de chemin audio natif (${JSON.stringify(boot.plan)})`);
    await page.close();
    return null;
  }
  return { page, errors, boot };
}

/** Mesure des segments sur toute la lecture, et vérifications communes. */
async function measure(page, media, label, errors) {
  const seg = await page.evaluate(segStats);
  const lt = await page.evaluate(() => ({ n: window.__longtasks.length, max: Math.max(0, ...window.__longtasks) }));
  const sv = await page.evaluate(() => ({ reads: window.__relay.served.reads, bytes: window.__relay.served.bytes }));
  const st = await page.evaluate(() => (typeof window.__relay.player.stats === 'function' ? window.__relay.player.stats() : null));
  if (st) {
    check(`${media} [${label}] : stats() expose le tampon`, typeof st.bufferAhead === 'number' && typeof st.decodedAhead === 'number', JSON.stringify(st));
    console.log(`${media} [${label}] : tampon compressé ${st.bufferAhead.toFixed(2)} s devant la position, décodé ${st.decodedAhead.toFixed(2)} s`);
  }
  if (seg.worst && seg.maxGapMs >= 1) console.log(`  pire jonction (index ${seg.worst.at}) : écart ${(seg.worst.gap * 1000).toFixed(3)} ms, précédent ${JSON.stringify(seg.worst.prev)}, suivant ${JSON.stringify(seg.worst.cur)}`);
  summary.push({ media, label, segments: seg.n, maxGapMs: seg.maxGapMs, silenceMs: seg.silenceMs, late: seg.late, maxLateMs: seg.maxLateMs, longTasks: lt.n, longTaskMaxMs: lt.max });
  console.log(
    `${media} [${label}] : ${seg.n} segments, écart max |gap| ${seg.maxGapMs.toFixed(3)} ms, silence cumulé ${seg.silenceMs.toFixed(2)} ms, ` +
      `${seg.late} segment(s) en retard (retard max ${seg.maxLateMs.toFixed(2)} ms), tâches longues ${lt.n} (max ${lt.max.toFixed(0)} ms), ` +
      `contexte ${seg.rate} Hz, lectures d'octets ${sv.reads} (${(sv.bytes / 1e6).toFixed(2)} Mo)`,
  );
  check(`${media} [${label}] : écart max entre segments audio programmés < 1 ms`, seg.maxGapMs < 1, `${seg.maxGapMs.toFixed(3)} ms`);
  check(`${media} [${label}] : aucune erreur`, errors.length === 0 && (await page.evaluate(() => window.__relay.errors.length)) === 0, errors.join(' | '));
}

async function run(media) {
  const opened = await openPage(media);
  if (!opened) return false;
  const { page, errors, boot } = opened;
  try {
    check(`${media} : sans COOP/COEP`, boot.iso === false);
    check(`${media} : décodeur wasm choisi`, boot.plan.audioDecoder === 'ac3', JSON.stringify(boot.plan));
    // Lecture différée : le lecteur est chargé, la lecture commence 1,5 s plus tard. Rien ne doit jouer avant.
    await sleep(1500);
    const before = await page.evaluate(() => window.__ctxs.map((c) => c.state));
    check(`${media} : contexte audio suspendu avant la lecture`, before.length > 0 && before.every((st) => st === 'suspended'), before.join(','));
    await page.evaluate(() => window.__relay.player.play());
    await sleep(2000);
    const s1 = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    await sleep(1000);
    const s2 = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    check(`${media} : AudioData programmé`, s1.st.audioChunks > 0 && s2.st.audioChunks > s1.st.audioChunks, `${s1.st.audioChunks} -> ${s2.st.audioChunks} segments`);
    check(`${media} : la position avance`, s2.pos - s1.pos > 0.7, `${s1.pos.toFixed(2)} -> ${s2.pos.toFixed(2)} s`);
    check(`${media} : audio d'avance borné`, s2.st.audioAheadSec > 0 && s2.st.audioAheadSec < 4, `${s2.st.audioAheadSec.toFixed(2)} s`);
    check(`${media} : vidéo décodée en parallèle`, s2.st.decodedFrames > 25, `${s2.st.decodedFrames} images`);
    await page.evaluate(() => window.__relay.player.pause());
    const p1 = await page.evaluate(() => window.__relay.player.getState().position);
    const c1 = (await page.evaluate(() => window.__relay.stats())).audioChunks;
    await sleep(600);
    const p2 = await page.evaluate(() => window.__relay.player.getState().position);
    const c2 = (await page.evaluate(() => window.__relay.stats())).audioChunks;
    check(`${media} : pause fige la position`, Math.abs(p2 - p1) < 0.02, `${p1.toFixed(2)} -> ${p2.toFixed(2)} s`);
    const paused = await page.evaluate(() => window.__ctxs.map((c) => c.state));
    check(`${media} : contexte audio suspendu pendant la pause`, paused.every((st) => st === 'suspended'), paused.join(','));
    check(`${media} : pause ne programme plus d'audio au-delà de la marge`, c2 - c1 <= 40, `${c2 - c1} segments`);
    // Reprise sans seek : la jonction pause/reprise doit aussi être sans trou ni chevauchement.
    await page.evaluate(() => window.__relay.player.play());
    await sleep(500);
    await page.evaluate(() => window.__audioLog.push(null));
    await page.evaluate(() => window.__relay.player.seek(3));
    await page.evaluate(() => window.__relay.player.play());
    await sleep(1500);
    const k = await page.evaluate(() => ({ st: window.__relay.stats(), pos: window.__relay.player.getState().position }));
    check(`${media} : seek à 3 s puis lecture`, k.pos > 3.8 && k.pos < 5.2, `position ${k.pos.toFixed(2)} s, ${k.st.seeks} seeks`);
    check(`${media} : audio programmé après le seek`, k.st.audioChunks - c2 > 20, `${k.st.audioChunks - c2} segments depuis la pause`);
    await measure(page, media, 'lecture, pause, reprise, seek', errors);
    return true;
  } finally {
    await page.close();
  }
}

/** Blocage du fil principal pendant la lecture (GC, minuteries ralenties) : le tampon audio doit tenir sans trou. */
async function runBlock(media) {
  const opened = await openPage(media);
  if (!opened) return false;
  const { page, errors } = opened;
  try {
    await page.evaluate(() => window.__relay.player.play());
    await sleep(1000);
    await page.evaluate((ms) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // attente active volontaire : le fil principal est bloqué
      }
    }, BLOCK_MS);
    await sleep(1500);
    const pos = await page.evaluate(() => window.__relay.player.getState().position);
    check(`${media} : la position avance pendant et après le blocage`, pos > 3, `${pos.toFixed(2)} s après ${BLOCK_MS} ms de blocage`);
    await measure(page, media, `blocage du fil principal ${BLOCK_MS} ms`, errors);
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
  await runBlock('test-eac3.mp4');
} finally {
  await browser.close();
  await server.close();
}
if (summary.length > 0) {
  console.log('--- synthèse (écarts entre segments audio programmés) ---');
  for (const s of summary) {
    console.log(
      `${s.media} [${s.label}] : segments ${s.segments}, écart max ${s.maxGapMs.toFixed(3)} ms, silence cumulé ${s.silenceMs.toFixed(2)} ms, ` +
        `en retard ${s.late} (max ${s.maxLateMs.toFixed(2)} ms), tâches longues ${s.longTasks} (max ${s.longTaskMaxMs.toFixed(0)} ms)`,
    );
  }
}
console.log(failed ? `${failed} vérification(s) en échec` : 'tout est vert');
process.exit(failed ? 1 : 0);
