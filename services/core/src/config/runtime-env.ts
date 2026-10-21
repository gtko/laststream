/**
 * Variables d'environnement d'exécution. Lues à la demande (pas au chargement du module) pour rester
 * testables avec vi.stubEnv.
 */
import { resolve } from 'node:path';
import { runtimeEnv } from '../platform/index.js';

/** LASTADDON_UI_DIR : dossier de l'interface web servie à la racine (chemin absolu), ou undefined si absent ou vide. */
export function configuredUiDir(): string | undefined {
  const raw = runtimeEnv().get('LASTADDON_UI_DIR')?.trim();
  return raw ? resolve(raw) : undefined;
}

/** Serveur de streaming Stremio par défaut, relayé sous /_ss quand l'interface est servie. */
export const DEFAULT_STREAMING_SERVER = 'http://127.0.0.1:11470';
const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Valide une origine de serveur de streaming : http ou https, sans chemin, identifiants ni requête, sur un hôte local
 * uniquement (localhost, 127.0.0.1, [::1]). Renvoie l'origine. Le message ne contient jamais la valeur saisie.
 */
export function parseStreamingServer(raw: string): string {
  const message = 'LASTADDON_STREAMING_SERVER invalide : origine http(s) locale attendue (localhost, 127.0.0.1 ou [::1]), sans chemin';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(message);
  }
  const plainOrigin =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOCAL_HOSTNAMES.includes(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '';
  if (!plainOrigin) throw new Error(message);
  return url.origin;
}

/** LASTADDON_STREAMING_SERVER validée, ou l'origine par défaut. Lève si la valeur est invalide. */
export function configuredStreamingServer(): string {
  const raw = runtimeEnv().get('LASTADDON_STREAMING_SERVER')?.trim();
  return parseStreamingServer(raw ? raw : DEFAULT_STREAMING_SERVER);
}

/** LASTADDON_ALLOW_SIGNUP=1 : inscription ouverte (sinon seul le premier compte peut être créé sur /user/register). */
export function isSignupAllowed(): boolean {
  return runtimeEnv().get('LASTADDON_ALLOW_SIGNUP') === '1';
}

/** LASTADDON_BOOTSTRAP_TOKEN : exigé (en-tête X-Bootstrap-Token) pour créer le premier compte. Absent ou vide : non exigé. */
export function bootstrapToken(): string | undefined {
  const raw = runtimeEnv().get('LASTADDON_BOOTSTRAP_TOKEN')?.trim();
  return raw ? raw : undefined;
}

/** Origines CORS autorisées sur /config/* quand LASTADDON_ALLOWED_ORIGINS est absent ou vide. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:8089', 'http://localhost:8080'];

/** LASTADDON_PUBLIC=1 : mode public (SSRF : adresses privées refusées pour les URL saisies). */
export function isPublicMode(): boolean {
  return runtimeEnv().get('LASTADDON_PUBLIC') === '1';
}

/** LASTADDON_TRUST_PROXY=1 : X-Forwarded-Proto et X-Forwarded-Host sont utilisés pour les liens de lecture. */
export function isTrustProxy(): boolean {
  return runtimeEnv().get('LASTADDON_TRUST_PROXY') === '1';
}

/**
 * LASTADDON_MOLOTOV_RELAY=0 : relais serveur Molotov désactivé (mode « appel direct depuis l'appareil » seul).
 * Actif par défaut ; toute autre valeur laisse le relais actif.
 */
export function isMolotovRelayEnabled(): boolean {
  return runtimeEnv().get('LASTADDON_MOLOTOV_RELAY') !== '0';
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
  const raw = runtimeEnv().get('LASTADDON_PUBLIC_URL')?.trim();
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
  const raw = runtimeEnv().get('LASTADDON_ALLOWED_ORIGINS')?.trim();
  if (!raw) return [...DEFAULT_ALLOWED_ORIGINS];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}
