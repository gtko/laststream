import type { Config } from '../config/schema.js';
import type { ContentRef, RawStream } from '../types.js';
import { searchJackett } from './jackett.js';
import { SourceError, type HttpOptions } from './http.js';
import type { TitleInfo } from './indexers.js';
import { searchProwlarr } from './prowlarr.js';
import { fetchUpstream } from './upstream.js';
import { searchTorznab } from './torznab.js';

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
  budgetMs?: number;
}

type SourceConfig = Config['sources'][number];

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
 * Interroge toutes les sources de la configuration en parallèle.
 * Une source en échec n'empêche pas les autres : son erreur est listée dans `errors`.
 * Les streams sont renvoyés dans l'ordre des sources de la configuration, copies d'indexeurs fusionnées par infoHash.
 */
export async function collectStreams(config: Config, ref: ContentRef, opts: CollectOptions = {}): Promise<CollectResult> {
  const runs = config.sources.map((source) => searchSource(source, ref, opts));
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
