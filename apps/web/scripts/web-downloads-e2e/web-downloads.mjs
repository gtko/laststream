// Test headless des téléchargements web (ODY-199) dans Chromium : le vrai DownloadManager, le vrai stockage OPFS (puis le repli
// IndexedDB) et le vrai transport `fetch`, face à un serveur local à plages (Range) qui fabrique les octets à la volée.
// Scénarios, pour chaque stockage : téléchargement avec COUPURE RÉSEAU au milieu (mode hors ligne du navigateur) puis reprise ;
// rechargement de la page (fichier toujours là, relu SANS réseau) ; rechargement EN PLEIN téléchargement (reprise au dernier segment) ;
// limite d'espace (pause sans corruption, reprise après relèvement) ; quota du navigateur réellement dépassé (CDP, QuotaExceededError) ;
// CORS fermé (échec immédiat, message clair, sans tentatives inutiles) ; en-têtes Content-Range non exposés par CORS.
//
// Usage : node scripts/web-downloads-e2e/web-downloads.mjs
//   WEB_DL_MB=500 pour le fichier de 500 Mo du critère d'acceptation (défaut 48) ; WEB_DL_BROWSER=chrome pour Chrome au lieu du
//   Chromium de Playwright ; WEB_DL_ONLY=opfs|indexeddb pour un seul stockage ; WEB_DL_DELAY=<ms> pour le délai par plage (défaut 80).
// Les serveurs (Vite, médias) vivent dans ce processus et sont arrêtés à la fin ; le navigateur est headless.
import { createServer as createHttp } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const sizeMb = Number(process.env.WEB_DL_MB ?? 48);
const delayMs = Number(process.env.WEB_DL_DELAY ?? 80);
const chunk = Number(process.env.WEB_DL_CHUNK_MB ?? (sizeMb >= 200 ? 8 : 2)) * MB;
const only = process.env.WEB_DL_ONLY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`);
};

// ---- Serveur de médias : octets déterministes (même formule que harness/main.ts), Range, trois niveaux de CORS ----
const byteAt = (i) => (Math.imul(i, 2654435761) >>> 24) & 255;
const requests = [];
const media = createHttp((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const [, mode, sizeText] = url.pathname.split('/');
  const size = Number(sizeText);
  const headers = {};
  if (mode === 'cors') Object.assign(headers, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag', ETag: '"fixe"' });
  if (mode === 'hidden') Object.assign(headers, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' });
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  requests.push({ mode, size, range: req.headers.range ?? null, method: req.method });
  if (!Number.isFinite(size)) { res.writeHead(404, headers); res.end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range ? Math.min(range[2] === '' ? size - 1 : Number(range[2]), size - 1) : size - 1;
  const reply = () => {
    if (res.destroyed) return;
    if (range && start >= size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); res.end(); return; }
    const body = Buffer.allocUnsafe(end - start + 1);
    for (let i = 0; i < body.length; i += 1) body[i] = byteAt(start + i);
    res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), 'Content-Length': body.length });
    res.end(body);
  };
  setTimeout(reply, delayMs);
});
await new Promise((r) => media.listen(5321, '127.0.0.1', r));
const mediaBase = 'http://127.0.0.1:5321';

const vite = await createServer({ configFile: false, root: join(here, 'harness'), logLevel: 'warn', server: { host: '127.0.0.1', port: 5322, strictPort: true, fs: { strict: false } } });
await vite.listen();
const pageOrigin = 'http://127.0.0.1:5322';

const browserName = process.env.WEB_DL_BROWSER ?? 'chromium';
const browser = await chromium.launch({ headless: true, ...(browserName === 'chrome' ? { channel: 'chrome' } : {}) });

async function open(backend) {
  const context = await browser.newContext(); // profil neuf : stockage vide
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${pageOrigin}/?backend=${backend}&media=${encodeURIComponent(mediaBase)}&chunk=${chunk}`);
  await page.waitForFunction(() => window.__d);
  return { context, page, errors };
}
const item = (page) => page.evaluate(() => window.__d.item());
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const label = (name) => (name === 'opfs' ? 'OPFS' : 'IndexedDB');
const firstByte = (range) => Number(/bytes=(\d+)/.exec(range)[1]);

