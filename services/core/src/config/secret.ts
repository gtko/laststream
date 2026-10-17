import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SECRET_KEY = 'LASTADDON_SECRET';
const ALLOW_PLAIN_KEY = 'LASTADDON_ALLOW_PLAIN';

/** Chemin du fichier .env local (racine du répertoire courant). */
export function envFilePath(): string {
  return resolve(process.cwd(), '.env');
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

/**
 * Renvoie la clé de chiffrement des configurations.
 * Ordre : variable LASTADDON_SECRET, puis .env local, sinon génération aléatoire enregistrée dans .env.
 * La valeur n'est jamais écrite sur la sortie standard.
 */
export function getSecret(): string {
  const fromEnv = process.env[SECRET_KEY]?.trim();
  if (fromEnv) return fromEnv;

  const path = envFilePath();
  const fileValues = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  const fromFile = fileValues[SECRET_KEY]?.trim();
  if (fromFile) return fromFile;

  const generated = randomBytes(32).toString('hex');
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
