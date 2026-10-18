import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppDeps } from '../deps.js';
import { type App, type AppEnv, type Ctx, newApp } from '../http/app-env.js';
import { sendBody, sendJson } from '../http/respond.js';
import { platform, runtimeEnv, type ThumbPort, type UserBackend } from '../platform/index.js';
import { catalogMetas, findCatalog, parseSkip } from './catalog.js';
import { personWhy, recommend, why } from './ai.js';
import { createRateLimiter } from '../rate-limit.js';
import { bodyOf, createLtContext, decodeFor, digest, LtError, type LtContext, queryOf, serviceKey } from './context.js';
import { seriesEpisodes } from './episodes.js';
import { mdblistCached } from './mdblist.js';
import { tmdbGet, tmdbPublicParams, tvdbSeries } from './providers.js';
import { MAX_REPORT_DURATION, MIN_REPORT_DURATION, validateMediaUrl } from './detect/media-url.js';
import type { AutoDetector } from './detect/index.js';
import { parseSkipTarget } from './skip.js';
import { createSkipCommunity } from './skip-community.js';
import { issuedUrls } from '../play/issued.js';
import type { FrameResult, Registration } from './thumbs/index.js';
import { parseDebridUrl, rangeHostPatterns } from './thumbs/range-hosts.js';
import { signRangeToken } from './thumbs/range-token.js';
import { resolveThumbSource } from './thumbs/source.js';
import { parseTvQuery, signTvUrl, tvChannels, tvEpg, tvFacets, tvHls, tvImport, tvStats } from './tv.js';
import type { TvAlternative, TvChannel } from './tv-catalog.js';

/** Fermetures des services locaux (détection, miniatures) d'une application. */
const closers = new WeakMap<App, () => void>();

/** Arrête les services locaux d'une application lt (appelé par closeApp). */
export function closeLtRoutes(app: App): void {
  closers.get(app)?.();
  closers.delete(app);
}

/** Réponses d'erreur et POST : jamais en cache. */
const NO_STORE = 'no-store';
/** Réponses GET réussies : cache privé (propre à l'utilisateur), 5 minutes. */
const PRIVATE_CACHE = 'private, max-age=300';
/** Attente maximale d'une miniature demandée avant de répondre 202 (une image prend ~1 s, délai ffmpeg 8 s). */
const THUMB_WAIT_MS = 9000;

/** Secret et base du relais de plages : option explicite (`null` désactive), sinon variables d'environnement. */
function rangeProxyOf(deps: AppDeps): { secret: string; base: string } | null {
  if (deps.rangeProxy !== undefined) return deps.rangeProxy;
  const env = runtimeEnv();
  const secret = env.get('LASTADDON_RANGE_SECRET')?.trim() ?? '';
  const base = (env.get('LASTADDON_RANGE_BASE') ?? '').trim().replace(/\/+$/, '');
  return secret !== '' && /^https:\/\//.test(base) ? { secret, base } : null;
}

/** Signatures de liens débridés directs (/range-source) : au plus 20 par minute et par configuration (en plus de la limite par IP des écritures lt). */
const RANGE_SOURCE_LIMIT = 20;
const RANGE_SOURCE_WINDOW_S = 60;

/** Erreurs des routes lt : `{ error: code }` (+ `service` si une clé manque). Aucun détail amont. */
export const ltErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  c.header('Cache-Control', NO_STORE);
  if (err instanceof LtError) {
    const status = err.status as ContentfulStatusCode;
    return sendJson(c, err.service === undefined ? { error: err.code } : { error: err.code, service: err.service }, status);
  }
  console.error('[lt] erreur interne', err instanceof Error ? err.name : 'inconnue');
  return sendJson(c, { error: 'internal' }, 500);
};

/** Marque une réponse GET réussie comme cacheable. À appeler après l'obtention du corps, jamais avant. */
function cacheable(c: Ctx): void {
  c.header('Cache-Control', PRIVATE_CACHE);
}

/** Chaîne et ses solutions de repli, chacune annotée de sa signature pour la configuration `scope` (le proxy HLS la vérifie). */
type SignedChannel = Omit<TvChannel, 'alternatives'> & {
  sig: string | null;
  alternatives: (TvAlternative & { sig: string | null })[];
};

/** `sig` est null quand la plateforme n'a pas de proxy HLS (Workers) : le lecteur lit alors l'URL du flux directement. */
function signChannel(ctx: LtContext, scope: string, channel: TvChannel, hls: boolean): SignedChannel {
  const sign = (url: string): string | null => (hls ? signTvUrl(ctx, scope, url) : null);
  return {
    ...channel,
    sig: sign(channel.url),
    alternatives: channel.alternatives.map((alt) => ({ ...alt, sig: sign(alt.url) })),
  };
}

