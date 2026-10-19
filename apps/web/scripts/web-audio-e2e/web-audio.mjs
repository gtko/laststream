// Test headless du son de repli web : H.264 + E-AC-3 (MP4 et MKV) servi en local avec CORS (Range), lu par le vrai HtmlEngine
// et le moteur audio de repli (mediabunny + @mediabunny/ac3 -> WebAudio) dans Chrome. Mesures : son produit, trous entre
// segments, dérive audio/vidéo après 30 s, pause / seek / volume / vitesse, préchargement, CORS refusé (alternative proposée), DTS.
//
// Usage : node scripts/web-audio-e2e/web-audio.mjs     (WEB_AUDIO_OUT=<dossier> pour les fichiers générés ; WEB_AUDIO_BROWSER=chromium
// pour le Chromium de Playwright (sans H.264) au lieu de Chrome ; WEB_AUDIO_SECONDS pour la durée de la mesure de dérive.)
// Les serveurs (Vite, fichiers) vivent dans ce processus et sont arrêtés à la fin ; le navigateur est headless.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.WEB_AUDIO_OUT ?? join(here, '.out'));
const measureSeconds = Number(process.env.WEB_AUDIO_SECONDS ?? 32);
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

// ---- Médias : image de test, un bip de 100 ms au début de chaque seconde (sert à mesurer le calage), son 5.1 ----
mkdirSync(out, { recursive: true });
const DUR = 120;
const video = ['-f', 'lavfi', '-i', `testsrc2=duration=${DUR}:size=640x360:rate=25`];
const beeps = ['-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*880*t)*0.8*lt(mod(t\\,1)\\,0.1):s=48000:d=${DUR}`];
const v264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '2M', '-maxrate', '2M', '-bufsize', '4M', '-g', '25'];
const files = {
  mp4: join(out, 'eac3.mp4'), mkv: join(out, 'eac3.mkv'), aac: join(out, 'aac.mp4'), dts: join(out, 'dts.mkv'),
};
if (!existsSync(files.mp4)) ffmpeg([...video, ...beeps, ...v264, '-c:a', 'eac3', '-ac', '6', '-b:a', '384k', '-movflags', '+faststart', files.mp4]);
if (!existsSync(files.mkv)) ffmpeg([...video, ...beeps, ...v264, '-c:a', 'eac3', '-ac', '6', '-b:a', '384k', files.mkv]);
if (!existsSync(files.aac)) ffmpeg([...video, ...beeps, ...v264, '-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-movflags', '+faststart', files.aac]);
let haveDts = true;
if (!existsSync(files.dts)) {
  try { ffmpeg([...video, ...beeps, ...v264, '-c:a', 'dca', '-strict', '-2', '-ac', '6', '-b:a', '768k', files.dts]); } catch { haveDts = false; }
}

// ---- Serveur de fichiers local : Range, avec ou sans CORS ----
const requests = [];
const media = createHttp((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // /redir/ : comme un hébergeur débrideur, 302 vers un fichier sans CORS (la redirection casse la sonde : c'est le cas réel).
  if (url.pathname.startsWith('/redir/')) {
    res.writeHead(302, { Location: url.pathname.replace('/redir/', '/nocors/'), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range' });
    res.end();
    return;
  }
  // /slow/ : CORS permis, mais les plages (hors sonde d'un octet) n'obtiennent de réponse qu'après 25 s.
  const slow = url.pathname.startsWith('/slow/');
  const cors = url.pathname.startsWith('/cors/') || slow;
  const name = url.pathname.replace(/^\/(cors|nocors|slow)\//, '');
  const file = join(out, name);
  const headers = {};
  if (cors) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers); res.end(); return; }
  if (slow && req.method === 'GET' && req.headers.origin && req.headers.range && req.headers.range !== 'bytes=0-0') { // seulement les requêtes de la page (fetch CORS), pas celles du <video>
    setTimeout(() => { if (!res.writableEnded) { res.writeHead(503, headers); res.end(); } }, 25000);
    return;
  }
  const size = statSync(file).size;
  const type = name.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  requests.push({ path: url.pathname, range: req.headers.range ?? null, method: req.method });
  if (range) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start >= size || start > end) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
});
await new Promise((r) => media.listen(5311, '127.0.0.1', r));
const mediaBase = 'http://127.0.0.1:5311';

