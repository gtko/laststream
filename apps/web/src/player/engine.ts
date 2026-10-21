import type { MediaCaps, Probe } from './server';
import { trackLang } from './tracks';

/* Toute lecture passe par un lien HTTPS (débrideur ou lien direct d'un addon) : aucun moteur torrent.
 * Choix du moteur de lecture : lecteur natif Android (libVLC), mpv (coque Windows), lecture directe HTML5, ou HLS via le serveur de streaming.
 * Logique pure (capacités du navigateur injectées), testée. */

type EngineKind = 'mpv' | 'native' | 'direct' | 'hls';

export interface EngineChoice {
  engine: EngineKind;
  /** Passe par le serveur de streaming : uniquement le transcodage HLS d'un lien HTTPS débridé (jamais de torrent). */
  viaServer: boolean;
  /** Phrase courte pour l'écran de chargement et la fiche d'infos. */
  label: string;
  reason: string;
  /** Lecture hors ligne que le navigateur ne peut pas assurer (conteneur) : la session affiche ce message au lieu de lancer la lecture. */
  unsupported?: string;
}

export interface EngineInput {
  shell: boolean;
  /** Application Android : le lecteur natif (libVLC) lit tous les formats. */
  native?: boolean;
  serverUp: boolean;
  probe: Probe | null;
  caps: MediaCaps;
  /** Indice de l'addon : HEVC / REMUX / DTS / TrueHD. */
  notWebReady: boolean;
  /** Nom de fichier ou URL, pour l'extension quand il n'y a pas de probe. */
  name: string;
  forceTranscoding?: boolean;
  /** Langue audio souhaitée (code à deux lettres). */
  preferredLang?: string;
  /** `video.audioTracks` existe : le navigateur peut changer de piste en lecture directe. */
  audioTracksSupported?: boolean;
  /** Fichier téléchargé lu depuis cet appareil (ODY-203) : aucun serveur de streaming, aucun transcodage. */
  local?: { name: string; container?: string };
}

export interface PlayOptions {
  preferredLang?: string;
  audioTracksSupported?: boolean;
}

/** Équivalences de noms de codecs (ffprobe → capacités du navigateur). */
const ALIASES: Record<string, string[]> = { h264: ['h264', 'avc'], h265: ['h265', 'hevc'], hevc: ['hevc', 'h265'], eac3: ['eac3', 'ec3'], av1: ['av1'] };
const inList = (list: readonly string[], codec: string | undefined): boolean => {
  const c = (codec ?? '').toLowerCase();
  return (ALIASES[c] ?? [c]).some((a) => list.includes(a));
};

/**
 * Le navigateur peut-il lire ce fichier tel quel ? Même règle que stremio-video : format conteneur et codecs
 * pris en charge, pas de sous-titres embarqués, et au plus une piste audio lisible (HTML5 ne change pas de piste).
 */
export function canPlayProbe(probe: Probe, caps: MediaCaps, opts: PlayOptions = {}): boolean {
  const format = probe.format?.name ?? '';
  const formatOk = caps.formats.some((f) => format.includes(f));
  const audioOk = (s: { channels?: number; codec?: string }): boolean => (s.channels ?? 2) <= caps.maxAudioChannels && inList(caps.audioCodecs, s.codec);
  const streamsOk = probe.streams.every((s) => {
    if (s.track === 'audio') return audioOk(s);
    if (s.track === 'video') return inList(caps.videoCodecs, s.codec);
    return true;
  });
  const hasSubs = probe.streams.some((s) => s.track === 'subtitle');
  const audios = probe.streams.filter((s) => s.track === 'audio');
  const playableAudio = audios.filter((s) => inList(caps.audioCodecs, s.codec));
  // Sans API de pistes audio, HTML5 ne peut pas changer de langue : plusieurs pistes lisibles imposent le HLS.
  if (!opts.audioTracksSupported && playableAudio.length >= 2) return false;
  // Une piste dans la langue souhaitée, qui n'est pas celle par défaut du fichier : seule la lecture directe avec
  // `audioTracks` (ou le transcodage) permet de l'atteindre.
  if (audios.length >= 2 && opts.preferredLang) {
    const want = audios.findIndex((s) => trackLang(s.language ?? s.lang, s.title) === opts.preferredLang);
    if (want > 0 && !(opts.audioTracksSupported && audioOk(audios[want]))) return false;
  }
  return formatOk && streamsOk && !hasSubs;
}

