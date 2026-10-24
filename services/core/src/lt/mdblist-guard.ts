import type { LtContext } from './context.js';
import { msUntilNextUtcDay } from './quota.js';

/**
 * Garde des appels sortants MDBList (clé de serveur partagée par tous les comptes), commune au cache des notes de la
 * route (mdblist.ts) et aux notes des fiches partagées (mdblistRatings avec `guarded`, providers.ts ; le test d'une clé saisie par un compte, checks.ts,
 * n'y est pas soumis). Dans l'ordre : disjoncteur global
 * ouvert après un 429, budget quotidien (jour UTC), limiteur de débit. Un refus n'émet aucun appel amont, et le budget
 * n'est décompté que pour un appel permis.
 */

const BREAKER_DEFAULT_MS = 3600e3;
const BREAKER_MIN_MS = 60e3;
const BREAKER_MAX_MS = 24 * 3600e3;
/** Durée de garde en mémoire d'une réponse dégradée (plafonnée par la fin de la coupure). */
const DEGRADED_MEMORY_MS = 30e3;
const BREAKER_KEY = 'breaker';

/** Refus de la garde : délai avant un nouvel essai utile (ms) et durée de garde en mémoire de la réponse dégradée. */
export interface MdbRefusal {
  waitMs: number;
  memoryMs: number;
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

/** Ouvre le disjoncteur après un 429 (délai annoncé, borné) ; renvoie le refus à servir pendant la coupure. */
export async function mdblistOpenBreaker(ctx: LtContext, retryAfterMs: number | undefined): Promise<MdbRefusal> {
  const wait = Math.min(BREAKER_MAX_MS, Math.max(BREAKER_MIN_MS, retryAfterMs ?? BREAKER_DEFAULT_MS));
  const until = Date.now() + wait;
  ctx.state.mdbBreakerUntil = until;
  await ctx.state.mdbKv.set(BREAKER_KEY, String(until), Math.ceil(wait / 1000)).catch(() => undefined);
  console.warn(`[lt][mdblist] quota épuisé : appels coupés ${Math.round(wait / 60e3)} min`);
  return { waitMs: wait, memoryMs: Math.min(DEGRADED_MEMORY_MS, wait) };
}

/** Autorise un appel amont (undefined) ou le refuse (disjoncteur ouvert, budget du jour épuisé, limiteur atteint). */
export async function mdblistAdmission(ctx: LtContext): Promise<MdbRefusal | undefined> {
  const remaining = await breakerRemainingMs(ctx);
  if (remaining > 0) return { waitMs: remaining, memoryMs: Math.min(DEGRADED_MEMORY_MS, remaining) };
  // Budget du jour UTC : refus sans appel amont, jusqu'à la remise à zéro de minuit.
  if (!(await ctx.mdbQuota.take('mdblist', ctx.mdbDailyBudget))) return { waitMs: msUntilNextUtcDay(Date.now()), memoryMs: DEGRADED_MEMORY_MS };
  if (!(await ctx.mdbLimiter())) return { waitMs: 60e3, memoryMs: 10e3 };
  return undefined;
}
