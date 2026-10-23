import type { Codec, Hdr, Resolution, SourceKind } from '../types.js';

/** Informations techniques extraites d'un nom de release, d'un nom de fichier ou d'une description. */
export interface VideoInfo {
  resolution: Resolution;
  height: number;
  source: SourceKind;
  codec: Codec;
  hdr: Hdr[];
  audio: string[];
  channels?: string;
  group?: string;
  tags: string[];
}

/** Caractère provisoire qui protège le point décimal des canaux (5.1, 7.1, 2.0). */
const DECIMAL_DOT = '';
const CHANNEL_SUFFIX = '(?:[. ]?\\d\\.\\d)?';
const MEDIA_EXTENSION = /\.(?:mkv|mp4|avi|m4v|wmv|mov|webm|iso)$/i;
/** Suffixes techniques qui ressemblent à un groupe (WEB-DL, Blu-ray, DTS-HD...). */
const NON_GROUP_SUFFIXES = new Set([
  'DL', 'RIP', 'RAY', 'HD', 'MA', 'UHD', 'BD', 'BR', 'SD', 'TV', 'WEB', 'DVD',
  'X264', 'X265', 'H264', 'H265', 'HEVC', 'AVC', 'AV1',
]);
const TECHNICAL_BRACKET =
  /^(?:\d{3,4}[pi]|2560x1440|4K|2K|QHD|UHD|FHD|HD|SD|x26[45]|HEVC|AVC|AV1|WEB(?:[- ]?DL|[- ]?RIP)?|BLU[- ]?RAY|BD|DVD(?:[- ]?RIP)?|HDR\S*|MULTI|VOSTFR|VF[FQ2]?|TRUEFRENCH|FRENCH|SUBFRENCH)$/i;

/**
 * Regex de token : le motif doit être isolé par des espaces ou par les bords du texte normalisé.
 * `caseSensitive` sert aux mots ambigus en minuscules (TS, CAM, SCR, HC, DV, SD).
 */
function tok(pattern: string, caseSensitive = false): RegExp {
  return new RegExp(`(?:^| )(?:${pattern})(?= |$)`, caseSensitive ? '' : 'i');
}

const RE_RES_2160 = tok('2160[pi]|4K|UHD');
const RE_RES_1440 = tok('1440[pi]|2560x1440');
/** « 2K » / « QHD » : ambigus (« 2K Remaster 1080p »), retenus seulement quand aucune autre résolution n'est annoncée. */
const RE_RES_1440_LOOSE = tok('QHD|2K');
const RE_RES_1080 = tok('1080[pi]|FHD');
const RE_RES_720 = tok('720[pi]');
const RE_RES_480 = tok('480[pi]');
const RE_RES_576 = tok('576[pi]');
const RE_SD_CAPS = tok('SD', true);
const RE_SD_LABEL = tok('SDTV|DVD[- ]?RIP');

/** Ordre de priorité des sources : le premier motif trouvé gagne. */
const SOURCE_RULES: Array<[SourceKind, RegExp]> = [
  ['REMUX', tok('(?:BD)?REMUX')],
  ['BluRay', tok('BLU[- ]?RAY|BD[- ]?RIP|BR[- ]?RIP')],
  ['WEB-DL', tok('WEB[- ]?DL|WEBDL')],
  ['WEBRip', tok('WEB[- ]?RIP')],
  ['WEB-DL', tok('WEB', true)],
  ['HDTV', tok('HDTV(?:[- ]?RIP)?')],
  ['DVDRip', tok('DVD[- ]?RIP')],
];

const CODEC_RULES: Array<[Codec, RegExp]> = [
  ['HEVC', tok('HEVC|X265|H ?265')],
  ['AV1', tok('AV1')],
  ['AVC', tok('AVC|X264|H ?264')],
];

const RE_HDR10_PLUS = tok('HDR10 ?(?:\\+|PLUS)');
const RE_HDR10 = tok('HDR10|HDR');
const RE_DV = tok('DV', true);
const RE_DV_LONG = tok('DOVI|DOLBY ?VISION');
const RE_HLG = tok('HLG');

