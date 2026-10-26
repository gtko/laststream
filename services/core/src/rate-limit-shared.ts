import { createRateLimiter } from './rate-limit.js';

/**
 * Limites de débit partagées entre instances (isolats) du Worker. `rate-limit.ts` compte en mémoire, par isolat : la limite
 * réelle vaut N fois la limite voulue pour N isolats. Ici, chaque limite sensible ajoute une seconde barrière, la liaison
 * Rate Limiting de Cloudflare (compteur partagé par emplacement). Les deux barrières sont cumulées : la Map locale reste le
 * repli quand la liaison est absente (tests, Node, dev) ou en panne.
 */

/** Liaison Rate Limiting de Workers (période de 10 ou 60 secondes seulement, limite fixée dans wrangler.jsonc). */
export interface LimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Limites sensibles protégées par une liaison partagée : nom → liaison d'environnement et période de la liaison (s). Plusieurs
 * noms peuvent partager une liaison (même limite et même période) : la clé envoyée à la liaison est préfixée par le nom,
 * les compteurs restent distincts.
 */
export const SHARED_LIMITS = {
  config: { binding: 'RL_30_PER_MIN', periodSec: 60 },
  ltWrite: { binding: 'RL_30_PER_MIN', periodSec: 60 },
  partyWrite: { binding: 'RL_30_PER_MIN', periodSec: 60 },
  adminWrite: { binding: 'RL_30_PER_MIN', periodSec: 60 },
  adminRead: { binding: 'RL_120_PER_MIN', periodSec: 60 },
  partyRead: { binding: 'RL_120_PER_MIN', periodSec: 60 },
  userWrite: { binding: 'RL_120_PER_MIN', periodSec: 60 },
  userRead: { binding: 'RL_300_PER_MIN', periodSec: 60 },
  ltRead: { binding: 'RL_1200_PER_MIN', periodSec: 60 },
  userSensitive: { binding: 'RL_10_PER_MIN', periodSec: 60 },
  liveTicket: { binding: 'RL_20_PER_MIN', periodSec: 60 },
  typing: { binding: 'RL_TYPING', periodSec: 10 },
  socialUpgrade: { binding: 'RL_30_PER_MIN', periodSec: 60 },
  partyUpgrade: { binding: 'RL_60_PER_MIN', periodSec: 60 },
  partyAccountUpgrade: { binding: 'RL_30_PER_MIN', periodSec: 60 },
} as const;

export type SharedLimitName = keyof typeof SHARED_LIMITS;

/** Liaisons disponibles, par nom de limite (absente : repli sur la Map locale seule). */
export type SharedLimits = Partial<Record<SharedLimitName, LimitBinding>>;

/** Verdict d'une limite : `retryAfterSec` alimente l'en-tête Retry-After. */
export interface LimitVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

/** Construit les limites partagées depuis les liaisons de l'environnement Workers (celles qui manquent sont omises). */
export function sharedLimitsFromEnv(env: Readonly<Record<string, unknown>>): SharedLimits {
  const limits: Partial<Record<SharedLimitName, LimitBinding>> = {};
  for (const name of Object.keys(SHARED_LIMITS) as SharedLimitName[]) {
    const candidate = env[SHARED_LIMITS[name].binding];
    if (isLimitBinding(candidate)) limits[name] = candidate;
  }
  return limits;
}

function isLimitBinding(value: unknown): value is LimitBinding {
  return typeof value === 'object' && value !== null && typeof (value as { limit?: unknown }).limit === 'function';
}

let isolate: string | undefined;

/**
 * Identifiant aléatoire de cet isolat, généré au premier usage (jamais en portée globale : Cloudflare refuse le déploiement
 * d'un Worker qui tire de l'aléa au chargement, erreur 10021). Journalisé dans les refus : le nombre d'identifiants
 * distincts vus par `wrangler tail` estime le nombre d'instances actives.
 */
export function isolateId(): string {
  if (isolate === undefined) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    isolate = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return isolate;
}

/** Journalise un refus (nom de la limite, isolat) : jamais la clé, qui peut être une IP ou un identifiant. */
export function logRefusal(limiter: string, scope: string = 'shared'): void {
  console.warn(`[rate-limit] refus ${JSON.stringify({ limiter, scope, isolate: isolateId() })}`);
}

/**
 * Limiteur à deux barrières. 1) Map locale (`limit` par `windowMs`, par isolat) ; 2) liaison partagée de `name` si elle est
 * fournie. Une panne de la liaison laisse passer (la Map locale a déjà joué) : une limite ne doit pas devenir une panne.
 */
export function createSharedLimiter(
  shared: SharedLimits | undefined,
  name: SharedLimitName,
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): (key: string) => Promise<LimitVerdict> {
  const local = createRateLimiter(limit, windowMs, now);
  const binding = shared?.[name];
  const { periodSec } = SHARED_LIMITS[name];
  return async (key) => {
    const verdict = local(key);
    if (!verdict.allowed || binding === undefined) return verdict;
    let success: boolean;
    try {
      success = (await binding.limit({ key: `${name}:${key}` })).success;
    } catch {
      success = true;
    }
    if (success) return verdict;
    logRefusal(name, 'shared');
    return { allowed: false, retryAfterSec: periodSec };
  };
}

/**
 * Variante pour les portes traitées hors application (mises à niveau WebSocket) : la Map locale vit dans le module, les
 * liaisons arrivent à chaque appel. Un même objet `shared` retrouve le même limiteur (Map conservée d'une requête à l'autre).
 */
export function sharedLimiterFor(
  name: SharedLimitName,
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): (shared: SharedLimits | undefined, key: string) => Promise<LimitVerdict> {
  const bySharedObject = new WeakMap<object, (key: string) => Promise<LimitVerdict>>();
  let withoutShared: ((key: string) => Promise<LimitVerdict>) | undefined;
  return (shared, key) => {
    let limiter = shared === undefined ? withoutShared : bySharedObject.get(shared);
    if (limiter === undefined) {
      limiter = createSharedLimiter(shared, name, limit, windowMs, now);
      if (shared === undefined) withoutShared = limiter;
      else bySharedObject.set(shared, limiter);
    }
    return limiter(key);
  };
}
