#!/usr/bin/env node
// Mesure de réactivité en web (mode démo) : délai entre un clic et la première réaction visible de l'interface.
//
// Pour chaque action, un clic réel (Playwright) puis :
//   - délai          = première mutation du DOM après le clic (aria-*, class, hidden, data-*, ajout ou retrait de nœuds) ;
//   - clic → image   = première image peinte après cette mutation (requestAnimationFrame × 2) ;
//   - traitement     = durée de traitement de l'événement « click » (PerformanceObserver type 'event', durationThreshold 16).
//
// Usage : node scripts/reactivity-e2e/measure.mjs [--url http://localhost:PORT] [--json]
//   --url   mesure une app déjà lancée ; sinon Vite démarre sur un port libre et est arrêté à la fin, même en cas d'erreur.
//   --json  ajoute le résultat complet (JSON) sur stdout, après le tableau.
// Mode démo : ?demo=1&clean=1 (src/demoBoot.ts, src/data/demo.ts). Chromium headless uniquement.
// Code de sortie 0 même au-delà de 100 ms : c'est une mesure, pas un test (1 seulement si la mesure est impossible).
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REPS = 10;
const SETTLE_MS = 600; // au-delà des cooldowns de l'app (350 et 400 ms) et des toasts courts
const VIEWPORT = { width: 1280, height: 800 };
const DEMO_PATH = '/?demo=1&clean=1';
const MAX_CONSECUTIVE_ERRORS = 2;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const log = (message) => process.stderr.write(`${message}\n`);
const valueOf = (args, name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1] ?? null;
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

/** Code exécuté dans la page avant chaque document : écouteurs permanents, actifs seulement quand window.__rx est armé. */
function initInPage() {
  window.__rxEvents = [];
  window.__rx = null;
  const isElement = (node) => node.nodeType === 1;
  const relevant = (record) => {
    if (record.type === 'childList') return [...record.addedNodes, ...record.removedNodes].some(isElement);
    const name = record.attributeName || '';
    return name === 'class' || name === 'hidden' || name.startsWith('aria-') || name.startsWith('data-');
  };
  window.addEventListener('click', () => {
    const rx = window.__rx;
    if (rx && rx.clickAt === null) rx.clickAt = performance.now();
  }, true);
  new MutationObserver((records) => {
    const rx = window.__rx;
    if (!rx || rx.clickAt === null || rx.mutAt !== null) return;
    const hits = records.filter(relevant);
    if (!hits.length) return;
    rx.mutAt = performance.now();
    rx.kind = hits.slice(0, 3)
      .map((r) => (r.type === 'attributes' ? `attr ${r.attributeName}` : `nœuds +${r.addedNodes.length} -${r.removedNodes.length}`))
      .join(', ');
    requestAnimationFrame(() => requestAnimationFrame(() => { rx.paintAt = performance.now(); }));
  }).observe(document, { subtree: true, childList: true, attributes: true });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__rxEvents.push({ name: e.name, startTime: e.startTime, duration: e.duration, processing: e.processingEnd - e.processingStart });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  } catch {
    // Event Timing indisponible : la colonne « traitement » reste vide.
  }
}

function armInPage() {
  window.__rxEvents.length = 0;
  window.__rx = { armedAt: performance.now(), clickAt: null, mutAt: null, paintAt: null, kind: null };
}

function readInPage() {
  const rx = window.__rx;
  const clicks = window.__rxEvents.filter((e) => e.name === 'click' && e.startTime >= rx.armedAt);
  let event = null;
  if (clicks.length && rx.clickAt !== null) {
    event = clicks.reduce((a, b) => (Math.abs(b.startTime - rx.clickAt) < Math.abs(a.startTime - rx.clickAt) ? b : a));
  }
  return { ...rx, processing: event ? event.processing : null };
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function startVite() {
  const port = await freePort();
  const vite = await createServer({ root: repoRoot, logLevel: 'warn', server: { host: '127.0.0.1', port, strictPort: true } });
  await vite.listen();
  return { base: `http://127.0.0.1:${port}`, close: () => vite.close() };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!existsSync(CHROME_PATH)) throw error;
    log(`Chromium de Playwright indisponible (${firstLine(error)}) : repli sur Chrome installé.`);
    return chromium.launch({ headless: true, executablePath: CHROME_PATH });
  }
}

