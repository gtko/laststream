import type { AppDeps } from '../deps.js';
import type { App, Ctx } from '../http/app-env.js';
import { sendJson } from '../http/respond.js';
import type { MetricsService } from '../metrics/core.js';
import { buildProviderHealth, type ProviderHealth } from '../metrics/health.js';
import { isProvider, PROVIDERS, type ProviderName } from '../metrics/providers.js';
import type { ServerServices } from '../config/server-services.js';
import { platform } from '../platform/index.js';
import { createRateLimiter } from '../rate-limit.js';
import type { Session } from '../user/session.js';
import { UserApiError } from '../user/validation.js';
import type { CacheAdmin, CacheStat, PurgeJob, TvCronState } from './cache-types.js';
import { type R2BucketName, R2_BUCKET_NAMES, type R2Usage, nextTvRun, r2UsageOf, tvOverdue } from './ops-stats.js';

/**
 * Sources, stockage et tâches de l'administration (/admin/providers, /admin/storage, /admin/tasks). Ces routes sont
 * enregistrées par registerAdminRoutes (api.ts) avec ses gardes (propriétaire, journal d'audit). Aucun appel AllDebrid
 * ne part du serveur : AllDebrid est refusé d'office par le test fournisseur.
 */

/** Délai unique d'une requête de test fournisseur (ms). */
const PROVIDER_TEST_TIMEOUT_MS = 4000;
/** Tests fournisseur par minute et par IP (limiteur dédié, en plus des limites générales de /admin). */
const PROVIDER_TEST_PER_MIN = 10;
/** Durée de vie des statistiques de stockage (ms), par instance. */
const STORAGE_TTL_MS = 5 * 60_000;
/** Fournisseur refusé d'office : jamais d'appel AllDebrid depuis le serveur (compte suspendu pour appels depuis Cloudflare). */
const ALLDEBRID = 'alldebrid';

/** Erreur d'un test : délai, réseau, clé refusée (401/403), autre statut HTTP en échec. */
type ProviderTestError = 'timeout' | 'network' | 'rejected' | 'http';

/** Résultat d'un test fournisseur. Jamais la clé, jamais le corps de la réponse. */
interface ProviderTest {
  id: ProviderName;
  ok: boolean;
  /** Statut HTTP de la dernière réponse, ou null sans réponse (délai, réseau). */
  status: number | null;
  latencyMs: number;
  error?: ProviderTestError;
}

type Send = (url: string, init?: RequestInit) => Promise<Response>;
/** Requête légère d'un fournisseur (clé du serveur) : renvoie la réponse finale. */
type ProviderProbe = (send: Send) => Promise<Response>;

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TVDB_V4_BASE = 'https://api4.thetvdb.com/v4';
/** API v3 : seule à accepter les clés legacy. */
const TVDB_V3_BASE = 'https://api.thetvdb.com';
const JSON_HEADERS = { accept: 'application/json' } as const;

const LABELS: Record<ProviderName, string> = {
  tmdb: 'TMDB',
  tvdb: 'TheTVDB',
  openrouter: 'OpenRouter',
  cinemeta: 'Cinemeta',
  mdblist: 'MDBList',
  fanart: 'Fanart.tv',
  rows: 'Rangées d’accueil (R2)',
};