try {
  for (const backend of ['opfs', 'indexeddb']) {
    if (only && only !== backend) continue;
    const total = sizeMb * MB;
    const name = label(backend);
    console.log(`\n=== Stockage ${name} — fichier de ${sizeMb} Mo, morceaux de ${chunk / MB} Mo ===`);

    // ---- 1. Coupure réseau au milieu, reprise, rechargement, lecture hors ligne ----
    {
      const { context, page, errors } = await open(backend);
      const info = await page.evaluate(() => window.__d.info());
      check(`${name} : stockage choisi`, info.backend === backend, `backend=${info.backend} quota=${info.quota} persisted=${info.persisted}`);
      await page.evaluate((n) => window.__d.start('cors', n), total);
      await until(page, (n) => (window.__d.item()?.bytesDone ?? 0) > n, total * 0.3);
      await context.setOffline(true);
      const before = (await item(page)).bytesDone;
      await sleep(2500);
      const frozen = await item(page);
      check('coupure réseau : le téléchargement ne progresse plus et reste en cours (pas d\'erreur)', frozen.bytesDone - before <= chunk && frozen.state !== 'error', `${before} → ${frozen.bytesDone}, état ${frozen.state}`);
      await context.setOffline(false);
      await until(page, () => ['done', 'error'].includes(window.__d.item()?.state));
      const done = await item(page);
      check('reprise après la coupure : terminé', done.state === 'done' && done.bytesDone === total, `${done.state} ${done.bytesDone}/${total} erreur=${done.error}`);
      const v = await page.evaluate((n) => window.__d.verify(n), total);
      check('contenu identique, octet par octet', v.ok, `taille ${v.size}, premier écart ${v.firstBad}`);
      const ranged = requests.filter((r) => r.mode === 'cors' && r.range && firstByte(r.range) > 0).length;
      check('le téléchargement a été fait par plages (Range)', ranged > 0, `${ranged} plages après la première`);

      // Rechargement : le fichier est toujours là et se relit sans réseau.
      await page.reload();
      await page.waitForFunction(() => window.__d);
      await page.evaluate((n) => window.__d.resume('cors', n), total);
      await context.setOffline(true);
      const requestsBefore = requests.length;
      const after = await item(page);
      check('rechargement : le téléchargement est toujours « terminé » (index IndexedDB)', after.state === 'done' && after.bytesDone === total, `${after.state} ${after.bytesDone}`);
      const v2 = await page.evaluate((n) => window.__d.verify(n), total);
      check('rechargement, hors ligne : fichier relu depuis le stockage, contenu identique', v2.ok, `taille ${v2.size}, premier écart ${v2.firstBad}`);
      check('aucune requête réseau pour relire le fichier', requests.length === requestsBefore);
      const usage = await page.evaluate(() => window.__d.usage());
      check('espace occupé = taille du fichier', usage.used === total, `used=${usage.used}`);
      check('aucune erreur de page', errors.length === 0, errors.join(' | '));
      await context.close();
    }

    // ---- 2. Rechargement EN PLEIN téléchargement : reprise au dernier segment, pas de zéro ----
    {
      const { context, page } = await open(backend);
      await page.evaluate((n) => window.__d.start('cors', n), total);
      await until(page, (n) => (window.__d.item()?.bytesDone ?? 0) > n, total * 0.4);
      await page.reload(); // l'onglet « plante » : aucun close() du magasin
      await page.waitForFunction(() => window.__d);
      const stored = await page.evaluate(() => window.__d.storedSize());
      check('onglet rechargé en plein téléchargement : les segments validés sont conservés', stored >= total * 0.4 - chunk && stored < total, `${stored} octets`);
      const mark = requests.length;
      await page.evaluate((n) => window.__d.resume('cors', n), total);
      await until(page, () => ['done', 'error'].includes(window.__d.item()?.state));
      const done = await item(page);
      const firstRange = requests.slice(mark).find((r) => r.range)?.range;
      check('reprise au point conservé (jamais depuis zéro)', done.state === 'done' && !!firstRange && firstByte(firstRange) >= stored - chunk, `première plage ${firstRange}, état ${done.state}`);
      const v = await page.evaluate((n) => window.__d.verify(n), total);
      check('contenu identique après la reprise', v.ok, `taille ${v.size}, premier écart ${v.firstBad}`);
      await context.close();
    }

    // ---- 3. Limite d'espace : pause sans corruption, reprise après relèvement ----
    {
      const { context, page } = await open(backend);
      const limit = Math.floor(total * 0.4);
      await page.evaluate(([n, l]) => window.__d.start('cors', n, l), [total, limit]);
      await until(page, () => ['paused', 'error', 'done'].includes(window.__d.item()?.state));
      const paused = await item(page);
      check('limite atteinte : mis en pause avec le code quota_exceeded', paused.state === 'paused' && paused.error === 'quota_exceeded', `${paused.state} ${paused.error}`);
      const v = await page.evaluate(() => window.__d.verify());
      check('limite atteinte : le début stocké est intact (aucune corruption)', v.ok && v.size > 0 && v.size <= limit, `taille ${v.size} ≤ ${limit}`);
      await page.evaluate(() => { window.__d.setLimit(null); window.__d.resumeItem(); });
      await until(page, () => ['done', 'error'].includes(window.__d.item()?.state));
      const done = await item(page);
      const v2 = await page.evaluate((n) => window.__d.verify(n), total);
      check('limite relevée : le téléchargement reprend et se termine, contenu identique', done.state === 'done' && v2.ok, `${done.state}, ${v2.size} octets`);
      await context.close();
    }

    // ---- 4. Quota du navigateur réellement dépassé (QuotaExceededError) ----
    {
      const { context, page } = await open(backend);
      let cdp = null;
      try {
        cdp = await context.newCDPSession(page);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: pageOrigin, quotaSize: Math.floor(total * 0.4) });
      } catch (err) {
        cdp = null;
        console.log(`SKIP quota navigateur : CDP indisponible (${err.message})`);
      }
      if (cdp) {
        await page.evaluate((n) => window.__d.start('cors', n), total);
        await until(page, () => ['error', 'paused', 'done'].includes(window.__d.item()?.state));
        const err = await item(page);
        // Chromium n'applique pas toujours le quota simulé aux écritures IndexedDB (contrôle différé) : sans erreur, on n'évalue pas.
        if (backend === 'indexeddb' && err.state === 'done') {
          console.log("SKIP quota navigateur : Chromium n'a pas appliqué le quota simulé à IndexedDB (couvert par les tests unitaires)");
        } else {
          check('quota du navigateur dépassé : erreur store_full (et non un plantage)', err.state === 'error' && err.error === 'store_full', `${err.state} ${err.error}`);
          const msg = await page.evaluate(() => window.__d.message('store_full'));
          check('message clair pour l\'utilisateur', /place|espace/i.test(msg) && !/http/i.test(msg), msg);
          const v = await page.evaluate(() => window.__d.verify());
          check('quota dépassé : ce qui est stocké est intact, sans segment partiel', v.ok && v.size > 0 && v.size < total, `taille ${v.size}`);
          const stored = await page.evaluate(() => window.__d.storedSize());
          check('quota dépassé : le point de reprise correspond au fichier relu', stored === v.size, `${stored} / ${v.size}`);
          await cdp.send('Storage.overrideQuotaForOrigin', { origin: pageOrigin, quotaSize: total * 3 });
          await page.evaluate(() => window.__d.retry());
          await until(page, () => ['error', 'done'].includes(window.__d.item()?.state));
          const done = await item(page);
          const v2 = await page.evaluate((n) => window.__d.verify(n), total);
          check('quota relevé : « réessayer » reprend où c\'était arrêté et termine', done.state === 'done' && v2.ok, `${done.state}, ${v2.size} octets`);
        }
      }
      await context.close();
    }

    // ---- 5. CORS fermé : échec immédiat avec un message clair ----
    {
      const { context, page } = await open(backend);
      const before = requests.length;
      await page.evaluate((n) => window.__d.start('nocors', n), 4 * MB);
      await until(page, () => ['error', 'done'].includes(window.__d.item()?.state), undefined, 30000);
      const err = await item(page);
      check('CORS fermé : erreur « content » sans nouvelle tentative réseau', err.state === 'error' && err.error === 'content', `${err.state} ${err.error}`);
      check('CORS fermé : peu de requêtes (pas de boucle de tentatives)', requests.length - before <= 6, `${requests.length - before} requêtes`);
      const msg = await page.evaluate(() => window.__d.message('content'));
      check('CORS fermé : message qui oriente vers l\'application Android ou Windows', /navigateur/.test(msg) && /Android|Windows/.test(msg), msg);
      await context.close();
    }

    // ---- 6. Content-Range non exposé par CORS : déduit de la plage, taille connue à la fin ----
    for (const [kind, n] of [['fin par morceau court', 5 * MB + 1234], ['fin par 416', 4 * MB]]) {
      const { context, page } = await open(backend);
      await page.evaluate((s) => window.__d.start('hidden', s), n);
      await until(page, () => ['error', 'done'].includes(window.__d.item()?.state));
      const done = await item(page);
      const v = await page.evaluate((s) => window.__d.verify(s), n);
      check(`en-têtes non exposés (${kind}, ${n} octets) : terminé, contenu identique`, done.state === 'done' && v.ok && v.size === n, `${done.state} ${done.error} ${v.size}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await vite.close();
  media.close();
}
console.log(failed === 0 ? '\nTous les contrôles sont passés.' : `\n${failed} contrôle(s) en échec.`);
process.exit(failed === 0 ? 0 : 1);
