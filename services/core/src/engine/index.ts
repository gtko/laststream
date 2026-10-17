import type { Config } from '../config/schema.js';
import type { StremioStream } from '../types.js';
import { dedupe } from './dedupe.js';
import { filterCandidates, limitPerResolution } from './filter.js';
import { type FormatOptions, formatStreams } from './format.js';
import { rankCandidates } from './score.js';
import type { Candidate, ContentMeta } from './types.js';

export * from './cinemeta.js';
export * from './dedupe.js';
export * from './filter.js';
export * from './format.js';
export * from './score.js';
export * from './tmdb-meta.js';
export * from './types.js';

/**
 * Pipeline du moteur : filtre, déduplication, classement, limite par résolution, formatage. Pur, sans I/O.
 * Le gabarit par défaut est celui de la configuration (`display.template`).
 */
export function runEngine(
  cands: Candidate[],
  config: Config,
  fmt: Omit<FormatOptions, 'maxResults'>,
  meta?: ContentMeta,
): StremioStream[] {
  const filtered = filterCandidates(cands, config, meta);
  const unique = dedupe(filtered);
  const ranked = limitPerResolution(rankCandidates(unique, config, meta), config);
  return formatStreams(ranked, { template: config.display.template, ...fmt, maxResults: config.maxResults });
}
