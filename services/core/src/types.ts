export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'SD' | 'unknown';
export type SourceKind = 'REMUX' | 'BluRay' | 'WEB-DL' | 'WEBRip' | 'HDTV' | 'DVDRip' | 'CAM' | 'TS' | 'SCR' | 'unknown';
export type Codec = 'HEVC' | 'AVC' | 'AV1' | 'unknown';
export type Hdr = 'HDR10' | 'HDR10+' | 'DV' | 'HLG';
export type Lang = 'fr' | 'en' | 'es' | 'de' | 'it' | 'multi' | 'original';
export type FrVariant = 'VFF' | 'VFQ' | 'VF2' | 'TRUEFRENCH' | 'FRENCH' | 'VOSTFR' | 'SUBFRENCH';

export interface ParsedRelease {
  resolution: Resolution;
  height: number;
  source: SourceKind;
  codec: Codec;
  hdr: Hdr[];
  audio: string[];
  channels?: string;
  languages: Lang[];
  frVariant?: FrVariant;
  multi: boolean;
  subsFr: boolean;
  group?: string;
  sizeBytes?: number;
  seeders?: number;
  infoHash?: string;
  fileIdx?: number;
  title?: string;
}

export interface RawStream {
  sourceName: string;
  sourceKind: 'upstream' | 'torznab';
  title?: string;
  name?: string;
  description?: string;
  filename?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sizeBytes?: number;
  seeders?: number;
  magnet?: string;
  behaviorHints?: Record<string, unknown>;
  sources?: string[];
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  behaviorHints?: Record<string, unknown>;
  laststream?: Record<string, unknown>;
}

export interface ContentRef {
  type: 'movie' | 'series';
  id: string;
  imdbId: string;
  season?: number;
  episode?: number;
}
