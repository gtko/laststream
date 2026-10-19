import { createHash } from 'node:crypto';
import type { App, Ctx } from '../http/app-env.js';
import { sendJson, queryParams } from '../http/respond.js';
import { ConfigDecodeError, decodeConfig } from '../config/codec.js';
import { withServerServices } from '../config/server-services.js';
import { type Config, ConfigValidationError } from '../config/schema.js';
import type { AppDeps, DebridClient } from '../deps.js';
import { isEdgeRequest } from '../config/edge.js';
import { platform, sharedKvCache } from '../platform/index.js';
import { configuredPublicUrl, isPublicMode, isTrustProxy } from '../config/runtime-env.js';
import { getStreams, getStreamsStatus, type PipelineContext } from '../pipeline.js';
import { AllDebridClient, serverSideDebridBlocked } from '../sources/alldebrid.js';
import { HosterClient } from '../sources/hosters.js';
import type { DeviceFetchEntry } from '../sources/device-fetch.js';
import { warmUpstreamManifest } from '../sources/upstream.js';
import { issuedUrls } from '../play/issued.js';
import { defaultPlayState } from '../play/state.js';
import type { ContentRef } from '../types.js';

const MOVIE_ID = /^tt\d{1,12}$/;
const SERIES_ID = /^(tt\d{1,12}):(\d{1,4}):(\d{1,4})$/;
const CACHE_CONTROL = 'max-age=60';
/** Résultat partiel (indexeurs lents en cours) : jamais mis en cache par le client, il doit être rechargé. */
const PARTIAL_CACHE_CONTROL = 'no-store';
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

/** Ce que publicBaseUrl lit d'une requête : son URL et ses en-têtes (HonoRequest, ou une requête simulée). */
export interface RequestLike {
  url: string;
  header(name: string): string | undefined;
}

