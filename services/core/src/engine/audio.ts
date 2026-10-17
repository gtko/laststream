import type { Multichannel, UnsupportedFormat } from '../config/schema.js';
import { type Candidate, rawNameTexts } from './types.js';

/**
 * Motifs de détection dans les noms, pour les formats que le parseur ne relève pas toujours
 * (les noms de release restent la source de vérité quand parsed.audio est vide).
 */
const NAME_PATTERNS: Record<UnsupportedFormat, RegExp> = {
  'DTS-HD': /(?<![\p{L}\p{N}])DTS[-. ]?HD(?![\p{L}\p{N}])/iu,
  TrueHD: /(?<![\p{L}\p{N}])TRUE[-. ]?HD(?![\p{L}\p{N}])/iu,
  EAC3: /(?<![\p{L}\p{N}])(?:E[-. ]?AC[-. ]?3|DDP|DD\+)(?!\p{L})/iu,
  Atmos: /(?<![\p{L}\p{N}])ATMOS(?![\p{L}\p{N}])/iu,
};

/**
 * Formats audio détectés dans un candidat : parsed.audio (DTS-HD, TrueHD, DDP = E-AC-3, Atmos) et noms bruts.
 */
export function detectedAudioFormats(c: Candidate): Set<UnsupportedFormat> {
  const found = new Set<UnsupportedFormat>();
  const audio = c.parsed.audio;
  const names = rawNameTexts(c);
  const inNames = (pattern: RegExp): boolean => names.some((text) => pattern.test(text));

  if (audio.some((track) => track.startsWith('DTS-HD')) || inNames(NAME_PATTERNS['DTS-HD'])) found.add('DTS-HD');
  if (audio.includes('TrueHD') || inNames(NAME_PATTERNS.TrueHD)) found.add('TrueHD');
  if (audio.includes('DDP') || inNames(NAME_PATTERNS.EAC3)) found.add('EAC3');
  if (audio.includes('Atmos') || inNames(NAME_PATTERNS.Atmos)) found.add('Atmos');
  return found;
}

/** Rang de canaux : 2 = 7.1, 1 = 5.1, 0 = autre ou inconnu. */
export function channelRank(c: Candidate): number {
  if (c.parsed.channels === '7.1') return 2;
  if (c.parsed.channels === '5.1') return 1;
  return 0;
}

/** Rang de canaux visé par un réglage multicanal (5.1 ou 7.1), undefined si aucune préférence ni exigence. */
export function channelTarget(mode: Multichannel): number | undefined {
  switch (mode) {
    case 'prefer5_1':
    case 'require5_1':
      return 1;
    case 'prefer7_1':
    case 'require7_1':
      return 2;
    case 'none':
      return undefined;
  }
}
