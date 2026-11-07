import { parseLanguages } from '@laststream/protocol/language';
import { is1440Text, type DeviceTarget } from '../data/sources';
import type { Resolution, Stream } from '../data/stream';
import { browserFetchHttp, capacitorHttp, capacitorNative, nativeKind, NATIVE_ADDON_COMMAND, shellHttp, type HttpFn } from './debrid/http';

/* Repli « via l'appareil » : quand un addon refuse l'IP de lastAddon (Cloudflare), le serveur renvoie son URL /stream
 * (`deviceFetch`). L'appareil l'interroge lui-même (fetch navigateur, sinon pont natif), normalise les flux comme le serveur
 * (parsing du nom) et les fusionne à la liste. Les URL peuvent porter la clé de débrideur de l'utilisateur : rien n'est
 * journalisé ni mis en cache, et le pont natif n'est utilisé que pour les URL exactes renvoyées par le serveur. */

/* Les addons répondent souvent en 3 à 10 s (scraping) : 8 s coupaient les plus lents, la liste restait vide. 15 s tiennent dans
 * la fenêtre d'attente du lancement (20 s) ; les autres addons ne sont pas retardés (voir `fetchDeviceStreams`). */
export const DEVICE_FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ---------- Nom des addons ----------

/** Noms par défaut (« Addon amont » d'un ajout sans manifest lu, champ vide) : ce ne sont pas des noms d'addon. */
const GENERIC_ADDON_NAMES = ['addon amont', 'torznab', 'source', ''];
/** Nom du manifest des addons déjà lus dans cette session (clé : `addonKey`). */
const knownAddonNames = new Map<string, string>();

const isGenericAddonName = (name: string): boolean => GENERIC_ADDON_NAMES.includes(name.trim().toLowerCase());

