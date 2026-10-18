/** Préfixes (espaces de noms) des caches KV partagés : seuls ceux-là sont comptés et purgeables. */
export const CACHE_PREFIXES = ['issued', 'packs', 'hosts', 'torrents', 'alldebrid'] as const;
export type CachePrefix = (typeof CACHE_PREFIXES)[number];
export const isCachePrefix = (value: unknown): value is CachePrefix => (CACHE_PREFIXES as readonly unknown[]).includes(value);

export interface CacheStat {
  prefix: string;
  /** Nombre de clés comptées (borné : voir `exact`). */
  keys: number;
  /** Faux si le comptage s'est arrêté à la borne (au moins `keys` clés). */
  exact: boolean;
}

export type PurgeStatus = 'running' | 'done' | 'failed';

export interface PurgeJob {
  id: string;
  prefix: string;
  status: PurgeStatus;
  /** Suppressions envoyées au KV. */
  deleted: number;
  startedAt: string;
  updatedAt: string;
  /** Code d'erreur (jamais de clé ni de valeur). */
  error: string | null;
}

/** Administration des caches partagés (Workers : KV + Durable Object Metrics pour la purge asynchrone). */
export interface CacheAdmin {
  stats(): Promise<CacheStat[]>;
  /** Démarre une purge par lots, asynchrone ; une purge déjà en cours pour ce préfixe est renvoyée telle quelle. */
  startPurge(prefix: CachePrefix): Promise<PurgeJob>;
  purgeJob(id: string): Promise<PurgeJob | undefined>;
  purgeJobs(): Promise<PurgeJob[]>;
}

/** TV : relance de la collecte (cron) par l'API TV ; absente tant qu'elle n'est pas déployée (réponse 501). */
export interface TvAdmin {
  /** Date ISO du dernier cron TV, ou null. */
  lastCron(): Promise<string | null>;
  /** Relance la collecte. */
  rerun(): Promise<unknown>;
}
