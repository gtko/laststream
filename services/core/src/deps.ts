import type { AllDebridClient } from './sources/alldebrid.js';

/** Dépendances injectées dans l'application. Ne jamais logger ces valeurs. */
export interface AppDeps {
  /** Clé de chiffrement des configurations. */
  secret: string;
  /** Accepter les configurations en JSON brut (non chiffré). */
  allowPlain: boolean;
  /** Fabrique du client debrid (tests, injection). Par défaut : AllDebridClient réel. */
  alldebridFactory?: (apiKey: string) => Pick<AllDebridClient, 'resolve' | 'checkCached' | 'checkApiKey'>;
  /** fetch injecté pour le client AllDebrid réel (tests). Par défaut : fetch global. */
  fetch?: typeof fetch;
}
