import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppDeps } from '../deps.js';
import { openUserDb, userDbPath } from '../user/db.js';
import { SkipSegmentStore } from '../user/skip-segments.js';
import { catalogMetas, findCatalog, parseSkip } from './catalog.js';
import { personWhy, recommend, why } from './ai.js';
import { bodyOf, createLtContext, decodeFor, LtError, type LtContext, queryOf, serviceKey } from './context.js';
import { seriesEpisodes } from './episodes.js';
import { mdblistRatings, tmdbGet, tmdbPublicParams, tvdbSeries } from './providers.js';
import { createAutoDetector, MAX_REPORT_DURATION, MIN_REPORT_DURATION, validateMediaUrl } from './detect/index.js';
import { parseSkipTarget } from './skip.js';
import { createSkipCommunity } from './skip-community.js';
import { issuedUrls } from '../play/issued.js';
import { ThumbService } from './thumbs/index.js';
import { signRangeToken } from './thumbs/range-token.js';
import { resolveThumbSource } from './thumbs/source.js';
import { parseTvQuery, signTvUrl, tvChannels, tvEpg, tvFacets, tvHls, tvImport, tvStats } from './tv.js';
import type { TvAlternative, TvChannel } from './tv-catalog.js';

/** Réponses d'erreur et POST : jamais en cache. */
const NO_STORE = 'no-store';
/** Réponses GET réussies : cache privé (propre à l'utilisateur), 5 minutes. */
const PRIVATE_CACHE = 'private, max-age=300';
/** Attente maximale d'une miniature demandée avant de répondre 202 (une image prend ~1 s, délai ffmpeg 8 s). */
const THUMB_WAIT_MS = 9000;

/** Secret et base du relais de plages : option explicite (`null` désactive), sinon variables d'environnement. */
function rangeProxyOf(deps: AppDeps): { secret: string; base: string } | null {
  if (deps.rangeProxy !== undefined) return deps.rangeProxy;
  const secret = process.env.LASTADDON_RANGE_SECRET?.trim() ?? '';
  const base = (process.env.LASTADDON_RANGE_BASE ?? '').trim().replace(/\/+$/, '');
  return secret !== '' && /^https:\/\//.test(base) ? { secret, base } : null;
}

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
  let store: SkipSegmentStore | undefined;
  const openStore = (): SkipSegmentStore => (store ??= new SkipSegmentStore(openUserDb(deps.userDbPath ?? userDbPath())));
  // Détection automatique locale (chapitres, empreinte audio) : file en arrière-plan, jamais bloquante pour le GET.
  const detector = createAutoDetector(openStore, {
    disabled: process.env.LASTADDON_SKIP_DETECT === '0',
    ...deps.skipDetect,
  });
  const community = createSkipCommunity(ctx, openStore, detector);
  // Miniatures de la barre (ffmpeg, cache disque) : désactivées sans LASTADDON_FFMPEG valide.
  const thumbs = new ThumbService(deps.thumbs);
  // Miniatures décodées côté client : le Worker relaie les plages, ce serveur n'émet que le jeton HMAC (secret jamais exposé).
  const range = rangeProxyOf(deps);
  const rangeIssued = deps.thumbs?.issued ?? issuedUrls;
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
      capabilities: { thumbs: thumbs.enabled, rangeThumbs: range !== null },
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
    // Une détection en cours change la réponse bientôt : pas de cache.
    if (body.analyzing !== true) cacheable(res);
    res.json(body);
  });

  // Le lecteur rapporte l'URL réellement lue pour un épisode : la détection locale l'analyse en arrière-plan.
  // Corps : { type, imdbId, season, episode, mediaUrl, duration }. L'URL n'est jamais journalisée ni stockée.
  lt.post('/skip/analyze', async (req, res) => {
    configOf(req);
    const body = bodyOf(req);
    const { type, imdbId, season, episode, mediaUrl, duration } = body;
    const invalid = (): never => {
      throw new LtError(400, 'invalid_analyze');
    };
    if (typeof type !== 'string' || typeof imdbId !== 'string') return invalid();
    if (typeof season !== 'number' || typeof episode !== 'number' || !Number.isInteger(season) || !Number.isInteger(episode)) return invalid();
    if (typeof duration !== 'number' || !(duration >= MIN_REPORT_DURATION && duration <= MAX_REPORT_DURATION)) return invalid();
    let target;
    try {
      target = parseSkipTarget(type, imdbId, String(season), String(episode));
    } catch {
      return invalid();
    }
    const url = validateMediaUrl(mediaUrl, deps.skipDetect?.allowLocal);
    if (url === null) return invalid();
    const result = await detector.report({ target, url, duration });
    res.status(202).json({ queued: result.queued, ...(result.reason === undefined ? {} : { reason: result.reason }) });
  });

  // Proposition de segment (ou vote négatif). Débit limité comme les autres POST lt ; clés IntroDB et SkipDB facultatives.
  lt.post('/skip/submit', async (req, res) => {
    res.json(await community.submit(configOf(req).services, bodyOf(req)));
  });

  // Miniatures de la barre : on enregistre une source autorisée (serveur de streaming local ou lien émis par lastAddon),
  // puis on lit les images par tranche de 30 s. 501 si ffmpeg est absent ; 400 si la source est refusée.
  lt.post('/thumbs', async (req, res) => {
    configOf(req);
    if (!thumbs.enabled) throw new LtError(501, 'thumbs_disabled');
    const body = bodyOf(req);
    const registration = await thumbs.register(body.url, body.duration, body.start);
    if (registration === null) throw new LtError(400, 'invalid_source');
    res.json(registration);
  });

  // Source de miniatures décodées côté client (WebCodecs) : même liste d'URL autorisées que /thumbs, mais seules les
  // adresses https publiques (liens débridés) sont acceptées ; la réponse porte le lien lu, un jeton de relais et la base du Worker.
  lt.post('/range-source', async (req, res) => {
    configOf(req);
    if (range === null) throw new LtError(501, 'range_disabled');
    const body = bodyOf(req);
    const source = resolveThumbSource(body.url, rangeIssued, deps.thumbs?.allowLocal);
    if (source === null || source.target.protocol !== 'https:') throw new LtError(400, 'invalid_source');
    const url = source.target.href;
    const { token, exp } = await signRangeToken(range.secret, url);
    res.json({ url, token, exp, base: range.base });
  });

  lt.get('/thumbs/:key/:index.webp', async (req, res) => {
    configOf(req);
    if (!thumbs.enabled) throw new LtError(501, 'thumbs_disabled');
    const key = String(req.params.key);
    const raw = String(req.params.index);
    if (!/^[0-9a-f]{40}$/.test(key) || !/^\d{1,4}$/.test(raw)) throw new LtError(404, 'not_found');
    const frame = await thumbs.frame(key, Number(raw), THUMB_WAIT_MS);
    if (frame.status === 'unknown') throw new LtError(404, 'unknown_source');
    if (frame.status === 'missing') throw new LtError(404, 'not_found');
    if (frame.status === 'pending') {
      res.status(202).json({ pending: true });
      return;
    }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(frame.data);
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
  return () => {
    void detector.close();
    void thumbs.close();
    community.close();
  };
}