/** Clé du serveur (base de l'administration, sinon variable d'exécution ; non vide), ou undefined. */
function serverKey(keys: ServerServices, name: keyof ServerServices): string | undefined {
  const value = keys[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

const loginRequest = (payload: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { ...JSON_HEADERS, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

/**
 * Requête légère par fournisseur, avec la clé du serveur. undefined : non testable (aucune clé, ou aucun appel amont
 * pour R2). TheTVDB n'a pas de lecture sans jeton : la connexion (POST /login) valide la clé, v4 puis v3 si v4 refuse.
 */
const PROBES: Record<ProviderName, (keys: ServerServices) => ProviderProbe | undefined> = {
  tmdb: (keys) => {
    const token = serverKey(keys, 'tmdbToken');
    if (token !== undefined) {
      return (send) => send(`${TMDB_BASE}/configuration`, { headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` } });
    }
    const key = serverKey(keys, 'tmdbApiKey');
    if (key !== undefined) return (send) => send(`${TMDB_BASE}/configuration?api_key=${encodeURIComponent(key)}`, { headers: JSON_HEADERS });
    return undefined;
  },
  tvdb: (keys) => {
    const apikey = serverKey(keys, 'tvdbApiKey');
    if (apikey === undefined) return undefined;
    const pin = serverKey(keys, 'tvdbPin');
    return async (send) => {
      const v4 = await send(`${TVDB_V4_BASE}/login`, loginRequest(pin === undefined ? { apikey } : { apikey, pin }));
      if (v4.status !== 401) return v4;
      await discard(v4);
      return send(`${TVDB_V3_BASE}/login`, loginRequest({ apikey }));
    };
  },
  openrouter: (keys) => {
    const key = serverKey(keys, 'openrouterApiKey');
    if (key === undefined) return undefined;
    return (send) => send('https://openrouter.ai/api/v1/auth/key', { headers: { ...JSON_HEADERS, authorization: `Bearer ${key}` } });
  },
  mdblist: (keys) => {
    const key = serverKey(keys, 'mdblistApiKey');
    if (key === undefined) return undefined;
    return (send) => send(`https://api.mdblist.com/imdb/movie/tt0133093?apikey=${encodeURIComponent(key)}`, { headers: JSON_HEADERS });
  },
  fanart: (keys) => {
    const key = serverKey(keys, 'fanartApiKey');
    if (key === undefined) return undefined;
    return (send) => send(`https://webservice.fanart.tv/v3/movies/603?api_key=${encodeURIComponent(key)}`, { headers: JSON_HEADERS });
  },
  // Cinemeta est public : aucune clé à tester.
  cinemeta: () => (send) => send('https://v3-cinemeta.strem.io/meta/movie/tt0133093.json', { headers: JSON_HEADERS }),
  rows: () => undefined,
};

/** Vide le corps d'une réponse non lue (libère la connexion). */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // corps déjà consommé ou fermé
  }
}

/**
 * Exécute la requête légère d'un fournisseur sous un délai unique (4 s, y compris une éventuelle seconde requête).
 * Ne lève jamais : toute erreur devient un résultat. Ni la clé ni le corps de réponse ne sortent de cette fonction.
 */
async function runProviderTest(id: ProviderName, probe: ProviderProbe, fetchFn: typeof fetch): Promise<ProviderTest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
  const started = Date.now();
  const send: Send = (url, init = {}) => fetchFn(url, { ...init, signal: controller.signal });
  try {
    const response = await probe(send);
    await discard(response);
    const latencyMs = Date.now() - started;
    if (response.ok) return { id, ok: true, status: response.status, latencyMs };
    const rejected = response.status === 401 || response.status === 403;
    return { id, ok: false, status: response.status, latencyMs, error: rejected ? 'rejected' : 'http' };
  } catch {
    return { id, ok: false, status: null, latencyMs: Date.now() - started, error: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fournisseur de la liste : taux de succès, latence p95, sparkline, dernier échec et statut viennent de la santé mesurée
 * sur les appels sortants (metrics/health.ts). Sans donnée, les champs sont null et le statut unknown.
 */
function providerEntry(id: ProviderName, keys: ServerServices, health: ProviderHealth) {
  return {
    id,
    label: LABELS[id],
    successRate: health.successRate,
    p95: health.p95,
    spark: health.spark,
    lastFailureAt: health.lastFailureAt,
    status: health.status,
    testable: PROBES[id](keys) !== undefined,
  };
}

/**
 * Liste des fournisseurs (GET /admin/providers), partagée avec le centre de contrôle : une seule construction, à partir de
 * la santé mesurée (buildProviderHealth). Les mêmes entrées servent aux statuts et aux éléments de la boîte.
 */
export function providerEntries(keys: ServerServices, health: Record<ProviderName, ProviderHealth>) {
  return PROVIDERS.map((id) => providerEntry(id, keys, health[id]));
}

/** Statistiques de stockage : caches KV, buckets R2 (TV, META, AVATARS) et base SQLite du Durable Object. */
interface StorageReport {
  kv: { prefixes: { prefix: string; keys: number; exact: boolean; hitRate: number | null }[] };
  r2: ({ bucket: R2BucketName } & R2Usage)[];
  do: { sizeBytes: number | null; tables: { name: string; rows: number | null }[] };
  cachedAt: string;
}

/** Valeur d'une lecture, ou undefined si elle échoue (indisponible). */
async function settle<T>(read: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** Dépendances fournies par api.ts : gardes d'accès et journal d'audit du module d'administration. */
export interface OpsRouteContext {
  deps: AppDeps;
  owner(c: Ctx): Promise<Session>;
  elevated(c: Ctx, session: Session): void;
  audit(session: Session, action: string, target: string | null, detail?: Record<string, unknown> | null): Promise<void>;
  metrics(): MetricsService | undefined;
  caches(): CacheAdmin | undefined;
  /** Clés serveur effectives (base de l'administration, puis variables d'exécution). */
  serverKeys(): Promise<ServerServices>;
}

/** Routes /admin/providers, /admin/storage et /admin/tasks, toutes réservées au propriétaire (gardes de api.ts). */
export function registerOpsRoutes(router: App, ctx: OpsRouteContext): void {
  const { deps, owner, elevated, audit } = ctx;
  const testLimiter = createRateLimiter(PROVIDER_TEST_PER_MIN, 60_000);
  let storage: { at: number; report: StorageReport } | undefined;

  async function storageReport(now: number): Promise<StorageReport> {
    const [stats, report, sql, r2] = await Promise.all([
      settle(() => ctx.caches()?.stats()),
      settle(() => ctx.metrics()?.report('24h')),
      settle(() => deps.ops?.sqlStats?.()),
      Promise.all(R2_BUCKET_NAMES.map(async (bucket) => ({ bucket, ...(await r2UsageOf(deps.ops?.r2?.[bucket])) }))),
    ]);
    const rates = new Map((report?.caches ?? []).map((entry) => [entry.prefix, entry.hitRate] as const));
    return {
      kv: {
        prefixes: (stats ?? []).map((stat: CacheStat) => ({
          prefix: stat.prefix,
          keys: stat.keys,
          exact: stat.exact,
          hitRate: rates.get(stat.prefix) ?? null,
        })),
      },
      r2,
      do: { sizeBytes: sql?.sizeBytes ?? null, tables: sql?.tables ?? [] },
      cachedAt: new Date(now).toISOString(),
    };
  }

  router.get('/providers', async (c) => {
    await owner(c);
    const [rows, keys] = await Promise.all([settle(() => ctx.metrics()?.providerHours?.()), ctx.serverKeys()]);
    const health = buildProviderHealth(rows ?? [], Date.now());
    return sendJson(c, { providers: providerEntries(keys, health) });
  });

  /** Requête légère vers le fournisseur (clé du serveur) : élévation, audité, 10 par minute et par IP, délai de 4 s. */
  router.post('/providers/:id/test', async (c) => {
    const session = await owner(c);
    elevated(c, session);
    const id = c.req.param('id');
    if (id === ALLDEBRID) throw new UserApiError(400, 'not_testable');
    if (!isProvider(id)) throw new UserApiError(404, 'provider_not_found');
    const probe = PROBES[id](await ctx.serverKeys());
    if (probe === undefined) throw new UserApiError(400, 'not_testable');
    const verdict = testLimiter(c.get('ip') ?? 'inconnu');
    if (!verdict.allowed) throw new UserApiError(429, 'rate_limited', undefined, verdict.retryAfterSec);
    await audit(session, 'provider.test', id);
    return sendJson(c, await runProviderTest(id, probe, deps.fetch ?? platform().http.fetch));
  });

  /** Statistiques de stockage, gardées 5 minutes par instance (cachedAt donne l'âge). */
  router.get('/storage', async (c) => {
    await owner(c);
    const now = Date.now();
    if (storage === undefined || now - storage.at >= STORAGE_TTL_MS) storage = { at: now, report: await storageReport(now) };
    return sendJson(c, storage.report);
  });

  /** Dernier passage du cron TV, prochain passage, et purges de cache (progress : 1 quand terminée, sinon null). */
  router.get('/tasks', async (c) => {
    await owner(c);
    const now = Date.now();
    const tvAdmin = deps.tvAdmin;
    let lastCron: TvCronState | null = null;
    let overdue = false;
    if (tvAdmin !== undefined) {
      try {
        lastCron = await tvAdmin.lastCron();
        overdue = tvOverdue(lastCron, now);
      } catch {
        lastCron = null;
        overdue = false;
      }
    }
    const purges = (await settle(() => ctx.caches()?.purgeJobs())) ?? [];
    return sendJson(c, {
      tv: { lastCron, nextRunAt: tvAdmin === undefined ? null : nextTvRun(now), overdue },
      purges: purges.map((job: PurgeJob) => ({ ...job, progress: job.status === 'done' ? 1 : null })),
    });
  });
}