async function openHome(page, base) {
  await page.goto(base + DEMO_PATH, { waitUntil: 'load' });
  try {
    await page.locator('[data-tile^="movie:"]').first().waitFor({ state: 'visible', timeout: 90000 });
  } catch {
    const demo = await page.evaluate(() => document.body?.dataset.demo ?? '');
    throw new Error(demo === '1' ? 'accueil démo sans film (catalogue vide ou injoignable)' : 'mode démo non activé (serveur injoignable ?)');
  }
}

/** Un clic réel, puis la première réaction : délai, clic → image, traitement. */
async function measureClick(page, target) {
  // Le bandeau d'état (#toast) retombe 2,4 s après son affichage : on attend qu'il soit retombé, sinon son retrait
  // compterait comme une réaction du clic suivant.
  await page.waitForFunction(() => !document.getElementById('toast')?.classList.contains('is-on'), null, { timeout: 6000, polling: 100 }).catch(() => {});
  await page.evaluate(armInPage);
  await target.click({ timeout: 10000 });
  await page.waitForFunction(() => Boolean(window.__rx && window.__rx.paintAt !== null), null, { timeout: 3000, polling: 'raf' }).catch(() => {});
  await sleep(SETTLE_MS);
  const r = await page.evaluate(readInPage);
  if (r.clickAt === null) return { error: 'clic non reçu (élément couvert ?)' };
  if (r.mutAt === null) return { noReaction: true };
  return {
    delayMs: r.mutAt - r.clickAt,
    paintMs: r.paintAt === null ? null : r.paintAt - r.clickAt,
    processingMs: r.processing,
    kind: r.kind,
  };
}

function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const p95 = v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)];
  return { n: v.length, median, p95, max: v[v.length - 1] };
}

function summarize(name, samples) {
  const ok = samples.filter((s) => typeof s.delayMs === 'number');
  const errors = samples.filter((s) => s.error).map((s) => s.error);
  return {
    name,
    reps: samples.length,
    reactions: ok.length,
    noReaction: samples.filter((s) => s.noReaction).length,
    skipped: ok.length ? null : (errors[0] ?? 'aucune réaction visible'),
    delayMs: stats(ok.map((s) => s.delayMs)),
    paintMs: stats(ok.map((s) => s.paintMs)),
    processingMs: stats(ok.map((s) => s.processingMs)),
    kinds: [...new Set(ok.map((s) => s.kind))],
    samples,
  };
}

async function runAction(page, actions, name, { step, afterRep }) {
  const samples = [];
  let consecutiveErrors = 0;
  for (let i = 0; i < REPS; i++) {
    try {
      const target = await step();
      samples.push(await measureClick(page, target));
    } catch (error) {
      samples.push({ error: firstLine(error) });
    }
    consecutiveErrors = samples.at(-1).error ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
    if (afterRep) await afterRep().catch(() => {});
  }
  const summary = summarize(name, samples);
  actions.push(summary);
  log(`${name} : ${summary.reactions}/${summary.reps} réactions${summary.skipped ? ` (${summary.skipped})` : ''}`);
}