const RE_DTS_HD_MA = tok('DTS[- ]?HD[- ]?MA');
const RE_DTS_HD = tok('DTS[- ]?HD');
const RE_DTS = tok('DTS');
/** Pistes audio après DTS, dans l'ordre de qualité de la liste. */
const AUDIO_RULES: Array<[string, RegExp]> = [
  ['TrueHD', tok('TRUE[- ]?HD')],
  ['Atmos', tok('ATMOS')],
  ['DDP', tok(`DDP${CHANNEL_SUFFIX}|DD\\+${CHANNEL_SUFFIX}|E[- ]?AC[- ]?3${CHANNEL_SUFFIX}`)],
  ['AC3', tok(`AC[- ]?3${CHANNEL_SUFFIX}|DD${CHANNEL_SUFFIX}`)],
  ['AAC', tok(`AAC${CHANNEL_SUFFIX}`)],
  ['FLAC', tok('FLAC')],
  ['Opus', tok('OPUS')],
];

const CHANNEL_RULES: Array<[string, RegExp]> = [
  ['7.1', /(?<!\d)7\.1(?!\d)/],
  ['5.1', /(?<!\d)5\.1(?!\d)/],
  ['2.0', /(?<!\d)2\.0(?!\d)/],
];

interface TagRule {
  tag: string;
  family?: 'CAM' | 'TS' | 'SCR';
  re: RegExp;
}

/** Tags notables. Les familles CAM/TS/SCR sont aussi ajoutées, pour le filtrage excludedTags. */
const TAG_RULES: TagRule[] = [
  { tag: 'CAM', family: 'CAM', re: tok('CAM', true) },
  { tag: 'HDCAM', family: 'CAM', re: tok('HD[- ]?CAM') },
  { tag: 'TS', family: 'TS', re: tok('TS', true) },
  { tag: 'HDTS', family: 'TS', re: tok('HD[- ]?TS') },
  { tag: 'TELESYNC', family: 'TS', re: tok('TELE[- ]?SYNC') },
  { tag: 'PDVD', family: 'TS', re: tok('PDVD') },
  { tag: 'SCR', family: 'SCR', re: tok('SCR', true) },
  { tag: 'DVDSCR', family: 'SCR', re: tok('DVD[- ]?SCR') },
  { tag: 'SCREENER', family: 'SCR', re: tok('SCREENER') },
  { tag: 'REPACK', re: tok('REPACK') },
  { tag: 'PROPER', re: tok('PROPER') },
  { tag: 'RERIP', re: tok('RERIP') },
  { tag: 'EXTENDED', re: tok('EXTENDED') },
  { tag: 'UNRATED', re: tok('UNRATED') },
  { tag: 'REMASTERED', re: tok('REMASTERED') },
  { tag: 'IMAX', re: tok('IMAX') },
  { tag: 'HC', re: tok('HC', true) },
  { tag: '3D', re: tok('3D') },
  { tag: 'INTERNAL', re: tok('INTERNAL') },
];

/** Retire l'extension de fichier. Un `.ts` en minuscules est une extension, un `TS` en majuscules est un tag. */
function stripExtension(text: string): string {
  return text.trim().replace(MEDIA_EXTENSION, '').replace(/\.ts$/, '').trim();
}

function isTechnicalBracket(content: string): boolean {
  return TECHNICAL_BRACKET.test(content.trim());
}

interface SplitName {
  /** Nom sans le groupe de release ni le groupe en tête. */
  core: string;
  group?: string;
}

/** Sépare le groupe (`-GROUPE` en fin de nom, sinon `[Groupe]` en tête) du reste du nom. */
function splitName(name: string): SplitName {
  const trailing = /(?<=[A-Za-z0-9])-([A-Za-z0-9]{2,20})$/.exec(name);
  if (trailing) {
    const prefix = name.slice(0, trailing.index);
    const candidate = trailing[1];
    if (!NON_GROUP_SUFFIXES.has(candidate.toUpperCase())) {
      return { core: prefix, group: candidate };
    }
    // Suffixe technique (WEB-DL, Blu-ray...) : on garde le mot, sans le tiret.
    return { core: `${prefix} ${candidate}` };
  }
  const bracket = /^\[([^\]]{2,30})\]\s*/.exec(name);
  if (bracket && !isTechnicalBracket(bracket[1])) {
    const group = bracket[1].trim();
    return { core: name.slice(bracket[0].length), group: group || undefined };
  }
  return { core: name };
}

/**
 * Normalise : les séparateurs (. _ espaces, crochets...) deviennent des espaces.
 * Les tirets (WEB-DL, DTS-HD) et le + (HDR10+, DD+) sont conservés, ainsi que le point des canaux (5.1).
 */
