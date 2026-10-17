import type { ParsedRelease, Resolution, StremioStream } from '../types.js';
import { fileIdxOf, infoHashOf, type Ranked, seedersOf, sizeOf } from './types.js';

export interface FormatOptions {
  /** Base publique du endpoint de lecture (ex. https://addon.example.com). */
  playBaseUrl: string;
  configToken: string;
  runtimeSeconds?: number;
  maxResults: number;
  /** Vrai si le débrideur est configuré : les infoHash passent alors par /play. */
  hasDebrid: boolean;
  season?: number;
  episode?: number;
}

/** Cible de livraison d'un stream : URL amont, lecture débridée, ou P2P (infoHash). */
type Target =
  | { kind: 'direct'; url: string }
  | { kind: 'debrid'; infoHash: string; fileIdx: number | undefined }
  | { kind: 'p2p'; infoHash: string; fileIdx: number | undefined };

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NAME_PREFIX = 'lastAddon';
const UPSTREAM_HINT_KEYS = ['proxyHeaders', 'headers'] as const;
/** HEVC/AV1 et audio DTS/TrueHD ne sont pas lus par les navigateurs ; les REMUX sont des conteneurs lourds. */
const NOT_WEB_READY_AUDIO = /dts|truehd/i;

const present = (value: string | undefined): value is string => typeof value === 'string' && value.length > 0;
const joinParts = (parts: (string | undefined)[]): string => parts.filter(present).join(' · ');

function targetOf(item: Ranked, hasDebrid: boolean): Target | undefined {
  const url = item.raw.url;
  if (url !== undefined && url.length > 0) return { kind: 'direct', url };
  const infoHash = infoHashOf(item);
  // Ni URL ni infoHash : stream inutilisable, on l'écarte.
  if (infoHash === undefined) return undefined;
  const fileIdx = fileIdxOf(item);
  return hasDebrid ? { kind: 'debrid', infoHash, fileIdx } : { kind: 'p2p', infoHash, fileIdx };
}