function formatTable(report) {
  const head = ['Action', 'Réactions', 'Délai méd.', 'p95', 'max', 'Clic→image méd.', 'p95', 'max', 'Traitement méd.'];
  const fmt = (s, key) => (s ? s[key].toFixed(1) : '—');
  const rows = report.actions.map((a) => [
    a.name,
    `${a.reactions}/${a.reps}`,
    fmt(a.delayMs, 'median'), fmt(a.delayMs, 'p95'), fmt(a.delayMs, 'max'),
    fmt(a.paintMs, 'median'), fmt(a.paintMs, 'p95'), fmt(a.paintMs, 'max'),
    fmt(a.processingMs, 'median'),
  ]);
  const widths = head.map((_, i) => Math.max(...[head, ...rows].map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' | ');
  const out = [
    `Réactivité en démo (${report.browser}, viewport ${report.viewport.width}x${report.viewport.height}, ${report.reps} répétitions, ${report.base})`,
    '',
    line(head),
    widths.map((w) => '-'.repeat(w)).join('-+-'),
    ...rows.map(line),
    '',
    'Valeurs en ms. Délai = première mutation du DOM − clic ; clic → image = première image peinte − clic ; médianes, p95 et max sur les réactions.',
  ];
  for (const a of report.actions) {
    if (a.skipped) out.push(`Non mesurée : ${a.name} (${a.skipped}).`);
    else if (a.noReaction) out.push(`${a.name} : ${a.noReaction} clic(s) sans réaction visible.`);
  }
  for (const note of report.notes) out.push(`Non mesurée : ${note}.`);
  out.push(`Erreurs JS de page pendant la mesure : ${report.pageErrors}.`);
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const urlArg = valueOf(args, '--url');
  const wantJson = args.includes('--json');
  const actions = [];
  const notes = [];
  const pageErrors = [];
  let server = null;
  let browser = null;
  let browserLabel = '';
  let base = urlArg ? urlArg.replace(/\/$/, '') : null;
  try {
    if (!base) {
      server = await startVite();
      base = server.base;
    }
    browser = await launchBrowser();
    browserLabel = `Chromium ${browser.version()}`;
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    await context.addInitScript(initInPage);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(firstLine(error)));

    log(`Accueil démo : ${base}${DEMO_PATH} (premier chargement non mesuré)`);
    await openHome(page, base);

    const movieTile = () => page.locator('[data-tile^="movie:"]').first();
    const ficheReady = () => page.locator('#detail [data-watch-movie]');
    const backToHome = async () => {
      await ficheReady().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      if (await page.locator('#detail').isVisible()) await page.evaluate(() => history.back());
      await movieTile().waitFor({ state: 'visible', timeout: 30000 });
    };
    const group = async (label, fn) => {
      try {
        await fn();
      } catch (error) {
        notes.push(`${label} (${firstLine(error)})`);
        log(`${label} : ${firstLine(error)}`);
      }
    };

    await group('ouvrir une fiche', () => runAction(page, actions, 'ouvrir une fiche (affiche)', {
      step: () => movieTile(),
      afterRep: backToHome,
    }));

    await group('actions de fiche', async () => {
      await movieTile().click({ timeout: 10000 });
      await ficheReady().waitFor({ state: 'visible', timeout: 30000 });
      await runAction(page, actions, 'bibliothèque : ajouter / retirer', { step: () => page.locator('#detail [data-lib]').first() });
      await runAction(page, actions, '« vu » (film)', { step: () => ficheReady().first() });
      await runAction(page, actions, 'suivre', { step: () => page.locator('#detail [data-follow]').first() });
      // Démo : la lecture est refusée par un bandeau (« lecture désactivée ») ; Échap, lui, ramènerait à l'accueil.
      await runAction(page, actions, 'lecture (bouton Lecture)', { step: () => page.locator('#detail [data-play]').first() });
      await backToHome();
    });

    await group('menu contextuel', () => runAction(page, actions, 'menu contextuel : bibliothèque', {
      step: async () => {
        await movieTile().click({ button: 'right', timeout: 10000 });
        const item = page.locator('[data-ctx="lib"]').first();
        await item.waitFor({ state: 'visible', timeout: 5000 });
        return item;
      },
    }));

    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }

  const report = {
    generatedAt: new Date().toISOString(),
    base,
    browser: browserLabel,
    viewport: VIEWPORT,
    reps: REPS,
    settleMs: SETTLE_MS,
    pageErrors: pageErrors.length,
    pageErrorSamples: pageErrors.slice(0, 5),
    notes,
    actions,
  };
  console.log(formatTable(report));
  if (wantJson) {
    console.log('--- JSON ---');
    console.log(JSON.stringify(report, null, 2));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log(`Mesure impossible : ${error?.message ?? error}`);
    process.exit(1);
  });
