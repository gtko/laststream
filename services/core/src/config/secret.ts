import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_KEY = 'LASTADDON_SECRET';
const ALLOW_PLAIN_KEY = 'LASTADDON_ALLOW_PLAIN';

/** Longueur minimale de LASTADDON_SECRET (caractères, après trim). */
export const MIN_SECRET_LENGTH = 32;

/** Chemin du fichier .env à la racine du projet (relatif à ce module, pas au répertoire courant). */
export function envFilePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..', '..', '.env');
}

/** Parse le contenu d'un fichier .env (KEY=VALUE, commentaires #, guillemets simples ou doubles). */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    values[key] = value;
  }
  return values;
}

/** Charge le .env dans process.env sans écraser les variables déjà définies. */
export function loadEnvFile(): void {
  const path = envFilePath();
  if (!existsSync(path)) return;
  const values = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Vérifie la longueur minimale. Le message ne contient jamais la valeur. */
export function assertSecretStrength(secret: string): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${SECRET_KEY} trop court : ${MIN_SECRET_LENGTH} caractères minimum (longueur actuelle : ${secret.length}). ` +
        'Supprimez la variable pour générer une clé aléatoire, ou utilisez 32 octets aléatoires en base64url.',
    );
  }
  return secret;
}

/**
 * Renvoie la clé de chiffrement des configurations (au moins MIN_SECRET_LENGTH caractères, sinon erreur).
 * Ordre : variable LASTADDON_SECRET, puis .env du projet, sinon génération aléatoire (32 octets, base64url)
 * enregistrée dans .env. La valeur n'est jamais écrite sur la sortie standard.
 */
export function getSecret(path: string = envFilePath()): string {
  const fromEnv = process.env[SECRET_KEY]?.trim();
  if (fromEnv) return assertSecretStrength(fromEnv);

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

/** true si LASTADDON_ALLOW_PLAIN=1 : accepte les configurations en JSON brut (non chiffré). */
export function isPlainAllowed(): boolean {
  return process.env[ALLOW_PLAIN_KEY] === '1';
}
