import type { KvCache, Platform, RuntimeEnv } from './types.js';

export type * from './types.js';

let active: Platform | undefined;

/** Installe la plateforme active. Appelé une fois par chaque point d'entrée (serveur Node, Worker) et par les tests. */
export function setPlatform(next: Platform): void {
  active = next;
}

/** Plateforme active. Erreur explicite si aucun point d'entrée ne l'a installée. */
export function platform(): Platform {
  if (active === undefined) {
    throw new Error("plateforme non initialisée : setPlatform() doit être appelé par le point d'entrée");
  }
  return active;
}

/**
 * Cache persistant partagé entre instances pour `namespace`, ou undefined quand l'instance est unique (Node : la mémoire
 * du processus suffit, aucun second niveau n'est ajouté).
 */
export function sharedKvCache(namespace: string): KvCache | undefined {
  const active = platform();
  return active.capabilities.sharedState ? active.createKvCache(namespace) : undefined;
}

/** Variables d'exécution de la plateforme active. */
export function runtimeEnv(): RuntimeEnv {
  return platform().env;
}
