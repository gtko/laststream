import { copiesOf, formatBitrate, formatSize, getQualityGroupKey, languageLabel, type QualityGroupKey } from '../data/sources';
import type { MediaCaps } from '../player/server';
import { conversionOf, webPlayback, type WebPlayback } from './direct';
import { getLaststream, type Lang, type LastStreamInfo, type Resolution, type Stream } from '../data/stream';

/* Fiche détaillée d'une source : transforme un stream lastAddon (objet `laststream` + indices Stremio) en
 * données d'affichage prêtes à l'emploi pour le sélecteur de sources. Fonctions pures, testées. */

export type SourceStatus = 'cached' | 'uncached' | 'p2p' | 'direct';

export interface Origin {
  kind: 'addon' | 'indexer' | 'prowlarr-local';
  name: string;
  logo?: string;
}

export interface LangBadge {
  label: string;
  verified: boolean;
}

export interface SourceView {
  /** Position dans la liste d'origine (stable, sert d'identifiant). */
  index: number;
  stream: Stream;
  info: LastStreamInfo | null;
  group: QualityGroupKey;
  resolution: Resolution;
  /** Badge de qualité : 4K, 1080p, 720p, SD… */
  quality: string;
  /** REMUX, BluRay, WEB-DL… (vide si inconnu). */
  sourceType: string;
  codec: string;
  hdr: string[];
  /** « TrueHD Atmos 7.1 » (vide si inconnu). */
  audio: string;
  langs: LangBadge[];
  hasFrench: boolean;
  sizeBytes: number;
  sizeLabel: string;
  bitrateKbps: number | null;
  bitrateLabel: string;
  durationSec: number | null;
  durationLabel: string;
  seeders: number | null;
  peers: number | null;
  copies: number;
  /** Où la source a été trouvée (addons, indexeurs) ; vide si inconnu. */
  origins: Origin[];
  trackers: string[];
  filename: string;
  releaseGroup: string;
  status: SourceStatus;
  statusLabel: string;
  provider: string;
  /** Joignable par le navigateur ou le serveur de streaming : lien HTTP ou torrent. */
  playable: boolean;
  isTorrent: boolean;
  /** Indice « lecture navigateur incertaine » (HEVC, REMUX, DTS/TrueHD). */
  notWebReady: boolean;
  score: number;
  /** Lecture directe dans le navigateur, conversion nécessaire, ou inconnu (renseigné par `withWebPlayback`). */
  web: WebPlayback;
  /** Nature de la conversion quand `web` vaut `convert` : audio seulement (léger) ou vidéo (réencodage lent). */
  convert: 'audio' | 'video' | null;
}

const QUALITY_BADGE: Record<Resolution, string> = {
  '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p', SD: 'SD', unknown: '?',
};

const SOURCE_TYPES: Array<[RegExp, string]> = [
  [/remux/i, 'REMUX'],
  [/blu-?ray|bdrip|brrip/i, 'BluRay'],
  [/web-?dl/i, 'WEB-DL'],
  [/web-?rip/i, 'WEBRip'],
  [/hdtv|pdtv/i, 'HDTV'],
  [/dvd/i, 'DVD'],
  [/\bweb\b/i, 'WEB'],
  [/cam|telesync|\bts\b/i, 'CAM'],
];

export function sourceTypeLabel(raw: string): string {
  const t = raw.trim();
  if (!t || /^unknown$/i.test(t)) return '';
  for (const [re, label] of SOURCE_TYPES) if (re.test(t)) return label;
  return t;
}

/** Puces HDR normalisées : DV, HDR10+, HDR10, HDR, HLG (sans doublon, ordre d'importance). */
export function hdrChips(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of raw) {
    const t = h.toLowerCase();
    if (/dolby|^dv$|\bdv\b|dovi/.test(t)) out.add('DV');
    if (/hdr10\+|hdr10plus/.test(t)) out.add('HDR10+');
    else if (/hdr10/.test(t)) out.add('HDR10');
    else if (/hlg/.test(t)) out.add('HLG');
    else if (/hdr/.test(t)) out.add('HDR');
  }
  if (out.has('HDR10+') || out.has('HDR10')) out.delete('HDR');
  const order = ['DV', 'HDR10+', 'HDR10', 'HDR', 'HLG'];
  return order.filter((c) => out.has(c));
}