/** Sans probe : extension du fichier + indice de l'addon. */
export function guessWebPlayable(name: string, notWebReady: boolean): boolean {
  if (notWebReady) return false;
  const clean = name.split('?')[0].split('#')[0];
  return /\.(mp4|m4v|webm)$/i.test(clean);
}

/** Extensions de conteneur lues par `<video>` sans conversion (les codecs se vérifient à la lecture). */
const WEB_LOCAL_CONTAINERS = ['mp4', 'm4v', 'mov', 'webm'];

/**
 * Un fichier téléchargé peut-il être lu par le navigateur (lecture hors ligne, sans sonde ni serveur) ? Seul le conteneur se juge d'avance :
 * MKV seulement pour les navigateurs Chromium ; les autres (AVI, TS…) jamais. Les codecs (HEVC…) se révèlent au chargement du fichier.
 */
export function localWebVerdict(container: string, caps: MediaCaps): { ok: true } | { ok: false; reason: string } {
  const c = container.toLowerCase();
  if (!c || WEB_LOCAL_CONTAINERS.includes(c)) return { ok: true };
  if (c === 'mkv' && caps.formats.includes('matroska,webm')) return { ok: true };
  return { ok: false, reason: 'Ce navigateur ne lit pas les fichiers ' + c.toUpperCase() + '.' };
}

export function chooseEngine(i: EngineInput): EngineChoice {
  if (i.native) {
    return { engine: 'native', viaServer: false, label: 'libVLC (lecteur natif Android)', reason: 'Application Android : le lecteur natif lit tous les formats (HEVC, AV1, DTS, TrueHD, AC3, EAC3).' };
  }
  if (i.shell) {
    return { engine: 'mpv', viaServer: false, label: 'mpv (application Windows)', reason: 'Coque Windows détectée : mpv lit tous les formats.' };
  }
  if (i.local) {
    const v = localWebVerdict(i.local.container || (/\.([a-z0-9]{2,5})$/i.exec(i.local.name)?.[1] ?? ''), i.caps);
    const label = 'lecture hors ligne';
    return v.ok
      ? { engine: 'direct', viaServer: false, label, reason: 'Fichier téléchargé, lu depuis cet appareil.' }
      : { engine: 'direct', viaServer: false, label, reason: v.reason, unsupported: v.reason };
  }
  const playable = i.forceTranscoding ? false : i.probe ? canPlayProbe(i.probe, i.caps, { preferredLang: i.preferredLang, audioTracksSupported: i.audioTracksSupported }) : guessWebPlayable(i.name, i.notWebReady);
  if (playable || !i.serverUp) {
    return {
      engine: 'direct', viaServer: false, label: 'lecture directe',
      reason: playable ? 'Fichier lisible par le navigateur.' : 'Serveur de streaming absent : lecture directe tentée.',
    };
  }
  return {
    engine: 'hls', viaServer: true, label: 'transcodage HLS',
    reason: i.probe ? 'Codecs, pistes audio ou sous-titres non gérés par le navigateur.' : 'Format incertain : transcodage par le serveur.',
  };
}

