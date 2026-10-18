import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { isPublicMode, assertStartupEnv } from './config/runtime-env.js';
import { getSecret, isPlainAllowed, loadEnvFile } from './config/secret.js';
import { detectLocalProwlarr, type LocalProwlarrIo, localProwlarrEnabled } from './sources/local-prowlarr.js';

const DEFAULT_PORT = 7000;

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT invalide : entier entre 1 et 65535 attendu');
  }
  return port;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export function start(): void {
  loadEnvFile();
  let port: number;
  let secret: string;
  try {
    port = resolvePort(process.env.PORT);
    assertStartupEnv();
    secret = getSecret();
  } catch (err) {
    // Refus de démarrer : message explicite, sans valeur de configuration ni secret.
    console.error(err instanceof Error ? err.message : 'configuration invalide');
    process.exit(1);
  }
  const localIo: LocalProwlarrIo = {
    env: process.env,
    readFile: (path) => readFileSync(path, 'utf8'),
    homeDir: homedir(),
  };
  const app = createApp({
    secret,
    allowPlain: isPlainAllowed(),
    localProwlarr: () => detectLocalProwlarr(localIo),
  });
  if (isPlainAllowed()) {
    console.warn('LASTADDON_ALLOW_PLAIN=1 : configurations en JSON brut acceptées (non chiffrées).');
  }
  if (isPublicMode()) {
    console.warn('LASTADDON_PUBLIC=1 : mode public actif (adresses privées refusées pour les URL des sources).');
  }
  if (localProwlarrEnabled(process.env)) {
    // Lit la clé une seule fois au démarrage ; le résultat ne contient que le nombre d'indexeurs, jamais la clé.
    void detectLocalProwlarr(localIo).then((local) =>
      console.log(
        local === null
          ? 'Aucun Prowlarr local détecté.'
          : `Prowlarr local détecté (${local.indexerCount} indexeurs), utilisé si aucune source n'est configurée.`,
      ),
    );
  }
  const server = app.listen(port, () => {
    console.log(`lastAddon en écoute sur http://localhost:${port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Impossible de démarrer sur le port ${port} : ${err.code ?? err.name}`);
    process.exit(1);
  });
}

if (isDirectRun()) {
  start();
}
