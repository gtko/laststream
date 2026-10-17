/**
 * Variables d'environnement d'exécution. Lues à la demande (pas au chargement du module) pour rester
 * testables avec vi.stubEnv.
 */

/** LASTADDON_ALLOW_SIGNUP=1 : inscription ouverte (sinon seul le premier compte peut être créé sur /user/register). */
export function isSignupAllowed(): boolean {
  return process.env.LASTADDON_ALLOW_SIGNUP === '1';
}

/** Origines CORS autorisées sur /config/* quand LASTADDON_ALLOWED_ORIGINS est absent ou vide. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:8089', 'http://localhost:8080'];

/** LASTADDON_PUBLIC=1 : mode public (SSRF : adresses privées refusées pour les URL saisies). */
export function isPublicMode(): boolean {
  return process.env.LASTADDON_PUBLIC === '1';
}

/** LASTADDON_TRUST_PROXY=1 : X-Forwarded-Proto et X-Forwarded-Host sont utilisés pour les liens de lecture. */
export function isTrustProxy(): boolean {
  return process.env.LASTADDON_TRUST_PROXY === '1';
}

/**
 * Valide une base publique (URL absolue, http ou https uniquement) et la renvoie sans slash final.
 * Le message d'erreur ne contient jamais la valeur saisie.
 */
export function parsePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LASTADDON_PUBLIC_URL invalide : URL absolue attendue (ex. https://addon.example.com)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('LASTADDON_PUBLIC_URL invalide : seuls les schémas http et https sont acceptés');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** LASTADDON_PUBLIC_URL validée, ou undefined si absente ou vide. Lève si la valeur est invalide. */
export function configuredPublicUrl(): string | undefined {
  const raw = process.env.LASTADDON_PUBLIC_URL?.trim();
  return raw ? parsePublicUrl(raw) : undefined;
}

/**
 * Contrôles au démarrage (fail fast) : LASTADDON_PUBLIC_URL valide si définie, et obligatoire en mode public.
 */
export function assertStartupEnv(): void {
  const publicUrl = configuredPublicUrl();
  if (isPublicMode() && publicUrl === undefined) {
    throw new Error('LASTADDON_PUBLIC=1 exige LASTADDON_PUBLIC_URL (base publique du serveur, ex. https://addon.example.com)');
  }
}

/** Origines autorisées pour CORS sur /config/* : liste séparée par des virgules, ou valeurs par défaut. */
export function allowedOrigins(): string[] {
  const raw = process.env.LASTADDON_ALLOWED_ORIGINS?.trim();
  if (!raw) return [...DEFAULT_ALLOWED_ORIGINS];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}
