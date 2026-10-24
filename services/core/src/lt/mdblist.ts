import { LtError, type LtContext } from './context.js';
import { MdbRateLimited, mdblistFetch, mdblistTarget, type MdbRatings } from './providers.js';
import { msUntilNextUtcDay } from './quota.js';

/**
 * Notes MDBList derrière la clé de serveur partagée par tous les comptes (quota quotidien limité). Couches, dans l'ordre :
 * 1. cache mémoire de l'instance, qui regroupe aussi les requêtes simultanées pour un même titre ;
 * 2. cache persistant (KV) des notes par titre : 7 jours, 24 h pour un titre sorti depuis moins de 30 jours ;
 * 3. cache négatif court d'un échec amont (2 min, 10 min pour un titre inconnu) ;
 * 4. disjoncteur global (KV) après un 429 : plus aucun appel amont jusqu'à la remise à zéro annoncée par MDBList
 *    (1 h par défaut, bornée à 24 h), la réponse reste un 200 « indisponible temporairement » ;
 * 5. budget quotidien global (jour UTC, remise à zéro à 00:00 UTC) : au-delà, même réponse dégradée, jusqu'à minuit ;
 * 6. limite de débit globale des appels sortants (binding partagé), même réponse dégradée quand elle est atteinte.
 */

const KV_RATING_SECONDS = 7 * 24 * 3600;
const KV_FRESH_SECONDS = 24 * 3600;
const FRESH_RELEASE_DAYS = 30;
const NEGATIVE_SECONDS = 120;
const NEGATIVE_NOT_FOUND_SECONDS = 600;
const BREAKER_DEFAULT_MS = 3600e3;
const BREAKER_MIN_MS = 60e3;
const BREAKER_MAX_MS = 24 * 3600e3;
/** Durée de garde en mémoire d'une réponse dégradée (plafonnée par la fin de la coupure). */
const DEGRADED_MEMORY_MS = 30e3;
const BREAKER_KEY = 'breaker';

export interface MdbResponse extends MdbRatings {
  /** Vrai quand les notes sont momentanément indisponibles (quota ou limite de débit) : les notes sont alors nulles. */
  unavailable?: true;
  /** Secondes avant un nouvel essai utile (réponse indisponible seulement). */
  retryAfter?: number;
}

const EMPTY: MdbRatings = {
  ratings: { imdb: null, rottentomatoes: null, rottentomatoes_audience: null, metacritic: null, letterboxd: null, tmdb: null, trakt: null },
  score: null,
};

const degraded = (retryAfterMs: number): MdbResponse => ({ ...EMPTY, unavailable: true, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) });

/** Durée de conservation (secondes) : 24 h pour un titre sorti depuis moins de 30 jours (ou à venir), sinon 7 jours. */
export function ratingsTtlSeconds(released: string | null, now: number = Date.now()): number {
  if (released === null) return KV_RATING_SECONDS;
  const time = Date.parse(released);
  if (!Number.isFinite(time)) return KV_RATING_SECONDS;
  return now - time < FRESH_RELEASE_DAYS * 24 * 3600e3 ? KV_FRESH_SECONDS : KV_RATING_SECONDS;
}

function isRatings(value: unknown): value is MdbRatings {
  return typeof value === 'object' && value !== null && 'ratings' in value && 'score' in value;
}

async function breakerRemainingMs(ctx: LtContext): Promise<number> {
  const now = Date.now();
  if (ctx.state.mdbBreakerUntil > now) return ctx.state.mdbBreakerUntil - now;
  const raw = await ctx.state.mdbKv.get(BREAKER_KEY).catch(() => undefined);
  const until = raw === undefined ? 0 : Number(raw);
  if (Number.isFinite(until) && until > now) {
    ctx.state.mdbBreakerUntil = until;
    return until - now;
  }
  return 0;
}

async function openBreaker(ctx: LtContext, retryAfterMs: number | undefined): Promise<number> {
  const wait = Math.min(BREAKER_MAX_MS, Math.max(BREAKER_MIN_MS, retryAfterMs ?? BREAKER_DEFAULT_MS));
  const until = Date.now() + wait;
  ctx.state.mdbBreakerUntil = until;
  await ctx.state.mdbKv.set(BREAKER_KEY, String(until), Math.ceil(wait / 1000)).catch(() => undefined);
  console.warn(`[lt][mdblist] quota épuisé : appels coupés ${Math.round(wait / 60e3)} min`);
  return wait;
}

interface Loaded {
  body: MdbResponse;
  memoryMs: number;
}

async function load(ctx: LtContext, apiKey: string, type: string, id: string, kvKey: string): Promise<Loaded> {
  const kv = ctx.state.mdbKv;
  const stored = await kv.get(`r:${kvKey}`).catch(() => undefined);
  if (stored !== undefined) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (isRatings(parsed)) return { body: parsed, memoryMs: 5 * 60e3 };
    } catch {
      /* entrée illisible : rechargée */
    }
  }
  const failed = await kv.get(`n:${kvKey}`).catch(() => undefined);
  if (failed !== undefined) throw new LtError(502, failed, 'mdblist');
  const remaining = await breakerRemainingMs(ctx);
  if (remaining > 0) return { body: degraded(remaining), memoryMs: Math.min(DEGRADED_MEMORY_MS, remaining) };
  // Budget du jour UTC : refus sans appel amont, jusqu'à la remise à zéro de minuit.
  if (!(await ctx.mdbQuota.take('mdblist', ctx.mdbDailyBudget))) {
    return { body: degraded(msUntilNextUtcDay(Date.now())), memoryMs: DEGRADED_MEMORY_MS };
  }
  if (!(await ctx.mdbLimiter())) return { body: degraded(60e3), memoryMs: 10e3 };
  try {
    const { ratings, released } = await mdblistFetch(ctx, apiKey, type, id);
    const seconds = ratingsTtlSeconds(released);
    await kv.set(`r:${kvKey}`, JSON.stringify(ratings), seconds).catch(() => undefined);
    return { body: ratings, memoryMs: 5 * 60e3 };
  } catch (err) {
    if (err instanceof MdbRateLimited) {
      const wait = await openBreaker(ctx, err.retryAfterMs);
      return { body: degraded(wait), memoryMs: Math.min(DEGRADED_MEMORY_MS, wait) };
    }
    if (err instanceof LtError && err.status !== 404 && err.code !== 'upstream_401' && err.code !== 'upstream_403') {
      await kv.set(`n:${kvKey}`, err.code, err.code === 'upstream_404' ? NEGATIVE_NOT_FOUND_SECONDS : NEGATIVE_SECONDS).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Notes d'un titre. Ne lève jamais pour un quota : renvoie alors un 200 avec `unavailable: true`. Les autres échecs
 * amont (404, 5xx, injoignable) lèvent l'erreur habituelle et sont mémorisés brièvement.
 */
export async function mdblistCached(ctx: LtContext, apiKey: string, type: string, id: string): Promise<MdbResponse> {
  const target = mdblistTarget(type, id);
  const kvKey = `${target.source}:${target.mdbType}:${target.id}`;
  const loaded = await ctx.state.cache.get<Loaded>(
    `mdbx:${kvKey}`,
    (value) => value.memoryMs,
    () => load(ctx, apiKey, type, id, kvKey),
  );
  return loaded.body;
}
