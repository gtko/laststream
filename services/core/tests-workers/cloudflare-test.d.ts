/** Module de test `cloudflare:test` (@cloudflare/vitest-plugin), limité à ce que les tests utilisent. */
declare module 'cloudflare:test' {
  import type { DurableObjectState, DurableObjectStub } from '@cloudflare/workers-types';

  /** Exécute `callback` dans le contexte du Durable Object visé (accès à l'instance et à son stockage). */
  export function runInDurableObject<O, R>(
    stub: DurableObjectStub,
    callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
  ): Promise<R>;
}