/** Adresse de l'addon sans `manifest.json` ni `/stream/…` (le préfixe de configuration est gardé). Vide si invalide. */
export function addonKey(raw: string): string {
  try {
    const url = new URL(raw.replace(/^stremio:\/\//i, 'https://'));
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/(manifest\.json|stream\/[^/]+\/[^/]+\.json)$/i, '').replace(/\/+$/, '');
    return url.origin + url.pathname;
  } catch {
    return '';
  }
}

/** Retient le nom du manifest d'un addon (lu par les réglages) pour nommer ses flux récupérés depuis l'appareil. */
export function rememberAddonName(addonUrl: string, name: string): void {
  const key = addonKey(addonUrl);
  const clean = name.trim();
  if (key && clean && !isGenericAddonName(clean)) knownAddonNames.set(key, clean);
}

/**
 * Nom affiché d'un addon interrogé depuis l'appareil : son nom s'il n'est pas générique, sinon le nom de son manifest déjà connu,
 * sinon l'hôte de son adresse.
 */
export function deviceAddonName(target: DeviceTarget): string {
  if (!isGenericAddonName(target.addonId)) return target.addonId.trim();
  const known = knownAddonNames.get(addonKey(target.url));
  if (known) return known;
  try {
    return new URL(target.url).hostname.replace(/^www\./i, '') || target.addonId;
  } catch {
    return target.addonId;
  }
}

// ---------- Normalisation ----------

const RES_SCORE: Record<Resolution, number> = { '2160p': 400, '1440p': 350, '1080p': 300, '720p': 200, '480p': 100, SD: 50, unknown: 0 };

function resolutionOf(t: string): Resolution {
  if (/2160p?|\b4k\b|\buhd\b/i.test(t)) return '2160p';
  if (is1440Text(t)) return '1440p';
  if (/1080p?|\bfhd\b/i.test(t)) return '1080p';
  if (/720p?/i.test(t)) return '720p';
  if (/480p?/i.test(t)) return '480p';
  return /\b(sd|dvdrip|cam|hdts)\b/i.test(t) ? 'SD' : 'unknown';
}

const SOURCES: Array<[RegExp, string]> = [
  [/remux/i, 'REMUX'], [/blu-?ray|bdrip|brrip/i, 'BluRay'], [/web-?dl/i, 'WEB-DL'], [/web-?rip/i, 'WEBRip'],
  [/hdtv/i, 'HDTV'], [/dvd/i, 'DVDRip'], [/\bcam\b|hdcam/i, 'CAM'], [/\bts\b|telesync/i, 'TS'],
];

function sizeOf(t: string, hints: Record<string, unknown>): number | undefined {
  if (typeof hints.videoSize === 'number' && hints.videoSize > 0) return hints.videoSize;
  const m = /(\d+(?:[.,]\d+)?)\s*(tb|to|gb|go|mb|mo)\b/i.exec(t);
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  const mult = unit === 'tb' || unit === 'to' ? 1e12 : unit === 'gb' || unit === 'go' ? 1e9 : 1e6;
  return Math.round(n * mult);
}

function seedersOf(t: string): number | undefined {
  const m = /(?:👤|👥|seeders?:?)\s*(\d+)/i.exec(t);
  return m ? Number(m[1]) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Normalise un flux Stremio brut d'un addon interrogé depuis l'appareil. Null si ni lien HTTP(S) ni infoHash. */
export function normalizeDeviceStream(raw: unknown, addonId: string): Stream | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const url = str(r.url);
  const httpUrl = url && /^https?:\/\//i.test(url) ? url : undefined;
  const infoHash = str(r.infoHash)?.toLowerCase();
  if (!httpUrl && !(infoHash && /^[0-9a-f]{40}$/.test(infoHash))) return null;
  const hints = typeof r.behaviorHints === 'object' && r.behaviorHints !== null && !Array.isArray(r.behaviorHints) ? (r.behaviorHints as Record<string, unknown>) : {};
  const name = str(r.name) ?? '';
  const title = str(r.title) ?? '';
  const description = str(r.description) ?? '';
  const filename = str(hints.filename);
  const text = [name, title, description, filename].filter(Boolean).join(' ');
  const resolution = resolutionOf(text);
  const source = SOURCES.find(([re]) => re.test(text))?.[1] ?? 'unknown';
  const codec = /av1/i.test(text) ? 'AV1' : /hevc|x265|h\.?265/i.test(text) ? 'HEVC' : /x264|h\.?264|avc/i.test(text) ? 'AVC' : 'unknown';
  const hdr = [/dolby.?vision|\bdv\b/i.test(text) ? 'DV' : '', /hdr10\+/i.test(text) ? 'HDR10+' : /hdr/i.test(text) ? 'HDR10' : ''].filter(Boolean);
  // Parseur unique partagé avec le serveur (@laststream/protocol) : mêmes langues et variante que les flux du serveur.
  const { languages, frVariant } = parseLanguages(text);
  const sizeBytes = sizeOf(text, hints);
  const seeders = seedersOf(text);
  // « En cache » seulement si l'addon le signale (⚡ ou [RD+]) : un lien HTTP direct n'est pas un lien débridé en cache.
  const cached = /⚡|\[[a-z]{1,3}\+\]/i.test(name);
  const score = RES_SCORE[resolution] + (cached ? 60 : 0) + Math.min(seeders ?? 0, 100) / 5 + (languages.includes('fr') || languages.includes('multi') ? 20 : 0) + (source === 'CAM' || source === 'TS' ? -300 : 0);
  const stream: Stream = {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(httpUrl ? { url: httpUrl } : {}),
    ...(infoHash && !httpUrl ? { infoHash } : {}),
    ...(typeof r.fileIdx === 'number' && !httpUrl ? { fileIdx: r.fileIdx } : {}),
    behaviorHints: {
      ...(filename ? { filename } : {}),
      ...(typeof hints.videoSize === 'number' ? { videoSize: hints.videoSize } : {}),
      ...(typeof hints.bingeGroup === 'string' ? { bingeGroup: hints.bingeGroup } : {}),
      ...(hints.notWebReady === true ? { notWebReady: true } : {}),
      // Torrent sans lien : débridé sur l'appareil seulement si une clé est configurée dans l'app (option avancée).
      ...(!httpUrl ? { lastDebrid: 'client' } : {}),
    },
    laststream: {
      resolution, height: parseInt(resolution, 10) || 0, source, codec, hdr, languages, ...(frVariant ? { frVariant } : {}),
      ...(sizeBytes ? { sizeBytes } : {}), ...(seeders !== undefined ? { seeders } : {}),
      cached, score, estBitrateKbps: null,
      origins: [{ kind: 'addon', name: addonId }],
      ...(filename ? { filename } : {}),
    },
    viaDevice: true,
  };
  return stream;
}

/** Flux d'une réponse `/stream` d'addon (JSON `{ streams: [...] }`), normalisés. */
export function normalizeDeviceResponse(body: unknown, addonId: string): Stream[] {
  const list = (body as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => { const n = normalizeDeviceStream(s, addonId); return n ? [n] : []; });
}

// ---------- Fusion ----------

/** Fusionne les flux de l'appareil à ceux du serveur ; dédoublonne par infoHash (puis par lien). L'existant prime. */
export function mergeDeviceStreams(base: readonly Stream[], extra: readonly Stream[]): Stream[] {
  const hashes = new Set<string>();
  const urls = new Set<string>();
  const note = (s: Stream): void => {
    if (typeof s.infoHash === 'string') hashes.add(s.infoHash.toLowerCase());
    if (typeof s.url === 'string') urls.add(s.url);
  };
  base.forEach(note);
  const out = [...base];
  for (const s of extra) {
    const dup = (typeof s.infoHash === 'string' && hashes.has(s.infoHash.toLowerCase())) || (typeof s.url === 'string' && urls.has(s.url));
    if (dup) continue;
    note(s);
    out.push(s);
  }
  return out;
}

// ---------- Transport ----------

/**
 * Transport restreint aux URL renvoyées par le serveur : fetch navigateur d'abord, puis (échec réseau / CORS) le pont natif
 * (coque Windows, CapacitorHttp). Toute autre URL est refusée avant d'atteindre l'un ou l'autre.
 */
export function deviceHttp(allowed: ReadonlySet<string>, deps: { fetchHttp?: HttpFn; nativeHttp?: HttpFn | null } = {}): HttpFn {
  const fetchHttp = deps.fetchHttp ?? browserFetchHttp();
  const native = deps.nativeHttp !== undefined ? deps.nativeHttp : (() => {
    const kind = nativeKind();
    return kind === 'shell' ? shellHttp(undefined, NATIVE_ADDON_COMMAND) : capacitorNative() ? capacitorHttp() : null;
  })();
  return async (req) => {
    if (!allowed.has(req.url)) throw new Error('url_not_allowed');
    try {
      return await fetchHttp(req);
    } catch (err) {
      if (!native || (err as { code?: string })?.code === 'aborted') throw err;
      return native(req);
    }
  };
}

export interface DeviceFetchHooks {
  http?: HttpFn;
  timeoutMs?: number;
  /** Appelé à la fin de chaque addon (flux normalisés ; vide en cas d'échec). */
  onAddon: (target: DeviceTarget, streams: Stream[]) => void;
}

/** Interroge les addons en parallèle (8 s chacun). Ne rejette jamais ; se résout quand tous ont répondu ou expiré. */
export async function fetchDeviceStreams(targets: readonly DeviceTarget[], hooks: DeviceFetchHooks): Promise<void> {
  const timeoutMs = hooks.timeoutMs ?? DEVICE_FETCH_TIMEOUT_MS;
  const http = hooks.http ?? deviceHttp(new Set(targets.map((t) => t.url)));
  await Promise.all(targets.map(async (target) => {
    let streams: Stream[] = [];
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = http({ url: target.url, headers: { Accept: 'application/json' }, timeoutMs, signal: ctl.signal });
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, timeoutMs); });
      const res = await Promise.race([work, expired]);
      if (res.status >= 200 && res.status < 300 && res.body.byteLength <= MAX_BODY_BYTES) {
        streams = normalizeDeviceResponse(JSON.parse(new TextDecoder().decode(res.body)), deviceAddonName(target));
      }
    } catch {
      streams = [];
    } finally {
      clearTimeout(timer);
    }
    hooks.onAddon(target, streams);
  }));
}
