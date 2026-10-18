import { resolve } from 'node:path';

/** Options de ligne de commande, reportées dans l'environnement au démarrage (voir start() dans server.ts). */
export interface CliOptions {
  /** Port d'écoute, brut : validé par resolvePort. */
  port?: string;
  /** Dossier de l'interface web, absolu. */
  uiDir?: string;
  /** Dossier des données utilisateur, absolu. */
  dataDir?: string;
}

const OPTION_KEYS: Readonly<Record<string, keyof CliOptions>> = {
  '--port': 'port',
  '--ui': 'uiDir',
  '--data': 'dataDir',
};

/**
 * Lit --port, --ui et --data, en forme `--option valeur` ou `--option=valeur`. Les chemins sont résolus depuis `cwd`.
 * Une option inconnue ou sans valeur lève une erreur.
 */
export function parseCliArgs(argv: readonly string[], cwd: string): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!Object.hasOwn(OPTION_KEYS, flag)) {
      throw new Error(`option inconnue : ${flag} (options : --port <n>, --ui <dossier>, --data <dossier>)`);
    }
    let value: string | undefined;
    if (eq === -1) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`${flag} exige une valeur`);
    }
    const key = OPTION_KEYS[flag] ?? 'port';
    options[key] = key === 'port' ? value.trim() : resolve(cwd, value);
  }
  return options;
}
