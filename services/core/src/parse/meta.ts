/** Unités de taille : `K`, `M`, `G`, `T` suivis de `B`, `iB` ou `o`/`O` (Ko, Mo, Go...). Sensible à la casse. */
const SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*([KMGT])(?:iB|B|o|O)(?![A-Za-z])/g;
/** Taille brute en octets : nombre seul, éventuellement précédé de l'icône 💾 ou de `size:`. */
const RAW_BYTES = /^(?:\u{1F4BE}\s*|size\s*[:=]?\s*)?(\d+)$/iu;
const RAW_BYTES_MIN = 1000;

function unitFactor(letter: string): number {
  switch (letter) {
    case 'K':
      return 1024;
    case 'M':
      return 1024 ** 2;
    case 'G':
      return 1024 ** 3;
    case 'T':
      return 1024 ** 4;
    default:
      return 0;
  }
}

/**
 * Extrait une taille en octets. Base 1024 pour toutes les unités (GB = GiB = Go).
 * Un nombre seul (ex. "123456789") est lu comme des octets s'il vaut au moins 1000 et que le texte ne contient que lui.
 */
export function parseSize(text: string): number | undefined {
  const trimmed = text.trim();
  const raw = RAW_BYTES.exec(trimmed);
  if (raw) {
    const bytes = Number(raw[1]);
    return bytes >= RAW_BYTES_MIN ? bytes : undefined;
  }
  for (const match of text.matchAll(SIZE_PATTERN)) {
    const value = Number(match[1].replace(',', '.'));
    const factor = unitFactor(match[2]);
    if (factor > 0 && value > 0) return Math.round(value * factor);
  }
  return undefined;
}

/** Motifs de seeders, par ordre de priorité. Le groupe capturé est le nombre. */
const SEEDER_PATTERNS: RegExp[] = [
  /\u{1F464}️?\s*(\d+)/u,
  /\u{1F465}️?\s*(\d+)/u,
  /\bseed(?:s|ers?)?\s*[:=]?\s*(\d+)/i,
  /(?<![A-Za-z])S\s*:\s*(\d+)/,
];

/** Extrait le nombre de seeders (👤 12, 👥 8, "Seeders: 45", "seeds 7", "S: 12"). */
export function parseSeeders(text: string): number | undefined {
  for (const pattern of SEEDER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return undefined;
}

const HEX_HASH = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_HASH = /^[a-z2-7]{32}$/i;
const HEX_40 = /^[0-9a-f]{40}$/i;

/** Convertit 32 caractères base32 (160 bits) en 40 caractères hexadécimaux. */
function base32ToHex(value: string): string {
  let bits = 0;
  let buffer = 0;
  let hex = '';
  for (const char of value.toUpperCase()) {
    buffer = ((buffer << 5) | BASE32_ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((buffer >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/**
 * Extrait l'info-hash en hexadécimal minuscule (40 car.).
 * Cherche d'abord `btih:` (magnet, hex ou base32), puis un hash hexadécimal isolé.
 */
export function extractInfoHash(text: string): string | undefined {
  const magnet = /btih:([a-z0-9]+)/i.exec(text);
  if (magnet) {
    const value = magnet[1];
    if (HEX_40.test(value)) return value.toLowerCase();
    if (BASE32_HASH.test(value)) return base32ToHex(value);
  }
  const hex = HEX_HASH.exec(text);
  return hex ? hex[0].toLowerCase() : undefined;
}

export interface EpisodeInfo {
  season?: number;
  episode?: number;
}

function episodeInfo(season: string | undefined, episode: string | undefined): EpisodeInfo {
  const info: EpisodeInfo = {};
  if (season !== undefined) info.season = Number(season);
  if (episode !== undefined) info.episode = Number(episode);
  return info;
}

/**
 * Extrait saison et épisode : S01E02, 1x02, "Saison 1 Episode 2" / "Season 1 Episode 2",
 * puis formes partielles (épisode seul, saison seule : "Episode 7", "S03").
 */
export function parseEpisode(text: string): EpisodeInfo {
  const sxe = /(?<![A-Za-z0-9])S(\d{1,3})[ ._-]?E(\d{1,4})(?!\d)/i.exec(text);
  if (sxe) return episodeInfo(sxe[1], sxe[2]);

  const nxm = /(?<![\dA-Za-z])(\d{1,2})x(\d{2,3})(?![\dA-Za-z])/i.exec(text);
  if (nxm) return episodeInfo(nxm[1], nxm[2]);

  const wordBoth = /(?:saison|season)\s*(\d{1,3})[^0-9]{0,10}?(?:[éÉ]pisode|episode|ep)\.?\s*(\d{1,4})/i.exec(text);
  if (wordBoth) return episodeInfo(wordBoth[1], wordBoth[2]);

  const episodeOnly = /(?:[éÉ]pisode|episode|\bep\.?)\s*(\d{1,4})/i.exec(text);
  if (episodeOnly) return episodeInfo(undefined, episodeOnly[1]);

  const seasonOnly = /(?:saison|season)\s*(\d{1,3})(?![0-9])|(?<![A-Za-z0-9])S(\d{1,3})(?![0-9])/i.exec(text);
  if (seasonOnly) return episodeInfo(seasonOnly[1] ?? seasonOnly[2], undefined);

  return {};
}
