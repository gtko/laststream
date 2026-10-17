import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { getSecret, isPlainAllowed, loadEnvFile } from './config/secret.js';

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
  const port = resolvePort(process.env.PORT);
  const app = createApp({ secret: getSecret(), allowPlain: isPlainAllowed() });
  if (isPlainAllowed()) {
    console.warn('LASTADDON_ALLOW_PLAIN=1 : configurations en JSON brut acceptées (non chiffrées).');
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
