import { isNativePlayer, nativeFetch } from './native';

/* Client du serveur de streaming Stremio (HLS, probe, proxy, sous-titres ; jamais de torrent : les sources passent par un débrideur).
 * Protocole repris de stremio-video (withStreamingServer, fetchVideoParams, buildProxyUrl). */

export const DEFAULT_SERVER = 'http://127.0.0.1:11470';
export const SERVER_STORAGE_KEY = 'laststream.streamingServer';

let shellAddress = '';
/** Adresse annoncée par la coque (événement `server-address`). */
export function setShellServerAddress(addr: string): void {
  shellAddress = typeof addr === 'string' ? addr : '';
}

/** Chemin du relais same-origin vers le serveur de streaming (voir vite.config.ts). */
export const PROXY_PATH = '/_ss';

function customBase(): string {
  let custom = '';
  try { custom = globalThis.localStorage?.getItem(SERVER_STORAGE_KEY) ?? ''; } catch { /* stockage indisponible */ }
  return (custom || shellAddress).replace(/\/+$/, '');
}

/**
 * Le serveur de streaming n'ajoute les en-têtes CORS que pour strem.io, stremio.com et sa propre origine : depuis une
 * autre origine (localhost:8080, adresse du réseau local…), le navigateur refuse sondage, playlists HLS et sous-titres.
 */
export function corsFriendlyOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1):11470$/.test(origin) || /^https:\/\/([a-z0-9-]+\.)*(strem\.io|stremio\.com)$/.test(origin);
}

/** Adresses à essayer, dans l'ordre : réglage ou coque, direct si l'origine est admise, relais same-origin, direct. */
export function serverCandidates(origin = globalThis.location?.origin ?? ''): string[] {
  const out: string[] = [];
  const add = (b: string): void => { if (b && !out.includes(b)) out.push(b); };
  add(customBase());
  const proxy = /^https?:/.test(origin) ? origin + PROXY_PATH : '';
  if (corsFriendlyOrigin(origin)) { add(DEFAULT_SERVER); add(proxy); } else { add(proxy); add(DEFAULT_SERVER); }
  return out;
}

let resolved = '';

/** Adresse retenue par le dernier sondage (sinon le réglage, la coque ou l'adresse par défaut). */
export function serverBase(): string {
  return resolved || customBase() || DEFAULT_SERVER;
}

const join = (base: string, path: string): string => base.replace(/\/+$/, '') + path;

async function getJson<T>(url: string, timeoutMs = 8000, init?: RequestInit): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (init?.signal) {
    if (init.signal.aborted) ctl.abort(); else init.signal.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  try {
    const res = isNativePlayer() ? await nativeFetch(url, init, timeoutMs) : await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const json = (await res.json()) as T & { error?: unknown };
    if (json && typeof json === 'object' && 'error' in json && json.error) {
      const e = json.error as { message?: string } | string;
      throw new Error(typeof e === 'string' ? e : e.message ?? 'erreur du serveur');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

let aliveCache: { at: number; ok: boolean } | null = null;
export function resetServerCache(): void { aliveCache = null; resolved = ''; }

/** Le serveur répond-il ? Teste les adresses candidates et retient la première qui répond (résultat gardé 30 s). */
export async function serverAlive(now = Date.now()): Promise<boolean> {
  if (aliveCache && now - aliveCache.at < 30_000) return aliveCache.ok;
  let ok = false;
  for (const base of serverCandidates()) {
    try {
      await getJson(join(base, '/settings'), 2500);
      resolved = base;
      ok = true;
      break;
    } catch { /* adresse suivante */ }
  }
  aliveCache = { at: now, ok };
  return ok;
}

// ---------- Probe ----------

export interface ProbeStream {
  id?: number;
  track: 'audio' | 'video' | 'subtitle' | 'attachment' | string;
  codec?: string;
  channels?: number;
  lang?: string;
  language?: string;
  title?: string;
  label?: string;
  frameRate?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  default?: boolean;
  forced?: boolean;
}

export interface Probe {
  format?: { name?: string; duration?: number };
  streams: ProbeStream[];
}

export interface MediaCaps {
  formats: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxAudioChannels: number;
}

export function probeUrl(base: string, mediaURL: string): string {
  return join(base, '/hlsv2/probe?' + new URLSearchParams([['mediaURL', mediaURL]]).toString());
}

export async function fetchProbe(mediaURL: string, base = serverBase(), signal?: AbortSignal): Promise<Probe | null> {
  try {
    const p = await getJson<Probe>(probeUrl(base, mediaURL), 20_000, { signal });
    return p && Array.isArray(p.streams) ? p : null;
  } catch {
    return null;
  }
}

// ---------- HLS ----------

export function hlsQuery(mediaURL: string, caps: Pick<MediaCaps, 'videoCodecs' | 'audioCodecs' | 'maxAudioChannels'>, forceTranscoding = false, maxWidth = 0): string {
  const q = new URLSearchParams([['mediaURL', mediaURL]]);
  if (forceTranscoding) q.set('forceTranscoding', '1');
  if (maxWidth > 0) q.set('maxWidth', String(Math.round(maxWidth)));
  caps.videoCodecs.forEach((c) => q.append('videoCodecs', c));
  caps.audioCodecs.forEach((c) => q.append('audioCodecs', c));
  q.set('maxAudioChannels', String(caps.maxAudioChannels));
  return q.toString();
}

export function hlsMasterUrl(base: string, id: string, mediaURL: string, caps: Pick<MediaCaps, 'videoCodecs' | 'audioCodecs' | 'maxAudioChannels'>, forceTranscoding = false, maxWidth = 0): string {
  return join(base, '/hlsv2/' + encodeURIComponent(id) + '/master.m3u8?' + hlsQuery(mediaURL, caps, forceTranscoding, maxWidth));
}

export function newSessionId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') || String(Date.now());
}

/** Sous-titre ASS embarqué dans la session HLS. */
export function embeddedSubtitleUrl(base: string, id: string, streamId: number, query: string): string {
  return join(base, '/hlsv2/' + encodeURIComponent(id) + '/source/subtitle/' + streamId + '.ass?' + query);
}

// ---------- Proxy, sous-titres ----------

/** URL via le proxy du serveur (en-têtes requis par l'hébergeur). */
export function proxyUrl(base: string, streamURL: string, requestHeaders: Record<string, string> = {}, responseHeaders: Record<string, string> = {}): string {
  const u = new URL(streamURL);
  const o = new URLSearchParams();
  o.set('d', u.origin);
  Object.entries(requestHeaders).forEach(([k, v]) => o.append('h', k + ':' + v));
  Object.entries(responseHeaders).forEach(([k, v]) => o.append('r', k + ':' + v));
  return join(base, '/proxy/' + o.toString() + u.pathname) + u.search;
}

/** Sous-titre externe converti en WebVTT par le serveur. */
export function subtitlesVttUrl(base: string, from: string): string {
  return join(base, '/subtitles.vtt?' + new URLSearchParams([['from', from]]).toString());
}

export interface OpenSubParams { hash: string | null; size: number | null }

export async function fetchOpenSubParams(videoUrl: string, base = serverBase()): Promise<OpenSubParams | null> {
  try {
    const r = await getJson<{ result?: { hash?: string; size?: number } }>(join(base, '/opensubHash?' + new URLSearchParams([['videoUrl', videoUrl]]).toString()), 15_000);
    return { hash: typeof r.result?.hash === 'string' ? r.result.hash : null, size: typeof r.result?.size === 'number' ? r.result.size : null };
  } catch {
    return null;
  }
}
