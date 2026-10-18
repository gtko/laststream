import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';
import type { EnvLike, RuntimeEnv } from '../types.js';
import type { PartyRoom } from './party-room.js';
import type { UserStoreDO } from './user-store-do.js';

/** Binding de service (Workers Assets) : seule la méthode fetch sert, avec les types Request/Response de l'application. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Binding Rate Limiting de Workers (période de 10 ou 60 secondes seulement). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Liaisons du Worker lastaddon-core (voir wrangler.jsonc) : variables, secrets et ressources. */
export interface WorkerEnv {
  /** Durable Object des données utilisateur. */
  USER_STORE: DurableObjectNamespace<UserStoreDO>;
  /** Durable Objects des salons de visionnage (un par salon). */
  PARTY_ROOM: DurableObjectNamespace<PartyRoom>;
  /** KV des caches persistants (statut AllDebrid, packs, URL émises, état de lecture). */
  CACHE: KVNamespace;
  /** Interface web (Workers Assets). */
  ASSETS: AssetsFetcher;
  /** Limite de connexion/inscription par IP et par nom d'utilisateur (absentes : compteurs en mémoire). */
  AUTH_LIMITER_IP?: RateLimitBinding;
  AUTH_LIMITER_USER?: RateLimitBinding;
  /** Autres liaisons : variables (chaînes) et secrets. */
  [name: string]: unknown;
}

/**
 * Noms de secrets du Worker → variables lues par l'application. Les secrets du Worker portent le nom court
 * (`RANGE_SECRET`, `EDGE_SECRET`), comme dans le Worker de relais ; l'application lit les noms LASTADDON_*.
 */
const ALIASES: Readonly<Record<string, string>> = {
  LASTADDON_RANGE_SECRET: 'RANGE_SECRET',
  LASTADDON_EDGE_SECRET: 'EDGE_SECRET',
};

/** Variables d'exécution d'un Worker : liaisons de type chaîne (variables et secrets). Lecture seule. */
export function workersRuntimeEnv(env: WorkerEnv): RuntimeEnv {
  const get = (name: string): string | undefined => {
    const direct = env[name];
    if (typeof direct === 'string') return direct;
    const alias = ALIASES[name];
    const aliased = alias === undefined ? undefined : env[alias];
    return typeof aliased === 'string' ? aliased : undefined;
  };
  return {
    get,
    all: (): EnvLike => {
      const out: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(env)) if (typeof value === 'string') out[name] = value;
      for (const name of Object.keys(ALIASES)) out[name] ??= get(name);
      return out;
    },
  };
}
