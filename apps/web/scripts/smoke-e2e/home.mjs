// Test de fumée e2e : sert le build de production (dist/, comme `vite preview`) et l'ouvre dans Chromium headless.
// Vérifie que l'application monte son premier écran (la page « Connexion », accueil d'un visiteur sans compte) et
// qu'aucune erreur JavaScript n'échappe au chargement. Aucun réseau externe : polices, Sentry et serveur Laststream
// sont bloqués, le test ne dépend donc ni d'internet ni d'un lastAddon. Pas de fenêtre visible (headless).
//
// Usage : npm run build && npm run smoke:e2e
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREEN_TIMEOUT_MS = 60_000;

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html absent : lancer `npm run build` avant le test de fumée.');
  process.exit(2);
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const server = await preview({
  configFile: false,
  root,
  logLevel: 'warn',
  preview: { host: '127.0.0.1', port: 4173 },
});
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.route('**/*', (route) => {
    const { origin } = new URL(route.request().url());
    return origin === base ? route.continue() : route.abort();
  });

  await page.goto(`${base}/`, { waitUntil: 'load' });
  const screen = page.getByRole('heading', { level: 1, name: 'Connexion', exact: true });
  const shown = await screen.waitFor({ state: 'visible', timeout: SCREEN_TIMEOUT_MS }).then(() => true, () => false);
  check("l'écran d'accueil (connexion) s'affiche", shown, shown ? '' : `titre « Connexion » absent après ${SCREEN_TIMEOUT_MS / 1000} s`);
  check('aucune erreur JavaScript non interceptée', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser?.close();
  await server.close();
}

if (failures.length > 0) {
  console.error(`Test de fumée en échec : ${failures.join(', ')}`);
  process.exitCode = 1;
}
