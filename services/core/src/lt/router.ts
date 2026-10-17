import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../deps.js';
import { catalogMetas, findCatalog, parseSkip } from './catalog.js';
import { personWhy, recommend, why } from './ai.js';
import {
  bodyOf,
  createLtContext,
  decodeFor,
  LtError,
  type LtContext,
  queryOf,
  serviceKey,
} from './context.js';
import { mdblistRatings, tmdbGet, tvdbSeries } from './providers.js';
import { tvChannels, tvEpg, tvHls, tvImport, tvStats } from './tv.js';

/** Erreurs des routes lt : `{ error: code }` (+ `service` si une clé manque). Aucun détail amont. */
export function ltErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof LtError) {
    res.status(err.status).json(err.service === undefined ? { error: err.code } : { error: err.code, service: err.service });
    return;
  }
  console.error('[lt] erreur interne', err instanceof Error ? err.name : 'inconnue');
  res.status(500).json({ error: 'internal' });
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
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  lt.get('/health', (req, res) => {
    const { services } = configOf(req);
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

  // TMDB : chemin en liste blanche (validé dans tmdbGet), paramètres de la requête transmis.
  lt.get(/^\/tmdb\/(.+)$/, async (req, res) => {
    const token = serviceKey(configOf(req), 'tmdb');
    res.json(await tmdbGet(ctx, token, String(req.params[0] ?? ''), queryOf(req)));
  });

  lt.get('/mdblist/:type/:id', async (req, res) => {
    const apiKey = serviceKey(configOf(req), 'mdblist');
    res.json(await mdblistRatings(ctx, apiKey, req.params.type, req.params.id));
  });

  lt.get('/tvdb/series/:id', async (req, res) => {
    const apiKey = serviceKey(configOf(req), 'tvdb');
    try {
      res.json(await tvdbSeries(ctx, apiKey, req.params.id));
    } catch (err) {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][tvdb] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'tvdb_unavailable');
    }
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
    res.json(await tvChannels(ctx));
  });

  lt.get('/tv/epg', async (req, res) => {
    configOf(req);
    res.json(await tvEpg(ctx, queryOf(req)));
  });

  lt.get('/tv/hls', async (req, res) => {
    configOf(req);
    const text = await tvHls(ctx, queryOf(req).u ?? null, `/${tokenOf(req)}/lt/tv/hls?u=`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(text);
  });

  lt.get('/tv/stats', async (req, res) => {
    configOf(req);
    res.json(await tvStats(ctx));
  });

  lt.post('/tv/import', async (req, res) => {
    configOf(req);
    res.json(await tvImport(ctx, bodyOf(req)));
  });

  lt.use((_req, _res, next) => next(new LtError(404, 'not_found')));
  lt.use(ltErrorHandler);
  app.use('/:config/lt', lt);

  const catalog = express.Router({ mergeParams: true });
  catalog.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'max-age=300');
    next();
  });

  const sendCatalog = async (req: Request, res: Response, extra: string | undefined): Promise<void> => {
    const token = serviceKey(configOf(req), 'tmdb');
    const def = findCatalog(String(req.params.type), String(req.params.id));
    if (def === undefined) {
      res.json({ metas: [] });
      return;
    }
    res.json({ metas: await catalogMetas(ctx, token, def, parseSkip(extra)) });
  };
  catalog.get('/:type/:id.json', (req, res) => sendCatalog(req, res, undefined));
  catalog.get('/:type/:id/:extra.json', (req, res) => sendCatalog(req, res, req.params.extra));
  catalog.use(ltErrorHandler);
  app.use('/:config/catalog', catalog);
}
