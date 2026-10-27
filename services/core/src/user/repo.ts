import type { AdminStore } from './admin-store.js';
import type { MetaStore } from './meta-store.js';
import type { EveningStore } from './social-evenings-store.js';
import type { SkipSegmentStore } from './skip-segments.js';
import type { SocialStore } from './social-store.js';
import type { SocialV2Store } from './social-v2-store.js';
import type { SocialV3Store } from './social-v3-store.js';
import type { UserStore } from './store.js';

/**
 * Dépôts de données asynchrones : le code applicatif (routes /user, routes lt) n'appelle que ces interfaces, jamais
 * les stores SQL synchrones. Node : les stores locaux (node:sqlite) enveloppés par `asyncRepo`. Workers : un Durable
 * Object SQLite appelé en RPC (voir platform/workers/user-backend.ts). Les deux exposent les mêmes méthodes.
 */

/** Version asynchrone d'une classe de store : mêmes méthodes publiques, résultat en Promise. */
export type AsyncRepo<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inférence des paramètres de méthodes arbitraires
  [K in keyof T as T[K] extends (...args: any[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** Données des comptes, sessions, profils, bibliothèque, progression, suivis, notes et réglages. */
export type UserRepo = AsyncRepo<Omit<UserStore, 'transaction' | 'close'>>;

/** Segments de saut communautaires et détectés, empreintes de saison. */
export type SkipRepo = AsyncRepo<Omit<SkipSegmentStore, 'close'>>;

/** Parrainage, amis, présence, bibliothèque partagée, titres masqués, annuaire des salons. */
export type SocialRepo = AsyncRepo<SocialStore>;

/** Social v2 par profil : handles Nom#TAG, amitiés et foyer entre profils, présence par profil, bibliothèque et historique. */
export type SocialV2Repo = AsyncRepo<SocialV2Store>;

/** Partage (S3b) : messages de partage multiples, liens publics, listes partagées. */
export type SocialV3Repo = AsyncRepo<SocialV3Store>;

/** Soirées planifiées (LAST-198) : soirées ponctuelles et séries, invitations, réponses, rappels. */
export type SocialEveningsRepo = AsyncRepo<EveningStore>;

/** Administration : comptes, réglages globaux, journal d'audit, réinitialisation de mot de passe, signalements. */
export type AdminRepo = AsyncRepo<AdminStore>;

/** Index des fiches partagées (R2 meta/…) : identifiants croisés, recherche par IMDb ou TVDB. */
export type MetaRepo = AsyncRepo<MetaStore>;

/** Accès aux dépôts, ouverts au premier besoin. */
export interface UserBackend {
  users(): UserRepo;
  skips(): SkipRepo;
  social(): SocialRepo;
  socialV2(): SocialV2Repo;
  socialV3(): SocialV3Repo;
  socialEvenings(): SocialEveningsRepo;
  admin(): AdminRepo;
  meta(): MetaRepo;
  /** Faux tant qu'aucune base n'existe (Node : fichier absent et jamais ouvert) : rien à lire, et lire n'en créerait pas. Absent = vrai. */
  hasData?(): boolean;
  /** Libère les ressources (fichier fermé). Sans effet pour un Durable Object ; idempotent. */
  close(): void;
}

/** Enveloppe un store synchrone : chaque méthode renvoie une Promise (une exception devient un rejet). */
export function asyncRepo<T extends object>(store: T): AsyncRepo<T> {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy({} as AsyncRepo<T>, {
    get(_target, name) {
      if (name === 'then') return undefined;
      let wrapped = cache.get(name);
      if (wrapped === undefined) {
        wrapped = (...args: unknown[]): Promise<unknown> => {
          try {
            const method = (store as Record<string | symbol, unknown>)[name];
            if (typeof method !== 'function') throw new TypeError(`méthode inconnue : ${String(name)}`);
            return Promise.resolve((method as (...a: unknown[]) => unknown).apply(store, args));
          } catch (err) {
            return Promise.reject(err);
          }
        };
        cache.set(name, wrapped);
      }
      return wrapped;
    },
    // (« then » reste indéfini : un dépôt n'est jamais « thenable », `await repo` ne l'appelle pas.)
  });
}
