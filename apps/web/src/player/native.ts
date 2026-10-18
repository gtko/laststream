import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SkipSegment } from './skip';
import { normalizeLang, type AudioTrack, type SubtitleTrack } from './tracks';

/* Pont vers le lecteur natif Android (plugin Capacitor `LaststreamPlayer`, libVLC). Comme pour mpv dans la coque Windows,
 * la lecture est déléguée : la session JS garde la progression, les segments et l'épisode suivant, et réagit aux évènements. */

export interface NativeOpenOptions {
  url: string;
  title?: string;
  subtitle?: string;
  startPosition?: number;
  preferredAudioLang?: string;
  preferredSubLang?: string;
  /** `auto` : sous-titres si l'audio n'est pas dans la langue préférée ; `always` ; `off`. */
  subMode?: 'auto' | 'always' | 'off';
  subtitles?: Array<{ url: string; lang: string; label: string }>;
  skipSegments?: Array<{ kind: string; start: number; end: number; inferred?: boolean; confidence?: number }>;
  nextEpisode?: { title: string; still?: string } | null;
  headers?: Record<string, string>;
}

export interface NativeTrack { id: number; label: string; lang: string; selected: boolean }

export interface NativeEvents {
  progress: { position: number; duration: number };
  state: { position: number; duration: number; paused: boolean; buffering: boolean; rate: number; ended?: boolean };
  tracks: { audio: NativeTrack[]; subs: NativeTrack[] };
  ended: { position: number; duration: number };
  closed: { position: number; duration: number };
  error: { code: string; position?: number };
  nextEpisode: { position: number; duration: number };
  trackChanged: { kind: 'audio' | 'sub'; id: number; lang: string; label: string };
}

export interface LaststreamPlayerPlugin {
  open(options: NativeOpenOptions): Promise<void>;
  update(options: { skipSegments?: NativeOpenOptions['skipSegments']; nextEpisode?: NativeOpenOptions['nextEpisode']; title?: string; subtitle?: string }): Promise<void>;
  addSubtitles(options: { subtitles: NonNullable<NativeOpenOptions['subtitles']> }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setAudioTrack(options: { id: number }): Promise<void>;
  setSubtitleTrack(options: { id: number }): Promise<void>;
  setSubtitleDelay(options: { ms: number }): Promise<void>;
  getState(): Promise<{ open: boolean } & Partial<NativeEvents['state']>>;
  close(): Promise<void>;
  addListener<E extends keyof NativeEvents>(event: E, fn: (data: NativeEvents[E]) => void): Promise<PluginListenerHandle>;
}

export const NativePlayer = registerPlugin<LaststreamPlayerPlugin>('LaststreamPlayer');

/** Application Android (Capacitor) avec le lecteur natif ; faux dans le navigateur et la coque Windows. */
export function isNativePlayer(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LaststreamPlayer');
  } catch {
    return false;
  }
}

/** Segments au format du plugin (champs utiles seulement). */
export function toNativeSegments(list: readonly SkipSegment[]): NonNullable<NativeOpenOptions['skipSegments']> {
  return list.map((s) => ({ kind: s.kind, start: s.start, end: s.end, ...(s.inferred ? { inferred: true } : {}), ...(typeof s.confidence === 'number' ? { confidence: s.confidence } : {}) }));
}

/**
 * Sous-titres externes à confier au lecteur : la langue préférée (jusqu'à 4) puis l'anglais (2) ; le panneau natif reste lisible.
 * Les URL partent telles quelles : libVLC les télécharge lui-même (SRT, ASS, WebVTT).
 */
export function toNativeSubtitles(list: readonly SubtitleTrack[], preferredLang: string): Array<{ url: string; lang: string; label: string }> {
  const pref = normalizeLang(preferredLang);
  const keep = (lang: string, max: number) => list.filter((t) => t.url && t.lang === lang).slice(0, max);
  const picked = [...keep(pref, 4), ...(pref !== 'en' ? keep('en', 2) : [])];
  return picked.map((t) => ({ url: t.url as string, lang: t.lang, label: t.label }));
}

/** Pistes natives au format des pistes du lecteur web (identifiant = identifiant libVLC). */
export function nativeAudioTracks(list: readonly NativeTrack[]): AudioTrack[] {
  return list.map((t) => ({ id: String(t.id), title: t.label, lang: t.lang, codec: '', channels: 0, selected: t.selected, label: t.label }));
}

export function nativeSubtitleTracks(list: readonly NativeTrack[]): SubtitleTrack[] {
  return list.map((t): SubtitleTrack => ({
    id: String(t.id), title: t.label, lang: t.lang, codec: '', forced: /forc/i.test(t.label), origin: 'embedded', renderable: true, engineId: t.id, selected: t.selected, label: t.label,
  }));
}

/**
 * `fetch` sans CORS pour le serveur de streaming (il ne l'ouvre qu'à strem.io) : sur Android la requête part du code natif.
 * Renvoie une `Response` classique ; `timeoutMs` borne la connexion et la lecture.
 */
export async function nativeFetch(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  let data: unknown;
  if (typeof init.body === 'string') {
    try { data = JSON.parse(init.body); } catch { data = init.body; }
  }
  const r = await CapacitorHttp.request({ url, method: (init.method ?? 'GET').toUpperCase(), headers, data, connectTimeout: timeoutMs, readTimeout: timeoutMs, responseType: 'text' });
  const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null);
  return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
}