const vite = await createServer({ configFile: false, root: join(here, 'harness'), logLevel: 'warn', server: { host: '127.0.0.1', port: 5312, strictPort: true, fs: { strict: false } } });
await vite.listen();
const pageUrl = vite.resolvedUrls.local[0];

const browserName = process.env.WEB_AUDIO_BROWSER ?? 'chrome';
const browser = await chromium.launch({
  headless: true,
  ...(browserName === 'chrome' ? { channel: 'chrome' } : {}),
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 700, height: 420 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__tap = { analyser: null, ctx: null };
    const orig = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      try {
        if (dest instanceof AudioDestinationNode && !this.__tapped) {
          this.__tapped = true;
          const an = this.context.createAnalyser();
          an.fftSize = 512;
          orig.call(this, an);
          window.__tap.analyser = an;
          window.__tap.ctx = this.context;
        }
      } catch { /* ignoré */ }
      return orig.call(this, dest, ...rest);
    };
  });
  await page.goto(pageUrl);
  await page.waitForFunction(() => window.__w);
  return { page, errors };
}

const stats = (page) => page.evaluate(() => window.__w.stats());
const pos = (page) => page.evaluate(() => window.__w.video.currentTime);
const wait = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

async function scenario(label, file, { sound = true } = {}) {
  console.log(`\n== ${label} ==`);
  const { page, errors } = await newPage();
  try {
    const env = await page.evaluate(() => window.__w.env());
    console.log(`navigateur : ${env.ua.match(/Chrome\/[\d.]+/)?.[0]} ; canPlayType ec-3='${env.eac3}' ac-3='${env.ac3}' aac='${env.aac}' ; isolated=${env.isolated}`);
    const t0 = Date.now();
    const plan = await page.evaluate((u) => window.__w.run(u), `${mediaBase}/cors/${file}`);
    console.log(`plan : ${JSON.stringify(plan)} (${Date.now() - t0} ms jusqu'au plan)`);
    check(`${label} : mode « app » (le navigateur ne décode pas le son)`, plan.mode === 'app', JSON.stringify(plan));
    if (plan.mode !== 'app') return;

    // Démarrage : attente du son (« chargement du son »), puis lecture.
    await wait(page, () => window.__w.video.currentTime > 1.0, null, 40000);
    const startMs = Date.now() - t0;
    console.log(`la vidéo a dépassé 1 s de lecture après ${startMs} ms (attente du son comprise)`);
    const st1 = await stats(page);
    check(`${label} : attente du son au démarrage`, st1.holds >= 1, `holds=${st1.holds}`);
    const native = await page.evaluate(() => window.__w.decodedBytes());
    console.log(`webkitAudioDecodedByteCount natif = ${native} (0 = piste native muette)`);

    // Son produit : l'analyseur voit le signal ; segments PCM programmés ; pas de trou.
    await sleep(2500);
    let maxRms = 0;
    for (let i = 0; i < 40; i++) { maxRms = Math.max(maxRms, await page.evaluate(() => window.__w.rms())); await sleep(40); }
    check(`${label} : son produit en sortie`, maxRms > 0.05, `rms max ${maxRms.toFixed(3)}`);
    const st2 = await stats(page);
    check(`${label} : segments PCM décodés et programmés`, st2.chunksScheduled > 100, `${st2.chunksScheduled} segments`);
    check(`${label} : tampon ≥ 3 s décodées d'avance, ≤ 8 s`, st2.aheadSec >= 3 && st2.aheadSec <= 8.3, `${st2.aheadSec.toFixed(2)} s`);
    check(`${label} : compressé préchargé ≥ 30 s`, st2.prefetchedSec >= 30, `${st2.prefetchedSec.toFixed(1)} s (${(st2.prefetchedBytes / 1048576).toFixed(1)} Mo en cache, borne 48 Mo)`);
    check(`${label} : mémoire bornée`, st2.prefetchedBytes <= 48 * 1048576 && st2.queuedBytes <= 12 * 1048576, `cache ${(st2.prefetchedBytes / 1048576).toFixed(1)} Mo, PCM ${(st2.queuedBytes / 1048576).toFixed(1)} Mo`);

    // Dérive : mesure sur `measureSeconds` secondes de lecture continue.
    await page.evaluate(() => { window.__w.edges.length = 0; });
    const from = await pos(page);
    const before = await stats(page);
    const driftSamples = [];
    const t1 = Date.now();
    while (Date.now() - t1 < measureSeconds * 1000) {
      const s = await stats(page);
      driftSamples.push(s.driftMs);
      await sleep(250);
    }
    const to = await pos(page);
    const after = await stats(page);
    const edges = await page.evaluate(() => window.__w.edges.slice());
    const latency = await page.evaluate(() => window.__tap.ctx?.outputLatency ?? 0);
    console.log(`lu de ${from.toFixed(2)} s à ${to.toFixed(2)} s (${(to - from).toFixed(2)} s de média en ${measureSeconds} s)`);
    check(`${label} : la lecture avance en temps réel`, Math.abs(to - from - measureSeconds) < 1.5, `${(to - from).toFixed(2)} s`);
    check(`${label} : pas de trou entre segments (${after.chunksScheduled - before.chunksScheduled} segments)`, after.gaps === 0 && after.late === before.late, `gaps=${after.gaps} segments en retard=${after.late - before.late}`);
    check(`${label} : aucune attente du son pendant la mesure`, after.holds === before.holds, `holds ${before.holds} -> ${after.holds}`);
    const maxDrift = Math.max(...driftSamples.map(Math.abs));
    check(`${label} : dérive interne < 80 ms sur ${measureSeconds} s`, maxDrift < 80, `max ${maxDrift.toFixed(1)} ms, recalages ${after.resyncs - before.resyncs}`);
    const offsets = edges.filter((e) => e.videoTime > from + 1).map((e) => (e.offset + latency) * 1000);
    if (offsets.length >= 10) {
      const m = mean(offsets);
      const mx = Math.max(...offsets.map(Math.abs));
      check(`${label} : calage bip/vidéo mesuré sur ${offsets.length} bips < 80 ms`, Math.abs(m) < 80 && mx < 120, `moyenne ${m.toFixed(1)} ms, max |écart| ${mx.toFixed(1)} ms (latence de sortie ${(latency * 1000).toFixed(0)} ms compensée)`);
    } else check(`${label} : bips détectés`, false, `${offsets.length} bips`);

    // Volume / muet.
    await page.evaluate(() => window.__w.setVolume(0.3));
    await sleep(300);
    let r3 = 0;
    for (let i = 0; i < 40; i++) { r3 = Math.max(r3, await page.evaluate(() => window.__w.rms())); await sleep(40); }
    check(`${label} : volume 0,3 réduit le niveau`, r3 < maxRms * 0.6 && r3 > 0.005, `${maxRms.toFixed(3)} -> ${r3.toFixed(3)}`);
    await page.evaluate(() => window.__w.setMuted(true));
    await sleep(300);
    let r4 = 0;
    for (let i = 0; i < 25; i++) { r4 = Math.max(r4, await page.evaluate(() => window.__w.rms())); await sleep(40); }
    const es = await page.evaluate(() => window.__w.engineState());
    check(`${label} : muet coupe le son (état muet=${es.muted})`, r4 < 0.002 && es.muted === true, `rms ${r4.toFixed(4)}`);
    await page.evaluate(() => { window.__w.setMuted(false); window.__w.setVolume(1); });

    // Pause / reprise.
    await page.evaluate(() => window.__w.pause());
    await sleep(500);
    const pp = await pos(page);
    await sleep(800);
    const pp2 = await pos(page);
    check(`${label} : pause fige image et son`, Math.abs(pp2 - pp) < 0.02 && (await page.evaluate(() => window.__w.rms())) < 0.002, `${pp.toFixed(2)} -> ${pp2.toFixed(2)}`);
    await page.evaluate(() => window.__w.play());
    await wait(page, (p) => window.__w.video.currentTime > p + 1.5, pp2);
    await sleep(500);
    const sr = await stats(page);
    check(`${label} : reprise après pause, dérive < 80 ms`, Math.abs(sr.driftMs) < 80 && !sr.holding, `dérive ${sr.driftMs.toFixed(1)} ms`);

    // Seek : attente du son, puis reprise à la nouvelle position.
    const seeks0 = (await stats(page)).seeks;
    await page.evaluate(() => window.__w.seek(75));
    let sawWait = false;
    const tSeek = Date.now();
    for (let i = 0; i < 200; i++) {
      const e = await page.evaluate(() => window.__w.engineState());
      if (e.soundWait) sawWait = true;
      if (e.time > 76 && !e.soundWait && !e.paused) break;
      await sleep(50);
    }
    const e2 = await page.evaluate(() => window.__w.engineState());
    check(`${label} : seek à 75 s, reprise avec le son`, e2.time > 76 && !e2.paused, `position ${e2.time.toFixed(2)} s en ${Date.now() - tSeek} ms, attente du son vue=${sawWait}`);
    await sleep(1500);
    let r5 = 0;
    for (let i = 0; i < 40; i++) { r5 = Math.max(r5, await page.evaluate(() => window.__w.rms())); await sleep(40); }
    const ss = await stats(page);
    check(`${label} : son après seek`, r5 > 0.05 && ss.seeks > seeks0, `rms ${r5.toFixed(3)}, seeks ${ss.seeks}`);
    check(`${label} : dérive < 80 ms après seek`, Math.abs(ss.driftMs) < 80, `${ss.driftMs.toFixed(1)} ms`);

    // Vitesse 1,5 x : le son suit l'horloge vidéo.
    await page.evaluate(() => window.__w.setRate(1.5));
    await sleep(4000);
    const sp = await stats(page);
    check(`${label} : vitesse 1,5 x, dérive < 80 ms`, Math.abs(sp.driftMs) < 80, `${sp.driftMs.toFixed(1)} ms, recalages ${sp.resyncs}`);
    await page.evaluate(() => window.__w.setRate(1));
    await sleep(500);

    const reqs = requests.filter((r) => r.path.endsWith(file));
    console.log(`requêtes Range reçues : ${reqs.length}, GET sans Range : ${reqs.filter((r) => !r.range).length}`);
    check(`${label} : aucune erreur de page`, errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await page.close();
  }
}

try {
  await scenario('MP4 H.264 + E-AC-3 5.1', 'eac3.mp4');
  await scenario('MKV H.264 + E-AC-3 5.1', 'eac3.mkv');

  console.log('\n== CORS refusé ==');
  {
    const { page } = await newPage();
    const alts = [
      { index: 0, filename: 'Film.1080p.WEB-DL.DDP5.1.x264.mkv', playable: true, stream: { url: 'https://h/0' } },
      { index: 1, filename: 'Film.1080p.WEB-DL.AAC.x264.mp4', playable: true, stream: { url: 'https://h/1' } },
      { index: 2, filename: 'Film.2160p.REMUX.DTS-HD.MA.mkv', playable: true, stream: { url: 'https://h/2' } },
    ];
    const plan = await page.evaluate(([u, a]) => window.__w.run(u, { alternatives: a, nameCodec: 'eac3' }), [`${mediaBase}/nocors/eac3.mkv`, alts]);
    check('CORS refusé (nom E-AC-3) : plan « cors » avec la note attendue', plan.mode === 'cors' && plan.note === 'Son non disponible dans le navigateur pour cette source', JSON.stringify(plan));
    await wait(page, () => window.__w.toasts.length >= 2, null, 10000);
    const toasts = await page.evaluate(() => window.__w.toasts.slice());
    check('CORS refusé : source alternative (AAC) proposée', toasts[1]?.message.includes('Film.1080p.WEB-DL.AAC.x264.mp4') && toasts[1].action === 'Essayer', JSON.stringify(toasts[1]));
    await page.evaluate(() => window.__w.state.actions[0]());
    check('CORS refusé : le bouton lance l’alternative', (await page.evaluate(() => window.__w.state.played)).join() === 'Film.1080p.WEB-DL.AAC.x264.mp4');
    await wait(page, () => window.__w.video.currentTime > 1, null, 20000).catch(() => undefined);
    check('CORS refusé : l’image continue (sans son)', (await pos(page)) > 1, `${(await pos(page)).toFixed(2)} s`);
    await page.close();
  }

  console.log('\n== CORS refusé, nom de fichier sans codec : le navigateur muet est détecté en lecture ==');
  {
    const { page } = await newPage();
    const plan = await page.evaluate((u) => window.__w.run(u), `${mediaBase}/nocors/eac3.mp4`);
    check('départ en mode « native » (rien dans le nom)', plan.mode === 'native', JSON.stringify(plan));
    const t0 = Date.now();
    await wait(page, () => window.__w.state.handle.plan.mode !== 'native', null, 15000).catch(() => undefined);
    const after = await page.evaluate(() => window.__w.state.handle.plan);
    check('octets décodés = 0 après 2,5 s de lecture : note CORS', after.mode === 'cors', `${JSON.stringify(after)} après ${Date.now() - t0} ms`);
    await page.close();
  }

  console.log('\n== Redirection vers un hôte sans CORS (cas réel) ==');
  {
    const { page } = await newPage();
    const plan = await page.evaluate((u) => window.__w.run(u, { nameCodec: 'eac3' }), `${mediaBase}/redir/eac3.mkv`);
    check('redirection sans CORS : plan « cors »', plan.mode === 'cors', JSON.stringify(plan));
    await page.close();
  }

  console.log('\n== Source lente : aucune donnée audio en 10 s ==');
  {
    const { page } = await newPage();
    const t0 = Date.now();
    const plan = await page.evaluate((u) => window.__w.run(u, { nameCodec: 'eac3' }), `${mediaBase}/slow/eac3.mkv`);
    console.log(`plan initial : ${JSON.stringify(plan)}`);
    await wait(page, () => window.__w.state.mode === 'error', null, 40000).catch(() => undefined);
    const mode = await page.evaluate(() => window.__w.state.mode);
    check('source lente : abandon du son après environ 10 s, mode « error »', mode === 'error', `mode=${mode} après ${Date.now() - t0} ms`);
    const e = await page.evaluate(() => window.__w.engineState());
    check('source lente : l’image reprend (pas de pause, pas d’attente du son)', !e.paused && !e.soundWait, JSON.stringify({ paused: e.paused, soundWait: e.soundWait, t: e.time }));
    await page.close();
  }

  console.log('\n== AAC : le navigateur joue seul ==');
  {
    const { page } = await newPage();
    const plan = await page.evaluate((u) => window.__w.run(u, { nameCodec: 'aac' }), `${mediaBase}/cors/aac.mp4`);
    check('AAC : mode « native », aucun moteur de repli', plan.mode === 'native' && (await stats(page)) === null, JSON.stringify(plan));
    await sleep(3500);
    const bytes = await page.evaluate(() => window.__w.decodedBytes());
    console.log(`webkitAudioDecodedByteCount = ${bytes}`);
    check('AAC : le navigateur décode le son lui-même', bytes === null || bytes > 0, String(bytes));
    check('AAC : aucune note affichée', (await page.evaluate(() => window.__w.toasts.length)) === 0);
    await page.close();
  }

  if (haveDts) {
    console.log('\n== DTS ==');
    const { page } = await newPage();
    const plan = await page.evaluate((u) => window.__w.run(u), `${mediaBase}/cors/dts.mkv`);
    check('DTS : note « Son DTS non pris en charge par le navigateur »', plan.mode === 'unsupported' && plan.note === 'Son DTS non pris en charge par le navigateur', JSON.stringify(plan));
    await page.close();
  } else console.log('\nDTS : encodeur dca indisponible, scénario ignoré');
} finally {
  await browser.close();
  await vite.close();
  await new Promise((r) => media.close(r));
}
console.log(failed ? `\n${failed} vérification(s) en échec` : '\nTout est vert');
process.exit(failed ? 1 : 0);
