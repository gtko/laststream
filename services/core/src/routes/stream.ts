import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps, DebridClient } from '../deps.js';
import { configuredPublicUrl, isPublicMode, isTrustProxy } from '../config/runtime-env.js';
import { getStreams } from '../pipeline.js';
import { AllDebridClient } from '../sources/alldebrid.js';
import { HosterClient } from '../sources/hosters.js';
import { defaultPlayState } from '../play/state.js';
import type { ContentRef } from '../types.js';

const MOVIE_ID = /^tt\d{1,12}$/;
const SERIES_ID = /^(tt\d{1,12}):(\d{1,4}):(\d{1,4})$/;
const CACHE_CONTROL = 'max-age=60';
const HOST_PATTERN = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

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
 * Base publique des liens de lecture.
 * - LASTADDON_PUBLIC_URL, si défini (validé au démarrage), prime toujours.
 * - Sinon, en mode public (LASTADDON_PUBLIC=1) : erreur, la base doit être configurée (voir assertStartupEnv).
 * - Sinon : protocole et hôte de la requête. X-Forwarded-Proto / X-Forwarded-Host ne sont lus que si
 *   LASTADDON_TRUST_PROXY=1 ; valeurs validées (protocole http(s), hôte au format nom ou IP avec port).
 */
export function publicBaseUrl(req: Request): string {
  const configured = configuredPublicUrl();
  if (configured !== undefined) return configured;
  if (isPublicMode()) {
    throw new Error('LASTADDON_PUBLIC=1 exige LASTADDON_PUBLIC_URL');
  }

  const trustProxy = isTrustProxy();
  const forwardedProto = trustProxy ? firstToken(req.get('x-forwarded-proto'))?.toLowerCase() : undefined;
  const scheme = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : req.protocol;
  const hostCandidates = [trustProxy ? firstToken(req.get('x-forwarded-host')) : undefined, req.get('host')];
  const host = hostCandidates.find(
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
  // Clients des hébergeurs (liens AllDebrid) : un par clé, construit sur le client debrid de cette clé.
  const hosterClients = new Map<string, HosterClient>();

  const keyOf = (apiKey: string): string => createHash('sha256').update(apiKey, 'utf8').digest('hex');

  const debridFor = (apiKey: string): DebridClient => {
    const cacheKey = keyOf(apiKey);
    let client = clients.get(cacheKey);
    if (client === undefined) {
      client = deps.alldebridFactory
        ? deps.alldebridFactory(apiKey)
        : new AllDebridClient(apiKey, { fetch: deps.fetch });
      clients.set(cacheKey, client);
    }
    return client;
  };

  const hostersFor = (apiKey: string): HosterClient => {
    const cacheKey = keyOf(apiKey);
    let hosters = hosterClients.get(cacheKey);
    if (hosters === undefined) {
      hosters = new HosterClient(debridFor(apiKey));
      hosterClients.set(cacheKey, hosters);
    }
    return hosters;
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

    const apiKey = config.debrid?.apiKey;
    const result = await getStreams(config, ref, {
      playBaseUrl: publicBaseUrl(req),
      configToken: encoded,
      secret: deps.secret,
      fetch: deps.fetch,
      debrid: apiKey === undefined ? undefined : debridFor(apiKey),
      hosters: apiKey === undefined ? undefined : hostersFor(apiKey),
      hostHealth: defaultPlayState.hostHealth,
      torrentCache: defaultPlayState.torrentCache,
      packStore: defaultPlayState.packStore,
      localProwlarr: deps.localProwlarr,
    });
    res.json({ streams: result.streams });
  });
}