/** Service de miniatures : le vrai (ffmpeg local) ou, sans ffmpeg sur cette plateforme, un service désactivé. */
const DISABLED_THUMBS: ThumbPort = {
  enabled: false,
  register: (): Promise<Registration | null> => Promise.resolve(null),
  frame: (): Promise<FrameResult> => Promise.resolve({ status: 'unknown' }),
  close: () => Promise.resolve(),
};

/**
 * Routes publiques par configuration, montées sous `/:config/lt/*` (mêmes chemins que le prototype sans `/api`)
 * et catalogues Stremio sous `/:config/catalog/*`.
 */
export function registerLtRoutes(app: App, deps: AppDeps, backend: UserBackend): void {
  const ctx: LtContext = createLtContext(deps);
  const capabilities = platform().capabilities;
  // Segments de saut communautaires et détectés : base utilisateur de la plateforme, ouverte au premier besoin.
  const openStore = () => backend.skips();
  // Détection automatique locale (chapitres, empreinte audio) : file en arrière-plan, jamais bloquante pour le GET.
  // Absente (null) quand la plateforme n'a pas ffmpeg local (Workers).
  const detector: AutoDetector | null =
    platform().localMedia?.createDetector(openStore, {
      disabled: runtimeEnv().get('LASTADDON_SKIP_DETECT') === '0' || !capabilities.skipDetect,
      ...deps.skipDetect,
    }) ?? null;
  const community = createSkipCommunity(ctx, openStore, detector ?? undefined);
  // Miniatures de la barre (ffmpeg, cache disque) : désactivées sans LASTADDON_FFMPEG valide, ou si la plateforme n'a pas ffmpeg.
  const thumbs: ThumbPort = capabilities.thumbs ? (platform().localMedia?.createThumbs(deps.thumbs) ?? DISABLED_THUMBS) : DISABLED_THUMBS;
  // Miniatures décodées côté client : le Worker relaie les plages, ce serveur n'émet que le jeton HMAC (secret jamais exposé).
  const range = capabilities.rangeThumbs ? rangeProxyOf(deps) : null;
  const rangeIssued = (): ReturnType<typeof issuedUrls> => deps.thumbs?.issued ?? issuedUrls();
  // Limite de débit des liens débridés directs : binding partagé (Workers) ou compteur en mémoire.
  const localRangeLimit = createRateLimiter(RANGE_SOURCE_LIMIT, RANGE_SOURCE_WINDOW_S * 1000);
  const rangeSourceAllowed = (key: string): Promise<boolean> =>
    deps.rangeLimiter !== undefined ? deps.rangeLimiter(key) : Promise.resolve(localRangeLimit(key).allowed);
  // Segment de configuration de l'URL (jeton base64url), présent sur toutes les routes lt et catalogue.
  const tokenOf = (c: Ctx): string => c.req.param('config') ?? '';
  const configOf = (c: Ctx) => decodeFor(deps, tokenOf(c));

  const lt = newApp();
  lt.use('*', async (c, next) => {
    c.header('Cache-Control', NO_STORE);
    await next();
  });

  lt.get('/health', (c) => {
    const { services } = configOf(c);
    cacheable(c);
    return sendJson(c, {
      ok: true,
      configured: {
        tmdb: services.tmdbToken !== undefined,
        mdblist: services.mdblistApiKey !== undefined,
        tvdb: services.tvdbApiKey !== undefined,
        openrouter: services.openrouterApiKey !== undefined,
        fanart: services.fanartApiKey !== undefined,
      },
      capabilities: { thumbs: thumbs.enabled, rangeThumbs: range !== null, tvHls: capabilities.tvHls },
    });
  });

  // TMDB : chemin en liste blanche (validé dans tmdbGet), paramètres en liste blanche (tmdbPublicParams).
  lt.get('/tmdb/:rest{.+}', async (c) => {
    const token = serviceKey(configOf(c), 'tmdb');
    const body = await tmdbGet(ctx, token, c.req.param('rest'), tmdbPublicParams(queryOf(c)));
    cacheable(c);
    return sendJson(c, body);
  });

  lt.get('/mdblist/:type/:id', async (c) => {
    const apiKey = serviceKey(configOf(c), 'mdblist');
    const body = await mdblistCached(ctx, apiKey, c.req.param('type'), c.req.param('id'));
    // Réponse dégradée (quota) : jamais mise en cache par le navigateur.
    if (body.unavailable !== true) cacheable(c);
    return sendJson(c, body);
  });

  lt.get('/tvdb/series/:id', async (c) => {
    const config = configOf(c);
    const apiKey = serviceKey(config, 'tvdb');
    const body = await tvdbSeries(ctx, apiKey, c.req.param('id'), config.services.tvdbPin).catch((err: unknown): never => {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][tvdb] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'tvdb_unavailable');
    });
    cacheable(c);
    return sendJson(c, body);
  });

  // Saisons et épisodes canoniques d'une série (TVDB, groupe TMDB ou TMDB). Langue : fr-FR par défaut.
  lt.get('/series/:tmdbId/episodes', async (c) => {
    const config = configOf(c);
    const body = await seriesEpisodes(
      ctx,
      { tmdbToken: serviceKey(config, 'tmdb'), tvdbApiKey: config.services.tvdbApiKey, tvdbPin: config.services.tvdbPin },
      c.req.param('tmdbId'),
      queryOf(c).language,
    );
    cacheable(c);
    return sendJson(c, body);
  });

  // Segments de saut (intro, reprise, générique) : services externes, puis communauté, puis déduction de saison.
  // Cible validée ; clés IntroDB, SkipDB et Anime Skip facultatives.
  lt.get('/skip/:type/:imdbId/:season/:episode', async (c) => {
    const config = configOf(c);
    const target = parseSkipTarget(c.req.param('type'), c.req.param('imdbId'), c.req.param('season'), c.req.param('episode'));
    const body = await community.resolve(config.services, target).catch((err: unknown): never => {
      if (err instanceof LtError && err.status === 404) throw err;
      console.warn(`[lt][skip] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      throw new LtError(503, 'skip_unavailable');
    });
    // Une détection en cours change la réponse bientôt : pas de cache.
    if (body.analyzing !== true) cacheable(c);
    return sendJson(c, body);
  });

  // Le lecteur rapporte l'URL réellement lue pour un épisode : la détection locale l'analyse en arrière-plan.
  // Corps : { type, imdbId, season, episode, mediaUrl, duration }. L'URL n'est jamais journalisée ni stockée.
  lt.post('/skip/analyze', async (c) => {
    configOf(c);
    const body = bodyOf(c);
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
    const result = detector === null ? { queued: false, reason: 'disabled' } : await detector.report({ target, url, duration });
    return sendJson(c, { queued: result.queued, ...(result.reason === undefined ? {} : { reason: result.reason }) }, 202);
  });

  // Proposition de segment (ou vote négatif). Débit limité comme les autres POST lt ; clés IntroDB et SkipDB facultatives.
  lt.post('/skip/submit', async (c) => sendJson(c, await community.submit(configOf(c).services, bodyOf(c))));

  // Miniatures de la barre : on enregistre une source autorisée (serveur de streaming local ou lien émis par lastAddon),
  // puis on lit les images par tranche de 30 s. 501 si ffmpeg est absent ; 400 si la source est refusée.
  lt.post('/thumbs', async (c) => {
    configOf(c);
    if (!thumbs.enabled) throw new LtError(501, 'thumbs_disabled');
    const body = bodyOf(c);
    const registration = await thumbs.register(body.url, body.duration, body.start);
    if (registration === null) throw new LtError(400, 'invalid_source');
    return sendJson(c, registration);
  });

  // Source de miniatures décodées côté client (WebCodecs) : même liste d'URL autorisées que /thumbs, mais seules les
  // adresses https publiques (liens débridés) sont acceptées ; la réponse porte le lien lu, un jeton de relais et la base du Worker.
  lt.post('/range-source', async (c) => {
    configOf(c);
    if (range === null) throw new LtError(501, 'range_disabled');
    const body = bodyOf(c);
    const source = await resolveThumbSource(body.url, rangeIssued(), deps.thumbs?.allowLocal);
    let url = source !== null && source.target.protocol === 'https:' ? source.target.href : undefined;
    if (url === undefined) {
      // Lien débridé renvoyé directement par un addon externe : signé s'il est d'un domaine autorisé, avec limite de débit par configuration.
      const debrid = parseDebridUrl(body.url, rangeHostPatterns(runtimeEnv().get('LASTADDON_RANGE_HOSTS')));
      if (debrid === null) throw new LtError(400, 'invalid_source');
      if (!(await rangeSourceAllowed(digest(tokenOf(c))))) {
        c.header('Retry-After', String(RANGE_SOURCE_WINDOW_S));
        throw new LtError(429, 'rate_limited');
      }
      url = debrid.href;
    }
    const { token, exp } = await signRangeToken(range.secret, url);
    return sendJson(c, { url, token, exp, base: range.base });
  });

  lt.get('/thumbs/:key/:indexwebp{[^/]+\\.webp}', async (c) => {
    configOf(c);
    if (!thumbs.enabled) throw new LtError(501, 'thumbs_disabled');
    const key = c.req.param('key');
    const raw = c.req.param('indexwebp').replace(/\.webp$/, '');
    if (!/^[0-9a-f]{40}$/.test(key) || !/^\d{1,4}$/.test(raw)) throw new LtError(404, 'not_found');
    const frame = await thumbs.frame(key, Number(raw), THUMB_WAIT_MS);
    if (frame.status === 'unknown') throw new LtError(404, 'unknown_source');
    if (frame.status === 'missing') throw new LtError(404, 'not_found');
    if (frame.status === 'pending') return sendJson(c, { pending: true }, 202);
    c.header('Cache-Control', 'private, max-age=86400');
    return sendBody(c, frame.data, 200, 'image/webp');
  });

  lt.post('/recommend', async (c) => sendJson(c, await recommend(ctx, configOf(c), bodyOf(c))));

  lt.post('/why', async (c) => sendJson(c, await why(ctx, configOf(c), bodyOf(c))));

  lt.post('/person-why', async (c) => sendJson(c, await personWhy(ctx, configOf(c), bodyOf(c))));

  // TV : valide la configuration de l'URL ; aucune clé de service requise.
  // Filtres : country, language, category, source, q. Pagination : page, limit (sans les deux : tout le catalogue).
  // Sans limit ni page : tableau. Sinon : enveloppe { total, page, limit, channels }.
  lt.get('/tv/channels', async (c) => {
    configOf(c);
    const scope = tokenOf(c);
    const query = parseTvQuery(queryOf(c));
    const page = await tvChannels(ctx, query);
    const channels = page.items.map((channel) => signChannel(ctx, scope, channel, capabilities.tvHls));
    cacheable(c);
    if (query.limit === undefined) return sendJson(c, channels);
    return sendJson(c, { total: page.total, page: query.page ?? 1, limit: query.limit, channels });
  });

  lt.get('/tv/facets', async (c) => {
    configOf(c);
    const body = await tvFacets(ctx);
    cacheable(c);
    return sendJson(c, body);
  });

  lt.get('/tv/epg', async (c) => {
    configOf(c);
    const body = await tvEpg(ctx, queryOf(c));
    cacheable(c);
    return sendJson(c, body);
  });

  lt.get('/tv/hls', async (c) => {
    configOf(c);
    if (!capabilities.tvHls) throw new LtError(501, 'tv_hls_disabled');
    const query = queryOf(c);
    const text = await tvHls(ctx, tokenOf(c), query.u ?? null, query.s ?? null);
    // Playlist en direct : elle change à chaque segment, le lecteur doit la relire sans cache (no-store, cf. fef31bf).
    return sendBody(c, text, 200, 'application/vnd.apple.mpegurl; charset=utf-8');
  });

  lt.get('/tv/stats', async (c) => {
    configOf(c);
    const body = await tvStats(ctx);
    cacheable(c);
    return sendJson(c, body);
  });

  lt.post('/tv/import', async (c) => {
    configOf(c);
    const imported = await tvImport(ctx, bodyOf(c));
    return sendJson(c, { count: imported.count, channels: imported.channels.map((channel) => signChannel(ctx, tokenOf(c), channel, capabilities.tvHls)) });
  });

  lt.all('*', () => {
    throw new LtError(404, 'not_found');
  });
  lt.onError(ltErrorHandler);
  app.route('/:config/lt', lt);

  const catalog = newApp();
  catalog.use('*', async (c, next) => {
    c.header('Cache-Control', NO_STORE);
    await next();
  });

  const sendCatalog = async (c: Ctx, extra: string | undefined): Promise<Response> => {
    const token = serviceKey(configOf(c), 'tmdb');
    const def = findCatalog(c.req.param('type') ?? '', (c.req.param('idjson') ?? '').replace(/\.json$/, ''));
    const metas = def === undefined ? [] : await catalogMetas(ctx, token, def, parseSkip(extra));
    cacheable(c);
    return sendJson(c, { metas });
  };
  catalog.get('/:type/:idjson{[^/]+\\.json}', (c) => sendCatalog(c, undefined));
  catalog.get('/:type/:idjson/:extrajson{[^/]+\\.json}', (c) => sendCatalog(c, c.req.param('extrajson').replace(/\.json$/, '')));
  catalog.onError(ltErrorHandler);
  app.route('/:config/catalog', catalog);
  closers.set(app, () => {
    void detector?.close();
    void thumbs.close();
  });
}
