import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSecretStrength, parseEnvFile, SECRET_KEY, secretFromEnv } from '../../config/secret.js';
import { runtimeEnv } from '../index.js';
import { projectRoot } from './paths.js';

/**
 * Chemin du fichier .env à la racine du projet (relatif à ce module, pas au répertoire courant).
 * LASTADDON_ENV_FILE le remplace (applications packagées) ; chemin relatif résolu depuis la racine du projet.
 */
export function envFilePath(): string {
  const root = projectRoot();
  const override = runtimeEnv().get('LASTADDON_ENV_FILE')?.trim();
  return override ? resolve(root, override) : resolve(root, '.env');
}

/** Charge le .env dans les variables d'exécution sans écraser les variables déjà définies. */
export function loadEnvFile(): void {
  const path = envFilePath();
  if (!existsSync(path)) return;
  const env = runtimeEnv();
  const values = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env.get(key) === undefined) env.set?.(key, value);
  }
}

/**
 * Renvoie la clé de chiffrement des configurations (au moins MIN_SECRET_LENGTH caractères, sinon erreur).
 * Ordre : variable LASTADDON_SECRET, puis .env du projet, sinon génération aléatoire (32 octets, base64url)
 * enregistrée dans .env. La valeur n'est jamais écrite sur la sortie standard.
 */
export function getSecret(path: string = envFilePath()): string {
  const fromEnv = secretFromEnv();
  if (fromEnv !== undefined) return fromEnv;

  const fileValues = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  const fromFile = fileValues[SECRET_KEY]?.trim();
  if (fromFile) return assertSecretStrength(fromFile);

  const generated = randomBytes(32).toString('base64url');
  writeSecretToEnvFile(path, generated);
  console.warn(`${SECRET_KEY} absent : une clé aléatoire a été générée et enregistrée dans ${path}.`);
  return generated;
}

function writeSecretToEnvFile(path: string, secret: string): void {
  const line = `${SECRET_KEY}=${secret}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    return;
  }
  // Remplace une ligne vide existante plutôt que d'en ajouter une seconde.
  const content = readFileSync(path, 'utf8');
  const keyLine = /^[ \t]*(?:export[ \t]+)?LASTADDON_SECRET[ \t]*=.*$/m;
  if (keyLine.test(content)) {
    writeFileSync(path, content.replace(keyLine, line), 'utf8');
    return;
  }
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${line}\n`, 'utf8');
}
