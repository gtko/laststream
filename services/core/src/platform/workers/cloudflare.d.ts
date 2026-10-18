/**
 * Module d'exécution `cloudflare:workers`, déclaré à la main plutôt que par les types globaux de Workers : ceux-ci
 * redéfinissent des globales de Node (Buffer, TextDecoder…) et casseraient la compilation du reste du projet. Les types
 * des ressources (KV, Durable Objects, Assets…) viennent de l'import explicite de `@cloudflare/workers-types`.
 */
declare module 'cloudflare:workers' {
  import type { DurableObjectState } from '@cloudflare/workers-types';

  /** Classe de base des Durable Objects (méthodes publiques appelables en RPC). */
  export abstract class DurableObject<Env = unknown> {
    /** Marque des types RPC de @cloudflare/workers-types (Rpc.DurableObjectBranded). */
    __DURABLE_OBJECT_BRAND: never;
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
  /** Liaisons du Worker (variables, secrets, ressources). */
  export const env: Record<string, unknown>;
  /** Exports du Worker principal (tests : `exports.default.fetch`). */
  export const exports: Record<string, unknown>;
}
