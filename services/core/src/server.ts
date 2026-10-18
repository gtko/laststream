import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { parseCliArgs, type CliOptions } from './cli.js';
import { assertStartupEnv, configuredPublicUrl, configuredStreamingServer, configuredUiDir, isPublicMode } from './config/runtime-env.js';
import { getSecret, isPlainAllowed, loadEnvFile } from './config/secret.js';
import { detectLocalProwlarr, type LocalProwlarrIo, localProwlarrEnabled } from './sources/local-prowlarr.js';
import { assertUiDir, sameOriginsFor } from './ui.js';

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

/** Reporte les options de ligne de commande dans l'environnement (prioritaires sur .env et sur l'environnement hérité). */
function applyCliOptions(options: CliOptions): void {
  if (options.port !== undefined) process.env.PORT = options.port;
  if (options.uiDir !== undefined) process.env.LASTADDON_UI_DIR = options.uiDir;
  if (options.dataDir !== undefined) process.env.LASTADDON_DATA_DIR = options.dataDir;
}

/**
 * Démarre le serveur. Options : --port, --ui, --data (voir README, « Distribution »). Une fois à l'écoute, imprime
 * `LASTADDON_READY port=<n>` : les applications packagées attendent cette ligne.
 */
export function start(argv: readonly string[] = process.argv.slice(2)): void {
  let port: number;
  let secret: string;
  let uiDir: string | undefined;
  let uiOrigins: string[] | undefined;
  let streamingServer: string | undefined;
  try {
    applyCliOptions(parseCliArgs(argv, process.cwd()));
    loadEnvFile();
    port = resolvePort(process.env.PORT);
    assertStartupEnv();
    secret = getSecret();
    uiDir = configuredUiDir();
    if (uiDir !== undefined) {
      assertUiDir(uiDir);
      uiOrigins = sameOriginsFor(port, configuredPublicUrl());
      streamingServer = configuredStreamingServer();
    }
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
    uiDir,
    uiOrigins,
    streamingServer,
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
    if (uiDir !== undefined) console.log(`Interface web servie depuis ${uiDir}`);
    console.log(`LASTADDON_READY port=${port}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Impossible de démarrer sur le port ${port} : ${err.code ?? err.name}`);
    process.exit(1);
  });
}

if (isDirectRun()) {
  start();
}
