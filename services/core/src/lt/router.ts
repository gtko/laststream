import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../deps.js';
import { catalogMetas, findCatalog, parseSkip } from './catalog.js';
import { personWhy, recommend, why } from './ai.js';
import { bodyOf, createLtContext, decodeFor, LtError, type LtContext, queryOf, serviceKey } from './context.js';
import { mdblistRatings, tmdbGet, tmdbPublicParams, tvdbSeries } from './providers.js';
import { parseSkipTarget, skipSegments } from './skip.js';
import { signTvUrl, tvChannels, tvEpg, tvHls, tvImport, tvStats, type TvChannel } from './tv.js';

/** Réponses d'erreur et POST : jamais en cache. */
const NO_STORE = 'no-store';
/** Réponses GET réussies : cache privé (propre à l'utilisateur), 5 minutes. */
const PRIVATE_CACHE = 'private, max-age=300';

/** Erreurs des routes lt : `{ error: code }` (+ `service` si une clé manque). Aucun détail amont. */
export function ltErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  res.setHeader('Cache-Control', NO_STORE);
  if (err instanceof LtError) {
    res.status(err.status).json(err.service === undefined ? { error: err.code } : { error: err.code, service: err.service });
    return;
  }
  console.error('[lt] erreur interne', err instanceof Error ? err.name : 'inconnue');
  res.status(500).json({ error: 'internal' });
}

/** Marque une réponse GET réussie comme cacheable. À appeler après l'obtention du corps, jamais avant. */
function cacheable(res: Response): void {
  res.setHeader('Cache-Control', PRIVATE_CACHE);
}

/** Chaînes annotées de leur signature pour la configuration `scope` (le proxy HLS la vérifie). */
function signedChannels(ctx: LtContext, scope: string, channels: TvChannel[]): (TvChannel & { sig: string | null })[] {
  return channels.map((channel) => ({ ...channel, sig: signTvUrl(ctx, scope, channel.url) }));
}

/**
 * Routes publiques par configuration, montées sous `/:config/lt/*` (mêmes chemins que le prototype sans `/api`)
 * et catalogues Stremio sous `/:config/catalog/*`.
 */
export function registerLtRoutes(app: Express, deps: AppDeps): void {
  const ctx: LtContext = createLtContext(deps);
  // Segment de configuration de l'URL (jeton base64url), présent sur toutes les routes lt et catalogue.
  const tokenOf = (req: Request): string => String((req.params as Record<string, unknown>).config);
  const configOf = (req: Request) => decodeFor(deps, tokenOf(req));

  const lt = express.Router({ mergeParams: true });
  lt.use((_req, res, next) => {
    res.setHeader('Cache-Control', NO_STORE);
    next();
  });

  lt.get('/health', (req, res) => {
    const { services } = configOf(req);
    cacheable(res);
    res.json({
      ok: true,
      configured: {
        tmdb: services.tmdbToken !== undefined,
        mdblist: services.mdblistApiKey !== undefined,
        tvdb: services.tvdbApiKey !== undefined,
        openrouter: services.openrouterApiKey !== undefined,
        fanart: services.fanartApiKey !== undefined,
      },
    });
  });

  // TMDB : chemin en liste blanche (validé dans tmdbGet), paramètres en liste blanche (tmdbPublicParams).
  lt.get(/^\/tmdb\/(.+)$/, async (req, res) => {
    const token = serviceKey(configOf(req), 'tmdb');
    const body = await tmdbGet(ctx, token, String(req.params[0] ?? ''), tmdbPublicParams(queryOf(req)));
    cacheable(res);
    res.json(body);
  });

  lt.get('/mdblist/:type/:id', async (req, res) => {
    const apiKey = serviceKey(configOf(req), 'mdblist');
    const body = await mdblistRatings(ctx, apiKey, req.params.type, req.params.id);
    cacheable(res);
    res.json(body);
  });

  lt.get('/tvdb/series/:id', async (req, res) => {
    const config = configOf(req);
    const apiKey = serviceKey(config, 'tvdb');
    const body = await tvdbSeries(ctx, apiKey, req.params.id, config.services.tvdbPin).catch((err: unknown): never => {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][tvdb] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'tvdb_unavailable');
    });
    cacheable(res);
    res.json(body);
  });

  // Segments de saut (intro, reprise, générique). Cible validée ; clés IntroDB et Anime Skip facultatives.
  lt.get('/skip/:type/:imdbId/:season/:episode', async (req, res) => {
    const config = configOf(req);
    const target = parseSkipTarget(req.params.type, req.params.imdbId, req.params.season, req.params.episode);
    const body = await skipSegments(ctx, config.services, target).catch((err: unknown): never => {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][skip] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'skip_unavailable');
    });
    cacheable(res);
    res.json(body);
  });

  lt.post('/recommend', async (req, res) => {
    res.json(await recommend(ctx, configOf(req), bodyOf(req)));
  });

  lt.post('/why', async (req, res) => {
    res.json(await why(ctx, configOf(req), bodyOf(req)));
  });

  lt.post('/person-why', async (req, res) => {
    res.json(await personWhy(ctx, configOf(req), bodyOf(req)));
  });

  // TV : valide la configuration de l'URL ; aucune clé de service requise.
  lt.get('/tv/channels', async (req, res) => {
    configOf(req);
    const body = signedChannels(ctx, tokenOf(req), await tvChannels(ctx));
    cacheable(res);
    res.json(body);
  });

  lt.get('/tv/epg', async (req, res) => {
    configOf(req);
    const body = await tvEpg(ctx, queryOf(req));
    cacheable(res);
    res.json(body);
  });

  lt.get('/tv/hls', async (req, res) => {
    configOf(req);
    const query = queryOf(req);
    const text = await tvHls(ctx, tokenOf(req), query.u ?? null, query.s ?? null);
    cacheable(res);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(text);
  });

  lt.get('/tv/stats', async (req, res) => {
    configOf(req);
    const body = await tvStats(ctx);
    cacheable(res);
    res.json(body);
  });

  lt.post('/tv/import', async (req, res) => {
    configOf(req);
    const imported = await tvImport(ctx, bodyOf(req));
    res.json({ count: imported.count, channels: signedChannels(ctx, tokenOf(req), imported.channels) });
  });

  lt.use((_req, _res, next) => next(new LtError(404, 'not_found')));
  lt.use(ltErrorHandler);
  app.use('/:config/lt', lt);

  const catalog = express.Router({ mergeParams: true });
  catalog.use((_req, res, next) => {
    res.setHeader('Cache-Control', NO_STORE);
    next();
  });

  const sendCatalog = async (req: Request, res: Response, extra: string | undefined): Promise<void> => {
    const token = serviceKey(configOf(req), 'tmdb');
    const def = findCatalog(String(req.params.type), String(req.params.id));
    const metas = def === undefined ? [] : await catalogMetas(ctx, token, def, parseSkip(extra));
    cacheable(res);
    res.json({ metas });
  };
  catalog.get('/:type/:id.json', (req, res) => sendCatalog(req, res, undefined));
  catalog.get('/:type/:id/:extra.json', (req, res) => sendCatalog(req, res, req.params.extra));
  catalog.use(ltErrorHandler);
  app.use('/:config/catalog', catalog);
}