function firstToken(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Base publique des liens de lecture.
 * - LASTADDON_PUBLIC_URL, si défini (validé au démarrage), prime toujours.
 * - Sinon, en mode public (LASTADDON_PUBLIC=1) : erreur, la base doit être configurée (voir assertStartupEnv).
 * - Sinon : protocole et hôte de la requête. X-Forwarded-Proto / X-Forwarded-Host ne sont lus que si
 *   LASTADDON_TRUST_PROXY=1 ou si la requête vient du relais authentifié (LASTADDON_EDGE_SECRET) ; valeurs validées (protocole http(s), hôte au format nom ou IP avec port).
 */
export function publicBaseUrl(req: RequestLike, edge = false): string {
  const configured = configuredPublicUrl();
  if (configured !== undefined) return configured;
  if (isPublicMode()) {
    throw new Error('LASTADDON_PUBLIC=1 exige LASTADDON_PUBLIC_URL');
  }

  const trustProxy = isTrustProxy() || edge;
  const forwardedProto = trustProxy ? firstToken(req.header('x-forwarded-proto'))?.toLowerCase() : undefined;
  const scheme = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : new URL(req.url).protocol.slice(0, -1);
  const hostCandidates = [trustProxy ? firstToken(req.header('x-forwarded-host')) : undefined, req.header('host')];
  const host = hostCandidates.find(
    (candidate): candidate is string => candidate !== undefined && HOST_PATTERN.test(candidate),
  );
  return `${scheme}://${host ?? 'localhost'}`;
}

/**
 * Mode « client » : le serveur n'appelle jamais AllDebrid (compte sanctionné pour des appels depuis des IP de serveurs).
 * Les torrents sont livrés sans lien ; l'appareil vérifie le cache et débride avec sa propre clé, depuis son IP.
 */
const clientMode = (): boolean => serverSideDebridBlocked();

const noticeOf = (config: Config): { notice?: string; debrid?: 'client'; onlyCached?: boolean } =>
  clientMode()
    ? { debrid: 'client', onlyCached: config.onlyCached }
    : {};

/** Addons bloqués pour le serveur : l'appareil les interroge lui-même (champ absent quand il n'y en a pas). */
const deviceOf = (c: Ctx, result: { deviceFetch?: DeviceFetchEntry[] }): { deviceFetch?: DeviceFetchEntry[] } => {
  if (result.deviceFetch === undefined || result.deviceFetch.length === 0) return {};
  // Les URL peuvent porter la clé de débrideur de l'utilisateur : jamais mises en cache.
  c.header('Cache-Control', PARTIAL_CACHE_CONTROL);
  return { deviceFetch: result.deviceFetch };
};

/** Film pas encore disponible en numérique : `notYetDigital` (et la date de sortie numérique annoncée, si connue). */
const notYetDigitalOf = (result: { notYetDigital?: boolean; digitalDate?: string }): { notYetDigital?: true; digitalDate?: string } => {
  if (result.notYetDigital !== true) return {};
  return result.digitalDate === undefined ? { notYetDigital: true } : { notYetDigital: true, digitalDate: result.digitalDate };
};

/**
 * Route Stremio : GET /:config/stream/:type/:id.json.
 * Configuration invalide : 400 sans détail. Type ou identifiant hors format : liste vide.
 */
export function registerStreamRoutes(app: App, deps: AppDeps): void {
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
        : new AllDebridClient(apiKey, { fetch: deps.fetch, kv: sharedKvCache('alldebrid') });
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

  /** Configuration de l'URL, ou la réponse 400 à renvoyer. */
  const configOf = (c: Ctx): Config | Response => {
    try {
      return withServerServices(decodeConfig(c.req.param('config') as string, deps.secret, { allowPlain: deps.allowPlain }));
    } catch (err) {
      if (err instanceof ConfigDecodeError || err instanceof ConfigValidationError) {
        return sendJson(c, { error: 'invalid_config' }, 400);
      }
      throw err;
    }
  };

  // État partagé de lecture (packs, hébergeurs en panne, torrents) : créé ici, la plateforme étant installée.
  const playState = defaultPlayState();

  const contextOf = (c: Ctx, config: Config, wait: PipelineContext['wait']): PipelineContext => {
    const client = clientMode();
    // Mode client : ni client AllDebrid ni hébergeurs (le catalogue d'hébergeurs est aussi un appel AllDebrid).
    const apiKey = client ? undefined : config.debrid?.apiKey;
    return {
      debridMode: client ? 'client' : 'server',
      deliverTorrents: queryParams(c).torrents === '1',
      playBaseUrl: publicBaseUrl(c.req, isEdgeRequest(c)),
      configToken: c.req.param('config') as string,
      secret: deps.secret,
      fetch: deps.fetch,
      debrid: apiKey === undefined ? undefined : debridFor(apiKey),
      hosters: apiKey === undefined ? undefined : hostersFor(apiKey),
      hostHealth: playState.hostHealth,
      torrentCache: playState.torrentCache,
      packStore: playState.packStore,
      localProwlarr: deps.localProwlarr,
      wait,
    };
  };

  /**
   * GET /:config/stream/:type/:id.json. Les indexeurs lents ne retardent pas la réponse : passé l'échéance douce, les
   * flux arrivés sont rendus avec `pending` (noms des indexeurs en cours) et `laststream.partial`. `?wait=full` attend
   * tous les indexeurs (dans le budget dur).
   */
  app.get('/:config/stream/:type/:idjson{[^/]+\\.json}', async (c) => {
    const config = configOf(c);
    if (config instanceof Response) return config;

    c.header('Cache-Control', CACHE_CONTROL);
    const ref = parseContentRef(c.req.param('type'), c.req.param('idjson').replace(/\.json$/, ''));
    if (ref === undefined) return sendJson(c, { streams: [] });

    // Addons amont : manifest (nom, logo) chargé en arrière-plan, pour les provenances affichées aux requêtes suivantes.
    if (deps.fetch === undefined) {
      for (const source of config.sources) if (source.type === 'upstream' && source.enabled !== false) warmUpstreamManifest(source);
    }
    const result = await getStreams(config, ref, contextOf(c, config, queryParams(c).wait === 'full' ? 'full' : 'soft'));
    // Registre des URL émises (miniatures) : écrit après la réponse, sans la retarder.
    platform().scheduler.background(issuedUrls().noteStreams(result.streams));
    if (result.partial === true) {
      c.header('Cache-Control', PARTIAL_CACHE_CONTROL);
      return sendJson(c, { streams: result.streams, partial: true, pending: result.pending ?? [], ...deviceOf(c, result), ...notYetDigitalOf(result), ...noticeOf(config) });
    }
    return sendJson(c, { streams: result.streams, ...deviceOf(c, result), ...notYetDigitalOf(result), ...noticeOf(config) });
  });

  /** GET /:config/lt/streams/status/:type/:id : `{ pending, count }`, sans lancer de recherche. */
  app.get('/:config/lt/streams/status/:type/:id', async (c) => {
    const config = configOf(c);
    if (config instanceof Response) return config;
    c.header('Cache-Control', PARTIAL_CACHE_CONTROL);
    const ref = parseContentRef(c.req.param('type'), c.req.param('id').replace(/\.json$/, ''));
    if (ref === undefined) return sendJson(c, { pending: [], count: 0 });
    return sendJson(c, await getStreamsStatus(config, ref, contextOf(c, config, 'soft')));
  });
}
