/**
 * Sonde média distante : lit l'en-tête d'un fichier (requêtes Range) pour en extraire les pistes audio et de
 * sous-titres, sans télécharger le fichier. Conteneurs : MKV/WebM (EBML) et MP4/MOV (ftyp).
 *
 * Requêtes :
 * 1. bytes=0-(rangeBytes-1) : en-tête. Si MKV, lecture complète. Si MP4 et moov absent de cette zone, une seule
 *    requête complémentaire : le moov est lu à l'offset exact qu'indique la chaîne des boîtes (fin de la boîte
 *    qui dépasse la zone), sur tailBytes octets. Le moov tronqué en début de zone est relu à partir de son offset.
 *
 * Sécurité : les requêtes passent par fetchBytes (schéma http(s), redirections revalidées, au plus MAX_REDIRECTS)
 * avec un agent au DNS épinglé : une adresse non publique, y compris atteinte par redirection ou par rebinding,
 * est refusée à la connexion. Les URL ne sont jamais journalisées ni incluses dans les erreurs.
 *
 * Limite : un serveur qui ignore l'en-tête Range renvoie 200 avec le fichier entier ; au-delà de la taille lue,
 * la sonde échoue (null) plutôt que de tout télécharger.
 */

import type { Agent } from 'undici';
import { type FetchFn, createPinnedAgent, fetchBytes } from '../sources/http.js';
import { type MkvProbe, isEbml, parseMkv } from './ebml.js';
import { type Mp4Info, isMp4Head, parseMoov, scanTopLevelBoxes } from './mp4.js';
import {
  type AudioTrack,
  type SubtitleTrack,
  buildAudioTrack,
  detectAtmos,
  mkvCodecName,
  mp4CodecName,
  normalizeLanguageTag,
} from './tracks.js';

/** Options de la sonde. Toutes optionnelles. */
export interface ProbeOptions {
  /** Fetch injectable (défaut : fetch global, résolu à chaque appel). */
  fetch?: FetchFn;
  /** Taille de la première lecture (en-tête), en octets. Défaut : 3 Mo. */
  rangeBytes?: number;
  /** Taille de la lecture de moov quand elle est nécessaire, en octets. Défaut : 2 Mo. */
  tailBytes?: number;
  /** Délai par requête, en millisecondes. Défaut : 4000. */
  timeoutMs?: number;
}

/** Résultat d'une sonde réussie. */
export interface MediaProbe {
  container: 'mkv' | 'mp4';
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  durationSec?: number;
}

const DEFAULT_RANGE_BYTES = 3_000_000;
const DEFAULT_TAIL_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 4000;

/** Agent au DNS épinglé, créé à la première sonde. */
let agent: Agent | undefined;

function probeDispatcher(): Agent {
  agent ??= createPinnedAgent();
  return agent;
}

/** Lit les octets [start, start + length) de l'URL. Refuse tout statut qui ne garantit pas l'offset demandé. */
async function readRange(
  fetchFn: FetchFn,
  url: string,
  start: number,
  length: number,
  timeoutMs: number,
): Promise<Buffer> {
  const headers = { Range: `bytes=${start}-${start + length - 1}`, 'Accept-Encoding': 'identity' };
  const result = await fetchBytes(fetchFn, url, { headers }, timeoutMs, {
    maxBytes: length,
    dispatcher: probeDispatcher(),
  });
  const offsetHonored = result.status === 206 || (result.status === 200 && start === 0);
  if (!offsetHonored) throw new Error('plage non servie');
  return Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
}

/** Pistes MKV vers pistes audio et sous-titres. Renvoie null si aucune piste n'a été lue. */
function fromMkv(probe: MkvProbe): MediaProbe | null {
  if (probe.tracks.length === 0) return null;
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const track of probe.tracks) {
    if (track.type === 'audio') {
      const codec = mkvCodecName(track.codecId, track.name);
      audio.push(
        buildAudioTrack({
          language: track.languageIetf ?? track.language,
          codec,
          channels: track.channels,
          name: track.name,
          atmos: detectAtmos(codec, track.name),
        }),
      );
    } else if (track.type === 'subtitle') {
      const lang = normalizeLanguageTag(track.languageIetf ?? track.language);
      subtitles.push(track.name ? { lang, name: track.name } : { lang });
    }
  }
  return withDuration({ container: 'mkv', audio, subtitles }, probe.durationSec);
}

/** Infos moov vers pistes audio et sous-titres. Renvoie null si aucune piste n'a été lue. */
function fromMp4(info: Mp4Info): MediaProbe | null {
  if (info.tracks.length === 0) return null;
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const track of info.tracks) {
    if (track.handler === 'soun') {
      audio.push(buildAudioTrack({ language: track.language, codec: mp4CodecName(track.codec), channels: track.channels }));
    } else if (track.handler === 'subt' || track.handler === 'text' || track.handler === 'sbtl') {
      subtitles.push({ lang: normalizeLanguageTag(track.language) });
    }
  }
  return withDuration({ container: 'mp4', audio, subtitles }, info.durationSec);
}

function withDuration(probe: Omit<MediaProbe, 'durationSec'>, durationSec: number | undefined): MediaProbe {
  return durationSec === undefined ? probe : { ...probe, durationSec };
}

/**
 * Lit le moov d'un MP4. Renvoie undefined si le moov est introuvable. Une seule requête complémentaire au plus
 * pour le cas « moov en fin de fichier ».
 */
async function readMp4Info(
  read: (start: number, length: number) => Promise<Buffer>,
  head: Buffer,
  tailBytes: number,
): Promise<Mp4Info | undefined> {
  const scan = scanTopLevelBoxes(head);
  if (scan.moov !== undefined) {
    if (scan.moov.complete) return parseMoov(head.subarray(scan.moov.offset));
    // moov commencé dans l'en-tête mais coupé : on relit la boîte depuis son offset.
    const length = scan.moov.size > 0 ? Math.min(scan.moov.size, tailBytes) : tailBytes;
    return parseMoov(await read(scan.moov.offset, length));
  }
  if (scan.nextOffset === undefined) return undefined;
  const tail = await read(scan.nextOffset, tailBytes);
  const tailScan = scanTopLevelBoxes(tail, scan.nextOffset);
  if (tailScan.moov === undefined) return undefined;
  return parseMoov(tail.subarray(tailScan.moov.offset - scan.nextOffset));
}

/**
 * Sonde un fichier média distant à partir de son URL. Renvoie null en cas d'échec (format non reconnu, réseau,
 * délai, plage non servie, cible non publique, aucune piste lue). Ne lève jamais d'exception.
 */
export async function probeMedia(url: string, options: ProbeOptions = {}): Promise<MediaProbe | null> {
  const fetchFn = options.fetch ?? fetch;
  const rangeBytes = options.rangeBytes ?? DEFAULT_RANGE_BYTES;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const head = await readRange(fetchFn, url, 0, rangeBytes, timeoutMs);
    if (isEbml(head)) return fromMkv(parseMkv(head));
    if (!isMp4Head(head)) return null;
    const read = (start: number, length: number): Promise<Buffer> =>
      readRange(fetchFn, url, start, length, timeoutMs);
    const info = await readMp4Info(read, head, tailBytes);
    return info === undefined ? null : fromMp4(info);
  } catch {
    return null;
  }
}
