import { LtError, type LtContext } from './context.js';
import { mdblistAdmission, mdblistOpenBreaker } from './mdblist-guard.js';
import { MdbRateLimited, mdblistFetch, mdblistTarget, type MdbRatings } from './providers.js';

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
  const refusal = await mdblistAdmission(ctx);
  if (refusal !== undefined) return { body: degraded(refusal.waitMs), memoryMs: refusal.memoryMs };
  try {
    const { ratings, released } = await mdblistFetch(ctx, apiKey, type, id);
    const seconds = ratingsTtlSeconds(released);
    await kv.set(`r:${kvKey}`, JSON.stringify(ratings), seconds).catch(() => undefined);
    return { body: ratings, memoryMs: 5 * 60e3 };
  } catch (err) {
    if (err instanceof MdbRateLimited) {
      const opened = await mdblistOpenBreaker(ctx, err.retryAfterMs);
      return { body: degraded(opened.waitMs), memoryMs: opened.memoryMs };
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