const AUDIO_PATTERNS: Array<[RegExp, string]> = [
  [/truehd/i, 'TrueHD'],
  [/dts-?hd[ .-]?ma|dts-?hd/i, 'DTS-HD MA'],
  [/dts-?x/i, 'DTS:X'],
  [/\bdts\b/i, 'DTS'],
  [/ddp|dd\+|e-?ac-?3|eac3/i, 'DDP'],
  [/\bdd\b|\bac-?3\b/i, 'DD'],
  [/flac/i, 'FLAC'],
  [/opus/i, 'Opus'],
  [/aac/i, 'AAC'],
  [/mp3/i, 'MP3'],
];

/** Audio lisible : « TrueHD Atmos 7.1 », « DDP 5.1 »… à partir des champs lastAddon ou, à défaut, d'un texte libre. */
export function audioLabel(audio: readonly string[] | undefined, channels: string | undefined, fallbackText = ''): string {
  const parts: string[] = [];
  const joined = (audio ?? []).join(' ');
  const text = joined || fallbackText;
  const codec = AUDIO_PATTERNS.find(([re]) => re.test(text));
  if (joined) {
    const known = codec ? codec[1] : joined.trim();
    parts.push(known);
  } else if (codec) {
    parts.push(codec[1]);
  }
  if (/atmos/i.test(text)) parts.push('Atmos');
  const ch = channels || (/\b([2578])[ .]([01])\b/.exec(text)?.slice(1, 3).join('.') ?? '');
  if (ch) parts.push(ch);
  return parts.join(' ').trim();
}

function languageBadges(info: LastStreamInfo, text: string): LangBadge[] {
  const verified = (l: Lang): boolean => info.verifiedLanguages === true || (Array.isArray(info.verifiedLanguages) && info.verifiedLanguages.includes(l));
  const out: LangBadge[] = [];
  if (info.frVariant) {
    out.push({ label: info.frVariant.toUpperCase(), verified: verified('fr') });
  }
  if (info.languages.includes('multi') && !out.some((b) => /multi/i.test(b.label))) out.push({ label: 'MULTI', verified: verified('multi') });
  if (!out.length) {
    const label = languageLabel(info);
    label.split(' · ').filter(Boolean).forEach((l) => out.push({ label: l, verified: info.languages.some((x) => x.toUpperCase() === l.toUpperCase() && verified(x)) }));
  }
  if (/vostfr/i.test(text) && !out.some((b) => /vostfr/i.test(b.label))) out.push({ label: 'VOSTFR', verified: false });
  return out;
}

const PROVIDERS = /(all-?debrid|real-?debrid|premiumize|torbox|debrid-?link|offcloud)/i;

function providerOf(info: LastStreamInfo | null, text: string): string {
  if (info?.provider) return info.provider;
  const m = PROVIDERS.exec(text);
  if (!m) return '';
  const k = m[1].toLowerCase().replace('-', '');
  const names: Record<string, string> = { alldebrid: 'AllDebrid', realdebrid: 'Real-Debrid', premiumize: 'Premiumize', torbox: 'TorBox', debridlink: 'Debrid-Link', offcloud: 'Offcloud' };
  return names[k] ?? m[1];
}

/** Hôtes des trackers d'un stream torrent (`sources: ['tracker:udp://x:80', …]`). */
export function trackerHosts(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const hosts = new Set<string>();
  for (const s of sources) {
    if (typeof s !== 'string' || !s.startsWith('tracker:')) continue;
    try {
      hosts.add(new URL(s.slice(8)).hostname);
    } catch {
      /* tracker illisible */
    }
  }
  return [...hosts];
}

/**
 * Origines d'une source : `laststream.origins`, à défaut `laststream.indexers`, à défaut la première ligne du nom du stream
 * (« Lumio\n1080p »). Sans doublon (casse ignorée).
 */
