import type { Config } from '../config/schema.js';
import type { StremioStream } from '../types.js';
import { dedupe } from './dedupe.js';
import { filterCandidates } from './filter.js';
import { formatStreams } from './format.js';
import { rankCandidates } from './score.js';
import type { Candidate } from './types.js';

export * from './cinemeta.js';
export * from './dedupe.js';
export * from './filter.js';
export * from './format.js';
export * from './score.js';
export * from './types.js';

/** Pipeline du moteur : filtre, déduplication, classement, formatage. Pur, sans I/O. */
export function runEngine(
  cands: Candidate[],
  config: Config,
  fmt: Omit<Parameters<typeof formatStreams>[1], 'maxResults'>,
): StremioStream[] {
  const filtered = filterCandidates(cands, config);
  const unique = dedupe(filtered);
  const ranked = rankCandidates(unique, config);
  return formatStreams(ranked, { ...fmt, maxResults: config.maxResults });
}
