/** Objet `laststream` joint à chaque stream par lastAddon (voir lastaddon/src/engine/format.ts). */
export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'SD' | 'unknown';
export type Lang = 'fr' | 'en' | 'es' | 'de' | 'it' | 'multi' | 'original';

export interface LastStreamInfo {
  resolution: Resolution;
  height: number;
  source: string;
  codec: string;
  hdr: string[];
  languages: Lang[];
  frVariant?: string;
  sizeBytes?: number;
  cached: boolean;
  seeders?: number;
  score: number;
  estBitrateKbps: number | null;
  languageFallback?: boolean;
}

export interface Stream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { filename?: string; videoSize?: number; bingeGroup?: string; notWebReady?: boolean };
  laststream?: unknown;
  [key: string]: unknown;
}

const RESOLUTIONS = ['2160p', '1080p', '720p', '480p', 'SD', 'unknown'];
const LANGS = ['fr', 'en', 'es', 'de', 'it', 'multi', 'original'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Lit l'objet `laststream` d'un stream. Null si absent ou mal formé ; le résultat ne contient que les champs connus. */
export function getLaststream(stream: unknown): LastStreamInfo | null {
  if (!isRecord(stream) || !isRecord(stream.laststream)) return null;
  const i = stream.laststream;
  if (
    !isStr(i.resolution) || !RESOLUTIONS.includes(i.resolution) ||
    !isNum(i.height) || !isStr(i.source) || !isStr(i.codec) ||
    !strList(i.hdr) || !strList(i.languages) || !i.languages.every((l) => LANGS.includes(l)) ||
    typeof i.cached !== 'boolean' || !isNum(i.score) ||
    !(i.estBitrateKbps === null || isNum(i.estBitrateKbps))
  ) {
    return null;
  }
  const out: LastStreamInfo = {
    resolution: i.resolution as Resolution,
    height: i.height,
    source: i.source,
    codec: i.codec,
    hdr: i.hdr,
    languages: i.languages as Lang[],
    cached: i.cached,
    score: i.score,
    estBitrateKbps: i.estBitrateKbps as number | null,
  };
  if (isStr(i.frVariant)) out.frVariant = i.frVariant;
  if (isNum(i.sizeBytes)) out.sizeBytes = i.sizeBytes;
  if (isNum(i.seeders)) out.seeders = i.seeders;
  if (typeof i.languageFallback === 'boolean') out.languageFallback = i.languageFallback;
  return out;
}
