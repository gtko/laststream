import type { Config } from '../config/schema.js';
import type { ContentRef, RawStream } from '../types.js';
import { searchJackett } from './jackett.js';
import { SourceError, type HttpOptions } from './http.js';
import type { TitleInfo } from './indexers.js';
import { searchProwlarr } from './prowlarr.js';
import { fetchUpstream } from './upstream.js';
import { searchTorznab } from './torznab.js';
import type { TitleVariants } from './query-titles.js';

/** Erreur isolée d'une source : son nom et un message sûr (sans URL ni clé). */
export interface SourceErrorEntry {
  source: string;
  error: string;
}

export interface CollectResult {
  streams: RawStream[];
  errors: SourceErrorEntry[];
}

/** Options de collecte : fetch injectable, titre pour la recherche texte Prowlarr, budget Prowlarr. */
export interface CollectOptions extends HttpOptions {
  titleInfo?: TitleInfo;
  /** Titres et année (getTitleVariants) : requêtes texte Prowlarr, Jackett et Torznab. Prime sur titleInfo. */
  titles?: TitleVariants;
  budgetMs?: number;
  /** Numéro absolu de l'épisode (anime, remappage) : requêtes « Titre 05 » et « Titre - 05 » côté Prowlarr. */
  absolute?: number;
}

type SourceConfig = Config['sources'][number];

/** Marge entre le budget interne d'une source et la limite externe de la collecte, en millisecondes. */
const SOURCE_MARGIN_MS = 500;

function searchSource(source: SourceConfig, ref: ContentRef, opts: CollectOptions): Promise<RawStream[]> {
  switch (source.type) {
    case 'upstream':
      return fetchUpstream(source, ref, opts);
    case 'torznab':
      return searchTorznab(source, ref, opts);
    case 'prowlarr':
      return searchProwlarr(source, ref, opts);
    case 'jackett':
      return searchJackett(source, ref, opts);
  }
}

/**
 * Fusionne les copies d'un même infoHash venues de plusieurs indexeurs (flux portant `indexers`).
 * Garde la première occurrence, à sa place ; `indexers` reçoit l'union des noms, dans l'ordre d'arrivée.
 * Les flux sans indexers ou sans infoHash ne sont pas touchés.
 */
export function mergeIndexerCopies(streams: RawStream[]): RawStream[] {
  const firstByHash = new Map<string, RawStream>();
  const merged: RawStream[] = [];
  for (const stream of streams) {
    const hash = stream.indexers !== undefined && stream.infoHash !== undefined ? stream.infoHash.toLowerCase() : undefined;
    if (hash === undefined || stream.indexers === undefined) {
      merged.push(stream);
      continue;
    }
    const first = firstByHash.get(hash);
    if (first === undefined) {
      const copy: RawStream = { ...stream, indexers: [...new Set(stream.indexers)] };
      firstByHash.set(hash, copy);
      merged.push(copy);
      continue;
    }
    first.indexers = [...new Set([...(first.indexers ?? []), ...stream.indexers])];
  }
  return merged;
}

/**
 * Résultat d'une source au plus tard après `budgetMs` : au-delà, erreur sûre « délai dépassé » (sans URL). Sans budget,
 * le résultat est renvoyé tel quel. La source n'est pas annulée : son résultat tardif est ignoré.
 */
function bounded(work: Promise<RawStream[]>, name: string, budgetMs: number | undefined): Promise<RawStream[]> {
  if (budgetMs === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SourceError(`Source "${name}" : délai dépassé (${budgetMs} ms)`)), budgetMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Interroge toutes les sources de la configuration en parallèle.
 * Une source en échec n'empêche pas les autres : son erreur est listée dans `errors`.
 * Les streams sont renvoyés dans l'ordre des sources de la configuration, copies d'indexeurs fusionnées par infoHash.
 */
export async function collectStreams(config: Config, ref: ContentRef, opts: CollectOptions = {}): Promise<CollectResult> {
  // Chaque source borne sa propre recherche un peu avant le budget de la collecte : elle rend ses résultats partiels
  // à temps, au lieu d'être coupée par la limite externe (qui ne garde rien de la source).
  const inner: CollectOptions =
    opts.budgetMs === undefined ? opts : { ...opts, budgetMs: Math.max(0, opts.budgetMs - SOURCE_MARGIN_MS) };
  const runs = config.sources.map((source) => bounded(searchSource(source, ref, inner), source.name, opts.budgetMs));
  const settled = await Promise.allSettled(runs);

  const streams: RawStream[] = [];
  const errors: SourceErrorEntry[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      streams.push(...result.value);
      return;
    }
    const source = config.sources[index]?.name ?? 'inconnue';
    const error =
      result.reason instanceof SourceError ? result.reason.message : `Source "${source}" : erreur inattendue`;
    errors.push({ source, error });
  });
  return { streams: mergeIndexerCopies(streams), errors };
}
