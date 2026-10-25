/**
 * Budget quotidien global des appels MDBList (ODY-297, lot B) : au plus `budget` appels sortants par jour UTC et par
 * fournisseur, remise à zéro à 00:00 UTC. Un hit de cache ne consomme rien : la garde n'est interrogée qu'avant un
 * appel amont réel. Le temps est toujours passé en paramètre ou lu par la garde, jamais figé dans ce module.
 */

/** Garde de budget : `take` consomme une unité du jour pour `provider` si le budget le permet (true), sinon refuse (false). */
export interface QuotaGate {
  take(provider: string, budget: number): Promise<boolean>;
}

/**
 * Budget par défaut : 80 % du plan gratuit supposé de 1 000 appels par jour, pour garder une marge. À ajuster au plan
 * réel via la variable MDBLIST_DAILY_BUDGET.
 */
export const MDBLIST_DAILY_BUDGET_DEFAULT = 800;

/** Budget depuis une valeur de configuration : entier positif ou nul ; sinon le défaut. */
export function parseDailyBudget(raw: string | undefined): number {
  if (raw === undefined) return MDBLIST_DAILY_BUDGET_DEFAULT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return MDBLIST_DAILY_BUDGET_DEFAULT;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : MDBLIST_DAILY_BUDGET_DEFAULT;
}

/** Jour UTC au format AAAA-MM-JJ (ordre lexicographique = ordre chronologique). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Millisecondes restantes jusqu'à minuit UTC suivant. */
export function msUntilNextUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - ms;
}

/**
 * Garde en mémoire de l'instance (Node, ou Workers sans Durable Object) : un compteur par fournisseur et par jour UTC.
 * Par instance seulement : le budget partagé entre instances passe par le Durable Object (voir platform/workers).
 */
export function memoryQuotaGate(now: () => number = Date.now): QuotaGate {
  const counts = new Map<string, { day: string; used: number }>();
  return {
    take(provider, budget) {
      const day = utcDay(now());
      const current = counts.get(provider);
      const used = current !== undefined && current.day === day ? current.used : 0;
      if (used + 1 > budget) return Promise.resolve(false);
      counts.set(provider, { day, used: used + 1 });
      return Promise.resolve(true);
    },
  };
}
