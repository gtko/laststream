import type { Config } from '../config/schema.js';
import { getJson, LtError, type LtContext } from './context.js';
import { mdblistRatings } from './providers.js';

/** Clé de service testable, telle qu'elle apparaît dans la configuration. */
export type ServiceField = 'tmdbToken' | 'tmdbApiKey' | 'mdblistApiKey' | 'tvdbApiKey' | 'openrouterApiKey' | 'fanartApiKey';

/** Sonde d'un service configuré : `probe` lève en cas d'échec (message sans clé ni URL). */
export interface ServiceProbe {
  name: string;
  type: ServiceField;
  probe: () => Promise<void>;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TVDB_LOGIN = 'https://api4.thetvdb.com/v4/login';

/** Sondes des clés configurées uniquement. Chaque sonde appelle un point léger de chaque service. */
export function serviceProbes(ctx: LtContext, config: Config): ServiceProbe[] {
  const { services } = config;
  const probes: ServiceProbe[] = [];
  const add = (name: string, type: ServiceField, probe: () => Promise<void>): void => {
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
    add('TheTVDB', 'tvdbApiKey', async () => {
      const json = await getJson(ctx, TVDB_LOGIN, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ apikey: key }),
      });
      const data = json !== null && typeof json === 'object' ? (json as { data?: { token?: unknown } }).data : undefined;
      if (typeof data?.token !== 'string') throw new LtError(502, 'tvdb_login_failed');
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
