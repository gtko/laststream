import type { Config } from '../config/schema.js';
import type { ContentRef, RawStream } from '../types.js';
import { SourceError, type HttpOptions } from './http.js';
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

/**
 * Interroge toutes les sources de la configuration en parallèle.
 * Une source en échec n'empêche pas les autres : son erreur est listée dans `errors`.
 * Les streams sont renvoyés dans l'ordre des sources de la configuration.
 */
export async function collectStreams(
  config: Config,
  ref: ContentRef,
  opts: HttpOptions = {},
): Promise<CollectResult> {
  const runs = config.sources.map((source) =>
    source.type === 'upstream' ? fetchUpstream(source, ref, opts) : searchTorznab(source, ref, opts),
  );
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
  return { streams, errors };
}
