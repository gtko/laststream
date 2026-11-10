import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SourceStatus } from '../sources/info';
import type { SkipSegment } from './skip';
import { normalizeLang, trackLang, type AudioTrack, type SubtitleTrack } from './tracks';

/* Pont vers le lecteur natif Android (plugin Capacitor `LaststreamPlayer`, libVLC). Comme pour mpv dans la coque Windows,
 * la lecture est déléguée : la session JS garde la progression, les segments et l'épisode suivant, et réagit aux évènements. */

export interface NativeOpenOptions {
  url: string;
  title?: string;
  subtitle?: string;
  startPosition?: number;
  /** Numéro du chargement, renvoyé par le natif dans les évènements du média (un APK ancien l'ignore). */
  loadId?: number;
  preferredAudioLang?: string;
  preferredSubLang?: string;
  /** `auto` : sous-titres si l'audio n'est pas dans la langue préférée ; `always` ; `off`. */
  subMode?: 'auto' | 'always' | 'off';
  subtitles?: Array<{ url: string; lang: string; label: string }>;
  skipSegments?: Array<{ kind: string; start: number; end: number; inferred?: boolean; confidence?: number }>;
  nextEpisode?: { title: string; still?: string } | null;
  headers?: Record<string, string>;
  /** Panneau « Sources » du lecteur natif. */
  sources?: NativeSource[];
  /** Panneau « Épisodes » (séries seulement). */
  episodes?: NativeEpisodes | null;
  /** Durée du fichier en secondes, quand la sonde l'a donnée : repli pour la progression si libVLC ne la fournit pas (0 : inconnue). */
  durationSec?: number;
  /** Mise en tampon réseau de libVLC, en ms (réglage « Mémoire tampon »). */
  networkCachingMs?: number;
}

/** Source du panneau natif. `label` et `detail` restent servis tels quels (anciennes versions du lecteur) ; les champs suivants,
 * facultatifs, reprennent la carte du sélecteur web (qualité, langues, codecs, statut, release). */
export interface NativeSource {
  id: string; label: string; detail: string; current: boolean; group?: string;
  quality?: string; sourceType?: string; codec?: string; audio?: string; hdr?: string[];
  langs?: Array<{ label: string; verified: boolean }>;
  size?: string; bitrate?: string; release?: string; releaseGroup?: string;
  status?: SourceStatus; statusLabel?: string; provider?: string;
  origins?: string[]; copies?: number;
}

interface NativeEpisode {
  season: number; episode: number; title: string; still?: string; durationMin?: number;
  watched: boolean; progress: number; current: boolean; aired: boolean;
}

export interface NativeEpisodes {
  seasons: Array<{ number: number; name: string }>;
  currentSeason: number;
  items: NativeEpisode[];
}

export interface NativeTrack { id: number; label: string; lang: string; selected: boolean }

/** Spectateur ou auteur d'une note, affiché par le natif (avatars, marqueurs, bulles). `avatarUrl` absent : initiale. */
export interface NativeViewer { id: string; name: string; initial?: string; avatarUrl?: string }

/** Marqueur de la barre : `pos` en secondes ; `mine` : posé par le profil connecté. */
export interface NativeNote { id: string; pos: number; kind: 'emoji' | 'text'; body: string; by: NativeViewer; mine: boolean }

/** État de synchro du salon : calé, en rattrapage (écart d'au moins 1,5 s), ou en attente du tampon d'un membre. */
type NativeRoomSync = 'synced' | 'catching' | 'waiting';

/** Salon vu par le natif (LAST-1632) : nombre de membres (moi compris), rôle, état de synchro. */
export interface NativeRoom { members: number; host: boolean; sync: NativeRoomSync }

/**
 * Couche sociale du lecteur natif. `enabled` faux : rien du social n'apparaît (profil enfant, statut invisible, mode cinéma).
 * `room` : salon actif (null hors salon) ; un APK antérieur l'ignore.
 */
export interface NativeSocial { enabled: boolean; quick: string[]; more: string[]; viewers: NativeViewer[]; room: NativeRoom | null }

/** Message entrant affiché en bulle (haut gauche) par le natif, six secondes, file de trois. */
export interface NativeMessage { id: string; from: NativeViewer; body: string }

interface NativeEvents {
  progress: { position: number; duration: number };
  state: { position: number; duration: number; paused: boolean; buffering: boolean; rate: number; ended?: boolean };
  tracks: { audio: NativeTrack[]; subs: NativeTrack[] };
  ended: { position: number; duration: number };
  closed: { position: number; duration: number };
  error: { code: string; position?: number };
  nextEpisode: { position: number; duration: number };
  selectSource: { id: string; position: number };
  selectEpisode: { season: number; episode: number };
  loadSeason: { season: number };
  trackChanged: { kind: 'audio' | 'sub'; id: number; lang: string; label: string };
  /** Le lecteur natif passe en vignette flottante (true) ou revient en plein écran (false). */
  miniChanged: { mini: boolean };
  /** Réaction posée depuis le natif à la position `pos` (secondes) : le JS la poste comme « Réagir ici ». */
  react: { emoji: string; pos: number };
  /** Réponse rapide à un message affiché en bulle. */
  reply: { messageId: string; emoji: '😂' | '❤️' };
  /** Réponse texte saisie dans la carte de message (LAST-1632) : au chat du salon en salon, sinon à l'auteur du message. */
  replyText: { messageId: string; text: string };
  /** Erreur à afficher côté web. */
  socialError: { message: string };
}