function playUrl(opts: FormatOptions, infoHash: string, fileIdx: number | undefined): string {
  const base = opts.playBaseUrl.replace(/\/+$/, '');
  const file = fileIdx === undefined ? '' : `/${fileIdx}`;
  const path = `${base}/${encodeURIComponent(opts.configToken)}/play/${encodeURIComponent(infoHash)}${file}`;
  const query = new URLSearchParams();
  if (opts.season !== undefined) query.set('s', String(opts.season));
  if (opts.episode !== undefined) query.set('e', String(opts.episode));
  const qs = query.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

/** Taille au format français : « 4,2 Go » ou « 850 Mo ». */
function formatSizeFr(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace('.', ',')} Go`;
  return `${Math.round(bytes / MIB)} Mo`;
}

/**
 * Libellé de langue et code de binge group.
 * Ordre : variante FR explicite, MULTi, VF (fr sans variante), VOSTFR (sous-titres seuls), VO.
 * Le code est la variante en minuscule, sinon `multi`, `fr`, `vostfr` ou `vo`.
 */
function languageInfo(parsed: ParsedRelease): { label: string; code: string } {
  if (parsed.frVariant !== undefined) return { label: parsed.frVariant, code: parsed.frVariant.toLowerCase() };
  if (parsed.multi || parsed.languages.includes('multi')) return { label: 'MULTi', code: 'multi' };
  if (parsed.languages.includes('fr')) return { label: 'VF', code: 'fr' };
  if (parsed.subsFr) return { label: 'VOSTFR', code: 'vostfr' };
  return { label: 'VO', code: 'vo' };
}

function notWebReady(parsed: ParsedRelease): boolean {
  return (
    parsed.codec === 'HEVC' ||
    parsed.codec === 'AV1' ||
    parsed.source === 'REMUX' ||
    parsed.audio.some((audio) => NOT_WEB_READY_AUDIO.test(audio))
  );
}

/** Débit moyen estimé en kb/s, ou null si la taille ou la durée manque. */
function estimateBitrateKbps(bytes: number | undefined, runtimeSeconds: number | undefined): number | null {
  if (bytes === undefined || runtimeSeconds === undefined || runtimeSeconds <= 0) return null;
  return Math.round((bytes * 8) / runtimeSeconds / 1000);
}

function buildDescription(item: Ranked, target: Target): string {
  const { parsed } = item;
  const resolutionKnown: Resolution | undefined = parsed.resolution === 'unknown' ? undefined : parsed.resolution;
  const line1 = joinParts([
    resolutionKnown,
    parsed.source === 'unknown' ? undefined : parsed.source,
    parsed.codec === 'unknown' ? undefined : parsed.codec,
    ...parsed.hdr,
  ]);
  const audio = [parsed.channels, ...parsed.audio].filter(present).join(' ');
  const line2 = joinParts([languageInfo(parsed).label, audio]);
  const seeders = seedersOf(item);
  const line3 = joinParts([
    formatSizeFr(sizeOf(item)),
    target.kind === 'debrid' ? 'AllDebrid' : undefined,
    target.kind === 'p2p' ? (seeders === undefined ? 'P2P' : `P2P · ${seeders} seeders`) : undefined,
    item.cached === true ? 'Cache' : undefined,
    item.raw.sourceName,
  ]);
  return [line1, line2, line3].filter(present).join('\n');
}

function behaviorHintsOf(item: Ranked, target: Target): Record<string, unknown> {
  const { parsed } = item;
  const hints: Record<string, unknown> = {};
  const filename = item.raw.filename || item.raw.title;
  if (filename) hints.filename = filename;
  const size = sizeOf(item);
  if (size !== undefined) hints.videoSize = size;
  hints.bingeGroup = `lastaddon|${parsed.resolution}|${languageInfo(parsed).code}|${parsed.source}`;
  // Le conteneur .mkv n'est pas détecté : notWebReady reste à false pour lui.
  hints.notWebReady = notWebReady(parsed);
  // Les en-têtes amont ne servent que pour une URL directe amont.
  if (target.kind === 'direct' && item.raw.behaviorHints) {
    for (const key of UPSTREAM_HINT_KEYS) {
      const value = item.raw.behaviorHints[key];
      if (value !== undefined) hints[key] = value;
    }
  }
  return hints;
}

function formatOne(item: Ranked, opts: FormatOptions): StremioStream | undefined {
  const target = targetOf(item, opts.hasDebrid);
  if (target === undefined) return undefined;
  const { parsed } = item;
  const size = sizeOf(item);

  const stream: StremioStream = {
    name: `${NAME_PREFIX}\n${parsed.resolution === 'unknown' ? '?' : parsed.resolution}`,
    description: buildDescription(item, target),
    behaviorHints: behaviorHintsOf(item, target),
    laststream: {
      resolution: parsed.resolution,
      height: parsed.height,
      source: parsed.source,
      codec: parsed.codec,
      hdr: parsed.hdr,
      languages: parsed.languages,
      frVariant: parsed.frVariant,
      sizeBytes: size,
      cached: item.cached === true,
      seeders: seedersOf(item),
      score: item.score,
      estBitrateKbps: estimateBitrateKbps(size, opts.runtimeSeconds),
    },
  };

  if (target.kind === 'direct') {
    stream.url = target.url;
  } else if (target.kind === 'debrid') {
    stream.url = playUrl(opts, target.infoHash, target.fileIdx);
  } else {
    stream.infoHash = target.infoHash;
    if (target.fileIdx !== undefined) stream.fileIdx = target.fileIdx;
    if (item.raw.sources) stream.sources = item.raw.sources;
  }
  return stream;
}

/** Transforme les candidats classés en streams Stremio, tronqués à `maxResults`. */
export function formatStreams(ranked: Ranked[], opts: FormatOptions): StremioStream[] {
  const streams: StremioStream[] = [];
  for (const item of ranked) {
    if (streams.length >= opts.maxResults) break;
    const stream = formatOne(item, opts);
    if (stream) streams.push(stream);
  }
  return streams;
}