function normalize(core: string): string {
  return core
    .replace(/\bH\.(?=26[45]\b)/gi, 'H')
    .replace(/(?<=(?<!\d)\d)\.(?=\d(?!\d))/g, DECIMAL_DOT)
    .replace(/[^-\p{L}\p{N}+]+/gu, ' ')
    .replace(//g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectResolution(norm: string): { resolution: Resolution; height: number } {
  if (RE_RES_2160.test(norm)) return { resolution: '2160p', height: 2160 };
  if (RE_RES_1440.test(norm)) return { resolution: '1440p', height: 1440 };
  if (RE_RES_1080.test(norm)) return { resolution: '1080p', height: 1080 };
  if (RE_RES_720.test(norm)) return { resolution: '720p', height: 720 };
  if (RE_RES_480.test(norm)) return { resolution: '480p', height: 480 };
  if (RE_RES_576.test(norm)) return { resolution: 'SD', height: 576 };
  if (RE_SD_CAPS.test(norm) || RE_SD_LABEL.test(norm)) return { resolution: 'SD', height: 480 };
  if (RE_RES_1440_LOOSE.test(norm)) return { resolution: '1440p', height: 1440 };
  return { resolution: 'unknown', height: 0 };
}

function detectTags(norm: string): { tags: string[]; families: Set<string> } {
  const tags: string[] = [];
  const families = new Set<string>();
  const push = (value: string): void => {
    if (!tags.includes(value)) tags.push(value);
  };
  for (const rule of TAG_RULES) {
    if (!rule.re.test(norm)) continue;
    push(rule.tag);
    if (rule.family) {
      families.add(rule.family);
      push(rule.family);
    }
  }
  return { tags, families };
}

function detectSource(norm: string, families: ReadonlySet<string>): SourceKind {
  const rule = SOURCE_RULES.find(([, re]) => re.test(norm));
  if (rule) return rule[0];
  // CAM, TS et SCR n'ont pas de marqueur de source propre : on prend la famille du tag.
  for (const family of ['CAM', 'TS', 'SCR'] as const) {
    if (families.has(family)) return family;
  }
  return 'unknown';
}

function detectCodec(norm: string): Codec {
  const rule = CODEC_RULES.find(([, re]) => re.test(norm));
  return rule ? rule[0] : 'unknown';
}

function detectHdr(norm: string): Hdr[] {
  const hdr: Hdr[] = [];
  if (RE_HDR10_PLUS.test(norm)) hdr.push('HDR10+');
  else if (RE_HDR10.test(norm)) hdr.push('HDR10');
  if (RE_DV.test(norm) || RE_DV_LONG.test(norm)) hdr.push('DV');
  if (RE_HLG.test(norm)) hdr.push('HLG');
  return hdr;
}

function detectAudio(norm: string): string[] {
  const audio: string[] = [];
  // DTS-HD MA inclut le DTS de base : une seule entrée par famille DTS.
  if (RE_DTS_HD_MA.test(norm)) audio.push('DTS-HD MA');
  else if (RE_DTS_HD.test(norm)) audio.push('DTS-HD');
  else if (RE_DTS.test(norm)) audio.push('DTS');
  for (const [name, re] of AUDIO_RULES) {
    if (re.test(norm)) audio.push(name);
  }
  return audio;
}

function detectChannels(norm: string): string | undefined {
  const rule = CHANNEL_RULES.find(([, re]) => re.test(norm));
  return rule ? rule[0] : undefined;
}

/**
 * Analyse un nom de release (ou une description) : résolution, source, codec, HDR, audio, canaux,
 * groupe et tags. Les champs non détectés valent `unknown`, `[]` ou sont absents.
 */
export function parseVideo(text: string): VideoInfo {
  const { core, group } = splitName(stripExtension(text));
  const norm = normalize(core);
  const { tags, families } = detectTags(norm);
  const { resolution, height } = detectResolution(norm);

  const info: VideoInfo = {
    resolution,
    height,
    source: detectSource(norm, families),
    codec: detectCodec(norm),
    hdr: detectHdr(norm),
    audio: detectAudio(norm),
    tags,
  };
  const channels = detectChannels(norm);
  if (channels) info.channels = channels;
  if (group) info.group = group;
  return info;
}
