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
  // Champs facultatifs (versions récentes de lastAddon) : absents des anciennes réponses.
  audio?: string[];
  channels?: string;
  bitrateMbps?: number;
  copies?: number;
  /** D'où vient la source : l'addon Stremio qui l'a renvoyée. */
  origins?: Array<{ kind: 'addon'; name: string; logo?: string }>;
  peers?: number;
  filename?: string;
  releaseGroup?: string;
  provider?: string;
  /** Langues dont la piste audio a été vérifiée (`true` : toutes celles annoncées). */
  verifiedLanguages?: Lang[] | true;
}

export interface Stream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: { filename?: string; videoSize?: number; bingeGroup?: string; notWebReady?: boolean; /** `client` : torrent sans lien, débridé sur l'appareil (lastAddon n'appelle jamais le débrideur). */ lastDebrid?: string };
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
  const audio = isStr(i.audio) ? [i.audio] : strList(i.audio) ? i.audio : null;
  if (audio && audio.length) out.audio = audio;
  if (isStr(i.channels) && i.channels) out.channels = i.channels;
  if (isNum(i.bitrateMbps)) out.bitrateMbps = i.bitrateMbps;
  if (isNum(i.copies) && i.copies > 0) out.copies = i.copies;
  if (Array.isArray(i.origins)) {
    const origins = i.origins.flatMap((o: unknown) => {
      const r = isRecord(o) ? o : null;
      if (!r || !isStr(r.name) || !r.name.trim()) return [];
      return [{ kind: 'addon' as const, name: r.name.trim(), ...(isStr(r.logo) && /^https?:\/\//i.test(r.logo) ? { logo: r.logo } : {}) }];
    });
    if (origins.length) out.origins = origins;
  }
  if (isNum(i.peers)) out.peers = i.peers;
  if (isStr(i.filename) && i.filename) out.filename = i.filename;
  if (isStr(i.releaseGroup) && i.releaseGroup) out.releaseGroup = i.releaseGroup;
  if (isStr(i.provider) && i.provider) out.provider = i.provider;
  const verified = i.languagesVerified ?? i.verifiedLanguages ?? i.verified;
  if (verified === true) out.verifiedLanguages = true;
  else if (strList(verified)) out.verifiedLanguages = verified.filter((l) => LANGS.includes(l)) as Lang[];
  return out;
}
