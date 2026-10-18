import { runtimeEnv } from '../platform/index.js';
import type { Config } from './schema.js';

/**
 * Clés de services au niveau du serveur, partagées par tous les comptes : variables d'environnement (Node) ou secrets
 * Worker. La configuration de l'utilisateur prime ; une clé absente se replie sur celle du serveur. Ces valeurs ne
 * sont jamais renvoyées au client ni journalisées : cette fonction n'est appelée que sur le chemin d'exécution des
 * routes (jamais pour l'affichage ou l'édition d'une configuration).
 */
const SERVER_SERVICE_ENV = {
  tmdbToken: 'TMDB_TOKEN',
  tmdbApiKey: 'TMDB_API_KEY',
  mdblistApiKey: 'MDBLIST_API_KEY',
  tvdbApiKey: 'TVDB_API_KEY',
  tvdbPin: 'TVDB_PIN',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  fanartApiKey: 'FANART_API_KEY',
  introdbApiKey: 'INTRODB_API_KEY',
  skipdbApiKey: 'SKIPDB_API_KEY',
  animeskipClientId: 'ANIMESKIP_CLIENT_ID',
} as const satisfies Partial<Record<keyof Config['services'], string>>;

/** Configuration dont les clés de services manquantes sont complétées par celles du serveur. */
export function withServerServices(config: Config): Config {
  const env = runtimeEnv();
  let services: Config['services'] | undefined;
  for (const [field, name] of Object.entries(SERVER_SERVICE_ENV)) {
    const key = field as keyof typeof SERVER_SERVICE_ENV;
    if (config.services[key] !== undefined) continue;
    const value = env.get(name)?.trim();
    if (!value) continue;
    services ??= { ...config.services };
    services[key] = value;
  }
  return services === undefined ? config : { ...config, services };
}

/** Services disponibles côté serveur (booléens uniquement). */
export function serverServicesConfigured(): Record<string, boolean> {
  const env = runtimeEnv();
  const has = (name: string): boolean => Boolean(env.get(name)?.trim());
  return {
    tmdb: has('TMDB_TOKEN'),
    mdblist: has('MDBLIST_API_KEY'),
    tvdb: has('TVDB_API_KEY'),
    openrouter: has('OPENROUTER_API_KEY'),
    fanart: has('FANART_API_KEY'),
  };
}
