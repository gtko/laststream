import type { MediaCaps, Probe } from './server';

/* Choix du moteur de lecture : mpv (coque Windows), lecture directe HTML5, ou HLS via le serveur de streaming.
 * Logique pure (capacités du navigateur injectées), testée. */

export type EngineKind = 'mpv' | 'direct' | 'hls';

export interface EngineChoice {
  engine: EngineKind;
  /** Passe par le serveur de streaming (torrent, transcodage). */
  viaServer: boolean;
  /** Phrase courte pour l'écran de chargement et la fiche d'infos. */
  label: string;
  reason: string;
}

export interface EngineInput {
  /** Fichier torrent (infoHash) servi par le serveur de streaming. */
  torrent: boolean;
  shell: boolean;
  serverUp: boolean;
  probe: Probe | null;
  caps: MediaCaps;
  /** Indice de l'addon : HEVC / REMUX / DTS / TrueHD. */
  notWebReady: boolean;
  /** Nom de fichier ou URL, pour l'extension quand il n'y a pas de probe. */
  name: string;
  forceTranscoding?: boolean;
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
export function canPlayProbe(probe: Probe, caps: MediaCaps): boolean {
  const format = probe.format?.name ?? '';
  const formatOk = caps.formats.some((f) => format.includes(f));
  const streamsOk = probe.streams.every((s) => {
    if (s.track === 'audio') return (s.channels ?? 2) <= caps.maxAudioChannels && inList(caps.audioCodecs, s.codec);
    if (s.track === 'video') return inList(caps.videoCodecs, s.codec);
    return true;
  });
  const hasSubs = probe.streams.some((s) => s.track === 'subtitle');
  const playableAudio = probe.streams.filter((s) => s.track === 'audio' && inList(caps.audioCodecs, s.codec));
  return formatOk && streamsOk && !hasSubs && playableAudio.length < 2;
}

/** Sans probe : extension du fichier + indice de l'addon. */
export function guessWebPlayable(name: string, notWebReady: boolean): boolean {
  if (notWebReady) return false;
  const clean = name.split('?')[0].split('#')[0];
  return /\.(mp4|m4v|webm)$/i.test(clean);
}

export function chooseEngine(i: EngineInput): EngineChoice {
  if (i.shell) {
    return { engine: 'mpv', viaServer: i.torrent, label: 'mpv (application Windows)' + (i.torrent ? ' · torrent' : ''), reason: 'Coque Windows détectée : mpv lit tous les formats.' };
  }
  const playable = i.forceTranscoding ? false : i.probe ? canPlayProbe(i.probe, i.caps) : guessWebPlayable(i.name, i.notWebReady);
  if (playable || !i.serverUp) {
    const t = i.torrent ? 'Torrent · ' : '';
    return {
      engine: 'direct', viaServer: i.torrent, label: t + 'lecture directe',
      reason: playable ? 'Fichier lisible par le navigateur.' : 'Serveur de streaming absent : lecture directe tentée.',
    };
  }
  return {
    engine: 'hls', viaServer: true, label: (i.torrent ? 'Torrent · ' : '') + 'transcodage HLS',
    reason: i.probe ? 'Codecs, pistes audio ou sous-titres non gérés par le navigateur.' : 'Format incertain : transcodage par le serveur.',
  };
}

/** Capacités du navigateur d'après `canPlayType` (injecté pour les tests). */
export function detectCaps(canPlayType: (mime: string) => string, opts: { chromium: boolean; maxChannels: number }): MediaCaps {
  const ok = (mime: string): boolean => !!canPlayType(mime);
  const videoCodecs: string[] = [];
  if (opts.chromium || ok('video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
  if (ok('video/mp4; codecs="hev1.1.6.L150.B0"')) videoCodecs.push('h265', 'hevc');
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
  const formats = ['mp4'];
  if (opts.chromium) formats.push('matroska,webm', 'webm');
  return { formats, videoCodecs: [...new Set(videoCodecs)], audioCodecs: [...new Set(audioCodecs)], maxAudioChannels: opts.maxChannels };
}
