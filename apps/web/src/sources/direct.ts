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

export function videoCodecOf(info: LastStreamInfo | null, text: string): string[] | null {
  const src = (info?.codec && info.codec !== 'unknown' ? info.codec : '') + ' ' + text;
  for (const [re, names] of VIDEO_CODEC) if (re.test(src)) return names;
  return null;
}

export function audioCodecOf(info: LastStreamInfo | null, text: string): string | null {
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

/**
 * Lecture directe si conteneur, vidéo et audio sont pris en charge par le navigateur ; conversion si l'un d'eux ne l'est
 * pas (HEVC, DTS, TrueHD, REMUX, trop de canaux) ; inconnu quand les métadonnées ne permettent pas de trancher.
 */
export function webPlayback(stream: Stream, info: LastStreamInfo | null, caps: MediaCaps): WebPlayback {
  const hints = stream.behaviorHints ?? {};
  const name = String(hints.filename ?? info?.filename ?? stream.url ?? '');
  const text = [name, stream.description, stream.title].filter((x) => typeof x === 'string').join(' ');
  if (/remux/i.test(text) || /remux/i.test(info?.source ?? '')) return 'convert';
  const ext = containerOf(name);
  const containerKnown = ext !== '';
  if (containerKnown) {
    const ok = ext === 'mp4' || ext === 'm4v' || ext === 'webm' || ((ext === 'mkv') && caps.formats.some((f) => f.includes('matroska')));
    if (!ok) return 'convert';
  }
  const vids = videoCodecOf(info, text);
  if (vids && !vids.some((v) => caps.videoCodecs.includes(v))) return 'convert';
  const aud = audioCodecOf(info, text);
  if (aud && !caps.audioCodecs.includes(aud)) return 'convert';
  const ch = channelsOf(info, text);
  if (ch !== null && ch > caps.maxAudioChannels) return 'convert';
  if (hints.notWebReady === true && !vids && !aud) return 'convert';
  // Il faut au moins un indice de codec ou de conteneur pour affirmer que c'est lisible.
  return vids || aud || containerKnown ? 'direct' : 'unknown';
}
