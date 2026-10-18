import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Racine du projet (src/platform/node ou dist/platform/node : trois niveaux au-dessus). Dans le bundle mono-fichier,
 * import.meta.url est simulé à <dossier du bundle>/bundle/entry/node/ : la racine est alors le dossier du bundle.
 */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
