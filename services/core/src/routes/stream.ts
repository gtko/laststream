import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps } from '../deps.js';
import { getStreams } from '../pipeline.js';
import { AllDebridClient } from '../sources/alldebrid.js';
import type { ContentRef } from '../types.js';

const MOVIE_ID = /^tt\d{1,12}$/;
const SERIES_ID = /^(tt\d{1,12}):(\d{1,4}):(\d{1,4})$/;
const CACHE_CONTROL = 'max-age=60';
const HOST_PATTERN = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

type DebridClient = Pick<AllDebridClient, 'resolve' | 'checkCached' | 'checkApiKey'>;

/**
 * Identifiant Stremio → ContentRef. Film : `tt1234567`. Épisode : `tt1234567:S:E`.
 * Renvoie undefined si le type n'est pas movie/series ou si l'identifiant ne correspond pas au type.
 */
export function parseContentRef(type: string, id: string): ContentRef | undefined {
  if (type === 'movie') {
    return MOVIE_ID.test(id) ? { type: 'movie', id, imdbId: id } : undefined;
  }
  if (type === 'series') {
    const match = SERIES_ID.exec(id);
    if (!match) return undefined;
    const [, imdbId = '', season = '', episode = ''] = match;
    return { type: 'series', id, imdbId, season: Number(season), episode: Number(episode) };
  }
  return undefined;
}

function firstToken(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Base publique des liens de lecture. LASTADDON_PUBLIC_URL, si défini, prime toujours.
 * Sinon : protocole et hôte de la requête, en tenant compte de X-Forwarded-Proto / X-Forwarded-Host
 * (valeurs validées : protocole http(s), hôte au format nom ou IP avec port optionnel).
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.LASTADDON_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const forwardedProto = firstToken(req.get('x-forwarded-proto'))?.toLowerCase();
  const scheme = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : req.protocol;
  const host = [firstToken(req.get('x-forwarded-host')), req.get('host')].find(
    (candidate): candidate is string => candidate !== undefined && HOST_PATTERN.test(candidate),
  );
  return `${scheme}://${host ?? 'localhost'}`;
}

/**
 * Route Stremio : GET /:config/stream/:type/:id.json.
 * Configuration invalide : 400 sans détail. Type ou identifiant hors format : liste vide.
 */
export function registerStreamRoutes(app: Express, deps: AppDeps): void {
  // Clients debrid mis en cache par empreinte de clé : le cache de disponibilité survit entre requêtes.
  const clients = new Map<string, DebridClient>();

  const debridFor = (apiKey: string): DebridClient => {
    const cacheKey = createHash('sha256').update(apiKey, 'utf8').digest('hex');
    let client = clients.get(cacheKey);
    if (client === undefined) {
      client = deps.alldebridFactory
        ? deps.alldebridFactory(apiKey)
        : new AllDebridClient(apiKey, { fetch: deps.fetch });
      clients.set(cacheKey, client);
    }
    return client;
  };

  app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const encoded: string = req.params.config;
    let config: Config;
    try {
      config = decodeConfig(encoded, deps.secret, { allowPlain: deps.allowPlain });
    } catch (err) {
      if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) {
        res.status(400).json({ error: 'invalid_config' });
        return;
      }
      throw err;
    }

    res.setHeader('Cache-Control', CACHE_CONTROL);
    const ref = parseContentRef(req.params.type, req.params.id);
    if (ref === undefined) {
      res.json({ streams: [] });
      return;
    }

    const result = await getStreams(config, ref, {
      playBaseUrl: publicBaseUrl(req),
      configToken: encoded,
      fetch: deps.fetch,
      debrid: config.debrid === undefined ? undefined : debridFor(config.debrid.apiKey),
    });
    res.json({ streams: result.streams });
  });
}