export function originsOf(info: LastStreamInfo | null, stream: Stream): Origin[] {
  let list: Origin[] = [];
  if (info?.origins?.length) list = info.origins.map((o) => ({ ...o }));
  else if (info?.indexers?.length) list = info.indexers.map((name) => ({ kind: 'indexer' as const, name }));
  else if (typeof stream.name === 'string') {
    const first = stream.name.split('\n')[0].trim();
    if (first) list = [{ kind: 'addon', name: first }];
  }
  const seen = new Set<string>();
  return list.filter((o) => { const k = o.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** « C411 » ; « C411 +2 » quand il y en a davantage que `max`. */
export function originSummary(origins: readonly Origin[], max = 2): string {
  if (!origins.length) return '';
  const shown = origins.slice(0, max).map((o) => o.name).join(', ');
  return origins.length > max ? shown + ' +' + (origins.length - max) : shown;
}

export function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return '';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ' h ' + String(m).padStart(2, '0');
}

export function statusLabelOf(status: SourceStatus, provider: string): string {
  switch (status) {
    case 'cached': return 'Cache ' + (provider || 'débrideur') + ' ⚡ prêt';
    case 'uncached': return 'Non caché (téléchargement)';
    case 'p2p': return 'P2P';
    default: return 'Lien direct';
  }
}

const hasUrl = (s: Stream): boolean => typeof s.url === 'string' && /^(https?:)?\/\//i.test(s.url);
const hasHash = (s: Stream): boolean => typeof s.infoHash === 'string' && s.infoHash.length >= 32;

export function toSourceView(stream: Stream, index: number, all: readonly Stream[] = [stream]): SourceView {
  const info = getLaststream(stream);
  const hints = stream.behaviorHints ?? {};
  const text = [stream.name, stream.title, stream.description, hints.filename].filter((x): x is string => typeof x === 'string').join(' ');
  const resolution: Resolution = info?.resolution ?? (/2160|4k|uhd/i.test(text) ? '2160p' : /1080/.test(text) ? '1080p' : /720/.test(text) ? '720p' : 'unknown');
  const provider = providerOf(info, text);
  const torrentOnly = !hasUrl(stream) && hasHash(stream);
  const cached = info?.cached === true;
  const status: SourceStatus = torrentOnly ? 'p2p' : provider || info ? (cached ? 'cached' : provider ? 'uncached' : 'direct') : 'direct';
  const sizeBytes = info?.sizeBytes ?? (typeof hints.videoSize === 'number' ? hints.videoSize : 0);
  const kbps = info?.estBitrateKbps ?? (info?.bitrateMbps ? info.bitrateMbps * 1000 : null);
  const durationSec = sizeBytes > 0 && kbps && kbps > 0 ? (sizeBytes * 8) / 1000 / kbps : null;
  const filename = info?.filename ?? hints.filename ?? '';
  const trackers = info?.indexers ?? trackerHosts(stream.sources);
  const origins = originsOf(info, stream);
  const langs = info ? languageBadges(info, text) : [];
  const hasFrench = info ? info.languages.includes('fr') || info.languages.includes('multi') || langs.some((b) => /^(VF|VFF|VFQ|VFI|MULTI|TRUEFRENCH)/i.test(b.label)) : /\b(vf|multi|truefrench)\b/i.test(text);
  return {
    index,
    stream,
    info,
    group: getQualityGroupKey(stream),
    resolution,
    quality: QUALITY_BADGE[resolution],
    sourceType: sourceTypeLabel(info?.source ?? ''),
    codec: info && info.codec !== 'unknown' ? info.codec : '',
    hdr: hdrChips(info?.hdr ?? []),
    audio: audioLabel(info?.audio, info?.channels, text),
    langs,
    hasFrench,
    sizeBytes,
    sizeLabel: formatSize(sizeBytes),
    bitrateKbps: kbps,
    bitrateLabel: formatBitrate(kbps),
    durationSec,
    durationLabel: formatDuration(durationSec),
    seeders: info?.seeders ?? null,
    peers: info?.peers ?? null,
    copies: info?.copies ?? copiesOf(stream, all),
    origins,
    trackers,
    filename,
    releaseGroup: info?.releaseGroup ?? '',
    status,
    statusLabel: statusLabelOf(status, provider),
    provider,
    playable: hasUrl(stream) || hasHash(stream),
    isTorrent: torrentOnly,
    notWebReady: hints.notWebReady === true,
    score: info?.score ?? 0,
    web: 'unknown',
    convert: null,
  };
}

export function toSourceViews(streams: readonly Stream[]): SourceView[] {
  return streams.map((s, i) => toSourceView(s, i, streams));
}

/** Signature de « même copie » : qualité, source, codec et langues (taille ignorée). Sert au failover. */
export function copySignature(v: SourceView): string {
  const i = v.info;
  if (!i) return 'x:' + v.index;
  return [i.resolution, i.source, i.codec, [...i.languages].sort().join('+')].join('|');
}

/** Renseigne `web` d'après les capacités réelles du navigateur ; `null` (coque Windows) : inconnu partout. */
export function withWebPlayback(views: readonly SourceView[], caps: MediaCaps | null): SourceView[] {
  return views.map((v) => {
    if (!caps) return { ...v, web: 'unknown' as const, convert: null };
    const c = conversionOf(v.stream, v.info, caps);
    return { ...v, web: webPlayback(v.stream, v.info, caps), convert: c === 'audio' || c === 'video' ? c : null };
  });
}
