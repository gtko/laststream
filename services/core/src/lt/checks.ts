import type { Config } from '../config/schema.js';
import { getJson, type LtContext } from './context.js';
import { mdblistRatings, tvdbApiVersion } from './providers.js';

/** Clé de service testable, telle qu'elle apparaît dans la configuration. */
export type ServiceField = 'tmdbToken' | 'tmdbApiKey' | 'mdblistApiKey' | 'tvdbApiKey' | 'openrouterApiKey' | 'fanartApiKey';

/**
 * Sonde d'un service configuré : `probe` lève en cas d'échec (message sans clé ni URL). Elle renvoie une note
 * non sensible (ex. version d'API TheTVDB) ou undefined.
 */
export interface ServiceProbe {
  name: string;
  type: ServiceField;
  probe: () => Promise<string | undefined>;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
/** Note de la sonde TheTVDB quand la clé est une clé legacy acceptée par l'API v3. */
const TVDB_LEGACY_NOTE = 'clé legacy (API v3)';

/** Sondes des clés configurées uniquement. Chaque sonde appelle un point léger de chaque service. */
export function serviceProbes(ctx: LtContext, config: Config): ServiceProbe[] {
  const { services } = config;
  const probes: ServiceProbe[] = [];
  const add = (name: string, type: ServiceField, probe: () => Promise<string | undefined>): void => {
    probes.push({ name, type, probe });
  };

  if (services.tmdbToken !== undefined) {
    const token = services.tmdbToken;
    add('TMDB (jeton v4)', 'tmdbToken', () =>
      getJson(ctx, `${TMDB_BASE}/configuration`, { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' } }).then(
        () => undefined,
      ),
    );
  }
  if (services.tmdbApiKey !== undefined) {
    const key = services.tmdbApiKey;
    add('TMDB (clé API v3)', 'tmdbApiKey', () =>
      getJson(ctx, `${TMDB_BASE}/configuration?api_key=${encodeURIComponent(key)}`).then(() => undefined),
    );
  }
  if (services.mdblistApiKey !== undefined) {
    const key = services.mdblistApiKey;
    add('MDBList', 'mdblistApiKey', () => mdblistRatings(ctx, key, 'movie', 'tt0133093').then(() => undefined));
  }
  if (services.tvdbApiKey !== undefined) {
    const key = services.tvdbApiKey;
    const pin = services.tvdbPin;
    add('TheTVDB', 'tvdbApiKey', async () => {
      // Même repli que les routes lt : v4 d'abord, v3 pour une clé legacy.
      const version = await tvdbApiVersion(ctx, key, pin);
      return version === 'v3' ? TVDB_LEGACY_NOTE : undefined;
    });
  }
  if (services.openrouterApiKey !== undefined) {
    const key = services.openrouterApiKey;
    add('OpenRouter', 'openrouterApiKey', () =>
      getJson(ctx, 'https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + key } }).then(() => undefined),
    );
  }
  if (services.fanartApiKey !== undefined) {
    const key = services.fanartApiKey;
    add('Fanart.tv', 'fanartApiKey', () =>
      getJson(ctx, `https://webservice.fanart.tv/v3/movies/603?api_key=${encodeURIComponent(key)}`).then(() => undefined),
    );
  }
  return probes;
}
