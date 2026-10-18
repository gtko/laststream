import { runtimeEnv } from '../platform/index.js';

export const SECRET_KEY = 'LASTADDON_SECRET';
const ALLOW_PLAIN_KEY = 'LASTADDON_ALLOW_PLAIN';

/** Longueur minimale de LASTADDON_SECRET (caractères, après trim). */
export const MIN_SECRET_LENGTH = 32;

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
 * Clé de chiffrement lue dans les variables d'exécution (LASTADDON_SECRET), vérifiée (longueur minimale), ou undefined
 * si elle est absente. Sous Node, getSecret (platform/node/secret-file.ts) complète par le .env puis génère une clé.
 */
export function secretFromEnv(): string | undefined {
  const fromEnv = runtimeEnv().get(SECRET_KEY)?.trim();
  return fromEnv ? assertSecretStrength(fromEnv) : undefined;
}

/** true si LASTADDON_ALLOW_PLAIN=1 : accepte les configurations en JSON brut (non chiffré). */
export function isPlainAllowed(): boolean {
  return runtimeEnv().get(ALLOW_PLAIN_KEY) === '1';
}
