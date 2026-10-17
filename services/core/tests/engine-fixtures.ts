import { type Config, parseConfig } from '../src/config/schema.js';
import type { Ranked, Candidate } from '../src/engine/types.js';
import { RESOLUTION_RANK } from '../src/engine/types.js';
import type { ParsedRelease, RawStream } from '../src/types.js';

export const MB = 1024 ** 2;
export const GB = 1024 ** 3;

/** Fixture de ParsedRelease construite à la main (le moteur ne parse rien). */
export function parsed(overrides: Partial<ParsedRelease> = {}): ParsedRelease {
  return {
    resolution: '1080p',
    height: 1080,
    source: 'WEB-DL',
    codec: 'HEVC',
    hdr: [],
    audio: ['DDP'],
    channels: '5.1',
    languages: ['fr'],
    frVariant: 'VFF',
    multi: false,
    subsFr: false,
    ...overrides,
  };
}

export function raw(overrides: Partial<RawStream> = {}): RawStream {
  return {
    sourceName: 'Indexeur',
    sourceKind: 'torznab',
    title: 'Movie.2024.1080p.WEB-DL.DDP5.1.HEVC',
    ...overrides,
  };
}

export interface CandidateOptions {
  parsed?: Partial<ParsedRelease>;
  raw?: Partial<RawStream>;
  cached?: boolean;
}

export function cand(options: CandidateOptions = {}): Candidate {
  const candidate: Candidate = { raw: raw(options.raw), parsed: parsed(options.parsed) };
  if (options.cached !== undefined) candidate.cached = options.cached;
  return candidate;
}

export function ranked(candidate: Candidate, score = 0): Ranked {
  return { ...candidate, score, tier: RESOLUTION_RANK[candidate.parsed.resolution] };
}

/** Configuration validée par le schéma (applique les défauts). */
export function cfg(input: Record<string, unknown> = {}): Config {
  return parseConfig(input);
}

/** Titres des candidats, pratique pour vérifier l'ordre et le contenu. */
export function titles(cands: readonly Candidate[]): (string | undefined)[] {
  return cands.map((c) => c.raw.title);
}