export interface LaststreamPlayerPlugin {
  open(options: NativeOpenOptions): Promise<void>;
  update(options: { skipSegments?: NativeOpenOptions['skipSegments']; nextEpisode?: NativeOpenOptions['nextEpisode']; title?: string; subtitle?: string; sources?: NativeSource[]; episodes?: NativeEpisodes | null }): Promise<void>;
  addSubtitles(options: { subtitles: NonNullable<NativeOpenOptions['subtitles']> }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setAudioTrack(options: { id: number }): Promise<void>;
  setSubtitleTrack(options: { id: number }): Promise<void>;
  setSubtitleDelay(options: { ms: number }): Promise<void>;
  getState(): Promise<{ open: boolean; mini?: boolean } & Partial<NativeEvents['state']>>;
  close(): Promise<void>;
  /** Réduit en vignette flottante ; `mini` indique si la vignette est affichée (faux : non pris en charge, p. ex. télévision). */
  minimize(): Promise<{ mini: boolean }>;
  /** Agrandit la vignette en plein écran. */
  expand(): Promise<{ mini: boolean }>;
  /** Couche sociale. Optionnelle : un APK ancien ne la connaît pas, l'appel est alors refusé sans effet. */
  setSocial?(options: NativeSocial): Promise<void>;
  /** Remplace la liste complète des marqueurs. */
  setNotes?(options: { notes: NativeNote[] }): Promise<void>;
  /** Affiche une bulle de message entrant. */
  pushMessage?(options: NativeMessage): Promise<void>;
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
  return list.map((t) => ({ id: String(t.id), title: t.label, lang: trackLang(t.lang, t.label), codec: '', channels: 0, selected: t.selected, label: t.label }));
}

export function nativeSubtitleTracks(list: readonly NativeTrack[]): SubtitleTrack[] {
  return list.map((t): SubtitleTrack => ({
    id: String(t.id), title: t.label, lang: trackLang(t.lang, t.label), codec: '', forced: /forc/i.test(t.label), origin: 'embedded', renderable: true, engineId: t.id, selected: t.selected, label: t.label,
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

const GROUP_LABEL: Record<string, string> = { '2160p': '4K', '1440p': '2K', '1080p': '1080p', '720p': '720p', SD: 'SD', other: 'Autres' };

interface SourceLike {
  index: number; group: string; playable?: boolean; sizeLabel?: string; bitrateLabel?: string;
  quality?: string; sourceType?: string; codec?: string; audio?: string; hdr?: string[];
  langs?: Array<{ label: string; verified: boolean }>;
  filename?: string; releaseGroup?: string; status?: SourceStatus; statusLabel?: string; provider?: string;
  origins?: Array<{ name: string }>; copies?: number;
}

/**
 * Sources du lecteur natif : libellé et détail déjà composés par la session (`line`, `origins`), groupés par qualité ;
 * les champs structurés de la carte web partent en plus. Un champ vide est omis (forme historique pour une source sans détail).
 */
export function toNativeSources<V extends SourceLike>(views: readonly V[], currentIndex: number | null, line: (v: V) => string, origins: (v: V) => string): NativeSource[] {
  return views.filter((v) => v.playable !== false).map((v) => {
    const langs = (v.langs ?? []).map((l) => ({ label: l.label, verified: !!l.verified }));
    const names = (v.origins ?? []).map((o) => o.name);
    return {
      id: String(v.index),
      label: line(v),
      detail: [v.sizeLabel, v.bitrateLabel, origins(v)].filter(Boolean).join(' · '),
      current: v.index === currentIndex,
      group: GROUP_LABEL[v.group] ?? 'Autres',
      quality: v.quality || undefined,
      sourceType: v.sourceType || undefined,
      codec: v.codec || undefined,
      audio: v.audio || undefined,
      hdr: v.hdr?.length ? v.hdr : undefined,
      langs: langs.length ? langs : undefined,
      size: v.sizeLabel || undefined,
      bitrate: v.bitrateLabel || undefined,
      release: v.filename || undefined,
      releaseGroup: v.releaseGroup || undefined,
      status: v.status || undefined,
      statusLabel: v.statusLabel || undefined,
      provider: v.provider || undefined,
      origins: names.length ? names : undefined,
      copies: (v.copies ?? 0) > 1 ? v.copies : undefined,
    };
  });
}

interface EpisodeLike { episode: number; name?: string; runtime?: number | null; still?: string; aired?: boolean; playable?: boolean }

/** Épisodes du lecteur natif : toutes les saisons déjà chargées ; la saison affichée au démarrage est celle de l'épisode courant. */
export function toNativeEpisodes(
  seasons: ReadonlyArray<{ season: number; count: number }>,
  loaded: ReadonlyMap<number, readonly EpisodeLike[]>,
  cur: { season: number | null | undefined; episode: number | null | undefined },
  state: (season: number, episode: number) => { watched: boolean; progress: number },
): NativeEpisodes | null {
  if (!seasons.length && !loaded.size) return null;
  const items: NativeEpisode[] = [];
  loaded.forEach((list, season) => {
    list.forEach((e) => {
      const st = state(season, e.episode);
      items.push({
        season, episode: e.episode, title: e.name || '', still: e.still || undefined, durationMin: e.runtime || 0,
        watched: st.watched, progress: st.progress, current: season === cur.season && e.episode === cur.episode, aired: (e.playable ?? e.aired) !== false,
      });
    });
  });
  return {
    seasons: seasons.map((s) => ({ number: s.season, name: 'Saison ' + s.season })),
    currentSeason: cur.season ?? seasons[0]?.season ?? 1,
    items,
  };
}
