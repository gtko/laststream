import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../deps.js';
import { openUserDb, userDbPath } from '../user/db.js';
import { SkipSegmentStore } from '../user/skip-segments.js';
import { catalogMetas, findCatalog, parseSkip } from './catalog.js';
import { personWhy, recommend, why } from './ai.js';
import { bodyOf, createLtContext, decodeFor, LtError, type LtContext, queryOf, serviceKey } from './context.js';
import { seriesEpisodes } from './episodes.js';
import { mdblistRatings, tmdbGet, tmdbPublicParams, tvdbSeries } from './providers.js';
import { parseSkipTarget } from './skip.js';
import { createSkipCommunity } from './skip-community.js';
import { parseTvQuery, signTvUrl, tvChannels, tvEpg, tvFacets, tvHls, tvImport, tvStats } from './tv.js';
import type { TvAlternative, TvChannel } from './tv-catalog.js';

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

/** Chaîne et ses solutions de repli, chacune annotée de sa signature pour la configuration `scope` (le proxy HLS la vérifie). */
type SignedChannel = Omit<TvChannel, 'alternatives'> & {
  sig: string | null;
  alternatives: (TvAlternative & { sig: string | null })[];
};

function signChannel(ctx: LtContext, scope: string, channel: TvChannel): SignedChannel {
  return {
    ...channel,
    sig: signTvUrl(ctx, scope, channel.url),
    alternatives: channel.alternatives.map((alt) => ({ ...alt, sig: signTvUrl(ctx, scope, alt.url) })),
  };
}

/**
 * Routes publiques par configuration, montées sous `/:config/lt/*` (mêmes chemins que le prototype sans `/api`)
 * et catalogues Stremio sous `/:config/catalog/*`.
 */
export function registerLtRoutes(app: Express, deps: AppDeps): () => void {
  const ctx: LtContext = createLtContext(deps);
  // Base utilisateur ouverte au premier besoin (store communautaire des segments de saut).
  const community = createSkipCommunity(ctx, () => new SkipSegmentStore(openUserDb(deps.userDbPath ?? userDbPath())));
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

  // Saisons et épisodes canoniques d'une série (TVDB, groupe TMDB ou TMDB). Langue : fr-FR par défaut.
  lt.get('/series/:tmdbId/episodes', async (req, res) => {
    const config = configOf(req);
    const body = await seriesEpisodes(
      ctx,
      { tmdbToken: serviceKey(config, 'tmdb'), tvdbApiKey: config.services.tvdbApiKey, tvdbPin: config.services.tvdbPin },
      req.params.tmdbId,
      queryOf(req).language,
    );
    cacheable(res);
    res.json(body);
  });

  // Segments de saut (intro, reprise, générique) : services externes, puis communauté, puis déduction de saison.
  // Cible validée ; clés IntroDB, SkipDB et Anime Skip facultatives.
  lt.get('/skip/:type/:imdbId/:season/:episode', async (req, res) => {
    const config = configOf(req);
    const target = parseSkipTarget(req.params.type, req.params.imdbId, req.params.season, req.params.episode);
    const body = await community.resolve(config.services, target).catch((err: unknown): never => {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][skip] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'skip_unavailable');
    });
    cacheable(res);
    res.json(body);
  });

  // Proposition de segment (ou vote négatif). Débit limité comme les autres POST lt ; clés IntroDB et SkipDB facultatives.
  lt.post('/skip/submit', async (req, res) => {
    res.json(await community.submit(configOf(req).services, bodyOf(req)));
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
  // Filtres : country, language, category, source, q. Pagination : page, limit (sans les deux : tout le catalogue).
  // Sans limit ni page : tableau. Sinon : enveloppe { total, page, limit, channels }.
  lt.get('/tv/channels', async (req, res) => {
    configOf(req);
    const scope = tokenOf(req);
    const query = parseTvQuery(queryOf(req));
    const page = await tvChannels(ctx, query);
    const channels = page.items.map((channel) => signChannel(ctx, scope, channel));
    cacheable(res);
    if (query.limit === undefined) {
      res.json(channels);
      return;
    }
    res.json({ total: page.total, page: query.page ?? 1, limit: query.limit, channels });
  });

  lt.get('/tv/facets', async (req, res) => {
    configOf(req);
    const body = await tvFacets(ctx);
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
    // Playlist en direct : elle change à chaque segment, le lecteur doit la relire sans cache (no-store, cf. fef31bf).
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
    res.json({ count: imported.count, channels: imported.channels.map((channel) => signChannel(ctx, tokenOf(req), channel)) });
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
  return () => community.close();
}
