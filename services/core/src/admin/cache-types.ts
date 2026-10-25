import type { MetaKind } from '../lt/meta-policy.js';

/** Préfixes (espaces de noms) des caches KV partagés : seuls ceux-là sont comptés et purgeables. */
export const CACHE_PREFIXES = ['issued', 'packs', 'hosts', 'torrents', 'tmdb', 'mdb', 'tvdb'] as const;
export type CachePrefix = (typeof CACHE_PREFIXES)[number];
export const isCachePrefix = (value: unknown): value is CachePrefix => (CACHE_PREFIXES as readonly unknown[]).includes(value);

export interface CacheStat {
  prefix: string;
  /** Nombre de clés comptées (borné : voir `exact`). */
  keys: number;
  /** Faux si le comptage s'est arrêté à la borne (au moins `keys` clés). */
  exact: boolean;
}

type PurgeStatus = 'running' | 'done' | 'failed';

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

/** Dernier passage du cron TV (catalogue et EPG reconstruits dans R2). Aucune donnée de chaîne ni d'URL. */
export interface TvCronState {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Catalogue reconstruit ; faux : l'ancien catalogue reste servi. */
  ok: boolean;
  channels: number | null;
  programmes: number | null;
  /** EPG reconstruit ; faux : l'ancien EPG reste servi. */
  epgOk: boolean;
  /** Code d'erreur (jamais de message brut). */
  error: string | null;
}

/** TV : état du dernier cron et relance de la collecte. Absente hors Workers (réponse 501). */
export interface TvAdmin {
  /** Dernier passage enregistré, ou null (aucun passage depuis le déploiement). */
  lastCron(): Promise<TvCronState | null>;
  /** Relance la collecte en arrière-plan. */
  rerun(): Promise<unknown>;
}

/** Fiches partagées (R2) : suppression des couches d'une fiche. Absente hors Workers (réponse 501). */
export interface MetaAdmin {
  /** Supprime tous les objets de la fiche (préfixe de fichePrefix) ; renvoie leur nombre. Une fiche absente : 0. */
  deleteFiche(kind: MetaKind, tmdbId: number): Promise<number>;
}
