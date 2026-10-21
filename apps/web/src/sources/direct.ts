import type { MediaCaps } from '../player/server';
import type { LastStreamInfo, Stream } from '../data/stream';

/* Une source se lit-elle directement dans le navigateur, ou faut-il la convertir (serveur de streaming) ?
 * Décision d'après les métadonnées de lastAddon et le nom du fichier, comparées aux capacités réelles du navigateur. */

export type WebPlayback = 'direct' | 'convert' | 'unknown';

const VIDEO_CODEC: Array<[RegExp, string[]]> = [
  [/hevc|x265|h\.?265/i, ['h265', 'hevc']],
  [/av1/i, ['av1']],
  [/vp9/i, ['vp9']],
  [/avc|x264|h\.?264/i, ['h264']],
];

const AUDIO_CODEC: Array<[RegExp, string]> = [
  [/truehd/i, 'truehd'],
  [/dts/i, 'dts'],
  [/ddp|dd\+|e-?ac-?3/i, 'eac3'],
  [/\bdd\b|\bac-?3\b/i, 'ac3'],
  [/flac/i, 'flac'],
  [/opus/i, 'opus'],
  [/aac/i, 'aac'],
  [/mp3/i, 'mp3'],
];

function videoCodecOf(info: LastStreamInfo | null, text: string): string[] | null {
  const src = (info?.codec && info.codec !== 'unknown' ? info.codec : '') + ' ' + text;
  for (const [re, names] of VIDEO_CODEC) if (re.test(src)) return names;
  return null;
}

function audioCodecOf(info: LastStreamInfo | null, text: string): string | null {
  const src = (info?.audio ?? []).join(' ') + ' ' + text;
  for (const [re, name] of AUDIO_CODEC) if (re.test(src)) return name;
  return null;
}

function containerOf(name: string): string {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

function channelsOf(info: LastStreamInfo | null, text: string): number | null {
  const c = info?.channels ?? /\b([2578])[ .]([01])\b/.exec(text)?.slice(1, 3).join('.') ?? '';
  const m = /^(\d)\.(\d)$/.exec(c);
  return m ? Number(m[1]) + Number(m[2]) : null;
}

export type Conversion = 'none' | 'audio' | 'video' | 'unknown';

/**
 * Ce que le serveur de streaming devrait faire pour que le navigateur lise la source :
 *  - `none` : rien (lecture directe) ;
 *  - `audio` : copier la vidéo (remux) et ne convertir que l'audio ou le conteneur : léger ;
 *  - `video` : réencoder la vidéo (codec non pris en charge) : lent et coûteux ;
 *  - `unknown` : métadonnées insuffisantes.
 */
export function conversionOf(stream: Stream, info: LastStreamInfo | null, caps: MediaCaps): Conversion {
  const hints = stream.behaviorHints ?? {};
  const name = String(hints.filename ?? info?.filename ?? stream.url ?? '');
  const text = [name, stream.description, stream.title].filter((x) => typeof x === 'string').join(' ');
  const remux = /remux/i.test(text) || /remux/i.test(info?.source ?? '');
  const vids = videoCodecOf(info, text);
  if (vids && !vids.some((v) => caps.videoCodecs.includes(v))) return 'video';
  const ext = containerOf(name);
  let light = false;
  if (ext !== '' && !(ext === 'mp4' || ext === 'm4v' || ext === 'webm' || (ext === 'mkv' && caps.formats.some((f) => f.includes('matroska'))))) light = true;
  const aud = audioCodecOf(info, text);
  if (aud && !caps.audioCodecs.includes(aud)) light = true;
  const ch = channelsOf(info, text);
  if (ch !== null && ch > caps.maxAudioChannels) light = true;
  // Un REMUX porte presque toujours du DTS / TrueHD : la vidéo est copiée, l'audio converti.
  if (remux) light = true;
  if (light) return 'audio';
  if (hints.notWebReady === true && !vids && !aud) return 'audio';
  return vids || aud || ext !== '' ? 'none' : 'unknown';
}

/**
 * Son en lecture web sans serveur de streaming (voir player/webaudio) : `app` = le navigateur ne décode pas la piste (AC-3 / E-AC-3)
 * mais l'app la décode (moteur audio de repli, CORS permettant) ; `unsupported` = DTS / TrueHD, aucun décodeur : image sans son.
 * Null : rien de particulier (lecture directe, ou conversion pour une autre raison). Seulement quand la conversion est audio
 * seulement (la vidéo, elle, passe) et que le conteneur est lu par le navigateur.
 */
export type AppAudio = 'app' | 'unsupported' | null;

export function appAudioOf(stream: Stream, info: LastStreamInfo | null, caps: MediaCaps): AppAudio {
  if (conversionOf(stream, info, caps) !== 'audio') return null;
  const hints = stream.behaviorHints ?? {};
  const name = String(hints.filename ?? info?.filename ?? stream.url ?? '');
  const text = [name, stream.description, stream.title].filter((x) => typeof x === 'string').join(' ');
  const ext = containerOf(name);
  const containerOk = ext === '' || ext === 'mp4' || ext === 'm4v' || ext === 'webm' || (ext === 'mkv' && caps.formats.some((f) => f.includes('matroska')));
  if (!containerOk) return null;
  const aud = audioCodecOf(info, text);
  if (aud === 'dts' || aud === 'truehd') return 'unsupported';
  // Navigateur qui décode ce Dolby lui-même (Edge sous Windows, Safari) : rien à décoder, aucune source « sans son ».
  if (aud === 'ac3' || aud === 'eac3') return caps.dolbyNative && caps.audioCodecs.includes(aud) ? null : 'app';
  return null;
}

/** Extension du conteneur que le navigateur ne lit pas (« mkv » hors Chromium, « avi »…), ou chaîne vide s'il le lit ou si elle est inconnue. */
export function unreadableContainer(stream: Stream, info: LastStreamInfo | null, caps: MediaCaps): string {
  const hints = stream.behaviorHints ?? {};
  const ext = containerOf(String(hints.filename ?? info?.filename ?? stream.url ?? ''));
  const ok = ext === '' || ext === 'mp4' || ext === 'm4v' || ext === 'webm' || (ext === 'mkv' && caps.formats.some((f) => f.includes('matroska')));
  return ok ? '' : ext;
}

/** Lecture directe si conteneur, vidéo et audio sont pris en charge ; conversion sinon ; inconnu sans métadonnées. */
export function webPlayback(stream: Stream, info: LastStreamInfo | null, caps: MediaCaps): WebPlayback {
  const c = conversionOf(stream, info, caps);
  return c === 'none' ? 'direct' : c === 'unknown' ? 'unknown' : 'convert';
}