/** Capacités du navigateur d'après `canPlayType` (injecté pour les tests). */
export function detectCaps(canPlayType: (mime: string) => string, opts: { chromium: boolean; maxChannels: number }): MediaCaps {
  const ok = (mime: string): boolean => !!canPlayType(mime);
  const videoCodecs: string[] = [];
  if (opts.chromium || ok('video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
  // HEVC : Chrome / Edge l'annoncent quand le matériel le décode (hvc1 ou hev1 selon le fichier).
  if (['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'hvc1.1.6.L120.B0', 'hev1.1.6.L150.B0'].some((c) => ok('video/mp4; codecs="' + c + '"'))) videoCodecs.push('h265', 'hevc');
  if (ok('video/mp4; codecs="vp9"') || ok('video/webm; codecs="vp9"')) videoCodecs.push('vp9');
  if (ok('video/mp4; codecs="vp8"') || ok('video/webm; codecs="vp8"')) videoCodecs.push('vp8');
  if (ok('video/mp4; codecs="av01.0.05M.08"')) videoCodecs.push('av1');
  const audioCodecs: string[] = [];
  const a = (codec: string, mime: string): void => { if (ok(mime)) audioCodecs.push(codec); };
  a('aac', 'audio/mp4; codecs="mp4a.40.2"');
  a('mp3', 'audio/mp4; codecs="mp3"');
  a('ac3', 'audio/mp4; codecs="ac-3"');
  a('eac3', 'audio/mp4; codecs="ec-3"');
  a('vorbis', 'audio/mp4; codecs="vorbis"');
  a('opus', 'audio/mp4; codecs="opus"');
  a('flac', 'audio/mp4; codecs="flac"');
  const formats = ['mp4'];
  if (opts.chromium) formats.push('matroska,webm', 'webm');
  // Dolby annoncé par le navigateur lui-même (MSE puis canPlayType) : Edge sous Windows, Safari. Un navigateur qui ment là-dessus
  // est repris par la surveillance du compteur d'octets (voir webaudio/controller).
  const dolbyNative = ok('audio/mp4; codecs="ac-3"') || ok('audio/mp4; codecs="ec-3"');
  return { formats, videoCodecs: [...new Set(videoCodecs)], audioCodecs: [...new Set(audioCodecs)], maxAudioChannels: opts.maxChannels, dolbyNative };
}

export type ConversionKind = 'none' | 'audio' | 'video' | 'unknown';

/**
 * Travail du serveur de streaming pour une session HLS (selon les paramètres `videoCodecs` / `audioCodecs` / `maxAudioChannels`) :
 * `none` copie tout (remux), `audio` copie la vidéo et convertit l'audio, `video` réencode la vidéo, `unknown` sans sonde.
 */
export function probeConversion(probe: Probe | null, caps: MediaCaps, forced = false): ConversionKind {
  if (forced) return 'video';
  if (!probe) return 'unknown';
  const videoBad = probe.streams.some((s) => s.track === 'video' && !inList(caps.videoCodecs, s.codec));
  if (videoBad) return 'video';
  const audioBad = probe.streams.some((s) => s.track === 'audio' && !((s.channels ?? 2) <= caps.maxAudioChannels && inList(caps.audioCodecs, s.codec)));
  return audioBad ? 'audio' : 'none';
}

export const CONVERSION_LABEL: Record<ConversionKind, string> = {
  none: 'Remux seul (aucune conversion)', audio: 'Conversion audio seulement', video: 'Conversion vidéo (réencodage)', unknown: 'Inconnue',
};

/**
 * La vidéo passe telle quelle dans le navigateur (conteneur et codec vidéo pris en charge, au moins une piste audio lisible) :
 * seule la piste audio ou les sous-titres demandent alors le transcodage. Sert au démarrage rapide.
 */
export function directVideoOk(probe: Probe | null, caps: MediaCaps): boolean {
  if (!probe) return false;
  const formatOk = caps.formats.some((f) => (probe.format?.name ?? '').includes(f));
  const videos = probe.streams.filter((s) => s.track === 'video');
  const audios = probe.streams.filter((s) => s.track === 'audio');
  const audioOk = audios.length === 0 || audios.some((s) => (s.channels ?? 2) <= caps.maxAudioChannels && inList(caps.audioCodecs, s.codec));
  return formatOk && videos.length > 0 && videos.every((s) => inList(caps.videoCodecs, s.codec)) && audioOk;
}
