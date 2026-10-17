/**
 * Parseur EBML minimal pour MKV/WebM : lit Segment > Info (durée) et Segment > Tracks > TrackEntry.
 *
 * - Tolérant à la troncature : seules les pistes entièrement présentes dans le buffer sont renvoyées.
 * - Tailles inconnues (VINT à tous les bits à 1, ex. 0x01FFFFFFFFFFFFFF) gérées pour Segment et Cluster.
 * - SeekHead, Cues, Void, Tags… sont sautés. La lecture s'arrête au premier Cluster (données média).
 * - Fonction pure : aucune E/S, aucune journalisation.
 */

/** Magic EBML (en-tête de tout fichier Matroska/WebM). */
export const EBML_MAGIC = 0x1a45dfa3;

/** Type de piste Matroska, réduit aux catégories utiles. */
export type MkvTrackType = 'video' | 'audio' | 'subtitle' | 'other';

/** Drapeaux de piste Matroska. Valeurs par défaut selon la spécification. */
export interface MkvTrackFlags {
  enabled: boolean;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  original: boolean;
  commentary: boolean;
}

/** Piste lue dans un TrackEntry (langue encore brute : ISO 639-2 et BCP 47 telles que stockées). */
export interface MkvTrack {
  number: number;
  type: MkvTrackType;
  codecId: string;
  name?: string;
  /** Element Language (ISO 639-2). 'eng' si absent, valeur par défaut de Matroska. */
  language: string;
  /** Element LanguageBCP47 (ex. 'fr-CA'). Prioritaire sur `language` quand il est présent. */
  languageIetf?: string;
  /** Nombre de canaux (Audio > Channels). */
  channels?: number;
  flags: MkvTrackFlags;
}

/** Résultat du parseur MKV. */
export interface MkvProbe {
  tracks: MkvTrack[];
  /** Durée en secondes (Info > Duration × TimecodeScale), si présente. */
  durationSec?: number;
}

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecId: 0x86,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBcp47: 0x22b59d,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagHearingImpaired: 0x55ab,
  FlagOriginal: 0x55ae,
  FlagCommentary: 0x55af,
  Audio: 0xe1,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
} as const;

/** Valeur par défaut de TimecodeScale (1 ms, en nanosecondes). */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

const TRACK_TYPES: ReadonlyMap<number, MkvTrackType> = new Map([
  [1, 'video'],
  [2, 'audio'],
  [17, 'subtitle'],
]);

/** Vrai si le buffer commence par le magic EBML (MKV/WebM). */
export function isEbml(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32BE(0) === EBML_MAGIC;
}

/** VINT lu à une position donnée. */
interface Vint {
  value: number;
  length: number;
  /** Taille inconnue (tous les bits de valeur à 1). Ne concerne que les tailles. */
  unknown: boolean;
}

/**
 * Lit un VINT. Pour un identifiant, le marqueur de longueur est conservé ; pour une taille, il est retiré.
 * Renvoie undefined si le VINT est invalide ou dépasse `limit`.
 */
function readVint(buf: Buffer, pos: number, limit: number, isId: boolean): Vint | undefined {
  if (pos >= limit) return undefined;
  const first = buf[pos] ?? 0;
  if (first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (pos + length > limit) return undefined;
  const valueMask = 0xff >> length;
  let value = isId ? first : first & valueMask;
  let allOnes = (first & valueMask) === valueMask;
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !isId && allOnes };
}

/** En-tête d'élément : identifiant, bornes des données. `dataEnd` peut dépasser la limite (troncature). */
interface Element {
  id: number;
  dataStart: number;
  dataEnd: number;
  unknownSize: boolean;
}

function readElement(buf: Buffer, pos: number, limit: number): Element | undefined {
  const id = readVint(buf, pos, limit, true);
  if (id === undefined) return undefined;
  const size = readVint(buf, pos + id.length, limit, false);
  if (size === undefined) return undefined;
  const dataStart = pos + id.length + size.length;
  return {
    id: id.value,
    dataStart,
    dataEnd: size.unknown ? limit : dataStart + size.value,
    unknownSize: size.unknown,
  };
}

/**
 * Énumère les éléments consécutifs de [start, end). S'arrête à un en-tête invalide, à un élément tronqué
 * (dataEnd > end) ou à un élément de taille inconnue (sa fin ne peut pas être déterminée).
 */
function* elements(buf: Buffer, start: number, end: number): Generator<Element> {
  let pos = start;
  while (pos < end) {
    const element = readElement(buf, pos, end);
    if (element === undefined) return;
    yield element;
    if (element.unknownSize || element.dataEnd > end) return;
    pos = element.dataEnd;
  }
}

function readUint(buf: Buffer, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + (buf[i] ?? 0);
  return value;
}

/** Chaîne UTF-8 sans octets nuls de fin de remplissage. */
function readString(buf: Buffer, start: number, end: number): string {
  let stop = end;
  while (stop > start && buf[stop - 1] === 0) stop--;
  return buf.toString('utf8', start, stop).trim();
}

function readFloat(buf: Buffer, start: number, end: number): number | undefined {
  if (end - start === 4) return buf.readFloatBE(start);
  if (end - start === 8) return buf.readDoubleBE(start);
  return undefined;
}

function parseTrackEntry(buf: Buffer, start: number, end: number): MkvTrack {
  const track: MkvTrack = {
    number: 0,
    type: 'other',
    codecId: '',
    language: 'eng',
    flags: { enabled: true, default: true, forced: false, hearingImpaired: false, original: false, commentary: false },
  };
  for (const el of elements(buf, start, end)) {
    if (el.dataEnd > end) break;
    const dataStart = el.dataStart;
    const dataEnd = el.dataEnd;
    switch (el.id) {
      case ID.TrackNumber:
        track.number = readUint(buf, dataStart, dataEnd);
        break;
      case ID.TrackType:
        track.type = TRACK_TYPES.get(readUint(buf, dataStart, dataEnd)) ?? 'other';
        break;
      case ID.CodecId:
        track.codecId = readString(buf, dataStart, dataEnd);
        break;
      case ID.Name:
        track.name = readString(buf, dataStart, dataEnd);
        break;
      case ID.Language:
        track.language = readString(buf, dataStart, dataEnd) || 'eng';
        break;
      case ID.LanguageBcp47: {
        const tag = readString(buf, dataStart, dataEnd);
        if (tag) track.languageIetf = tag;
        break;
      }
      case ID.FlagEnabled:
        track.flags.enabled = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.FlagDefault:
        track.flags.default = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.FlagForced:
        track.flags.forced = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.FlagHearingImpaired:
        track.flags.hearingImpaired = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.FlagOriginal:
        track.flags.original = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.FlagCommentary:
        track.flags.commentary = readUint(buf, dataStart, dataEnd) !== 0;
        break;
      case ID.Audio:
        for (const child of elements(buf, dataStart, dataEnd)) {
          if (child.id === ID.Channels && child.dataEnd <= dataEnd) {
            track.channels = readUint(buf, child.dataStart, child.dataEnd);
          }
        }
        break;
      default:
        break;
    }
  }
  return track;
}

/** Parcourt un élément Tracks : chaque TrackEntry complet est lu, un TrackEntry tronqué est ignoré. */
function parseTracks(buf: Buffer, start: number, end: number, tracks: MkvTrack[]): void {
  for (const el of elements(buf, start, end)) {
    if (el.id === ID.TrackEntry && !el.unknownSize && el.dataEnd <= end) {
      tracks.push(parseTrackEntry(buf, el.dataStart, el.dataEnd));
    }
  }
}

/** Lit Info (TimecodeScale, Duration). Un Info tronqué est ignoré. */
function parseInfo(buf: Buffer, start: number, end: number): { timecodeScale: number; duration?: number } {
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let duration: number | undefined;
  for (const el of elements(buf, start, end)) {
    if (el.dataEnd > end) break;
    if (el.id === ID.TimecodeScale) timecodeScale = readUint(buf, el.dataStart, el.dataEnd) || DEFAULT_TIMECODE_SCALE;
    if (el.id === ID.Duration) duration = readFloat(buf, el.dataStart, el.dataEnd);
  }
  return { timecodeScale, duration };
}

/**
 * Parse le début d'un fichier MKV/WebM. Renvoie les pistes complètement lues (aucune exception pour un buffer
 * tronqué ou invalide : tableau vide). La durée n'est renvoyée que si Info est complet.
 */
export function parseMkv(buf: Buffer): MkvProbe {
  const tracks: MkvTrack[] = [];
  let info: { timecodeScale: number; duration?: number } = { timecodeScale: DEFAULT_TIMECODE_SCALE };
  let infoComplete = false;
  for (const top of elements(buf, 0, buf.length)) {
    if (top.id !== ID.Segment) {
      continue;
    }
    const segmentEnd = top.unknownSize ? buf.length : Math.min(top.dataEnd, buf.length);
    for (const el of elements(buf, top.dataStart, segmentEnd)) {
      if (el.id === ID.Cluster) break;
      if (el.id === ID.Info && el.dataEnd <= segmentEnd && !el.unknownSize) {
        info = parseInfo(buf, el.dataStart, el.dataEnd);
        infoComplete = true;
      } else if (el.id === ID.Tracks) {
        parseTracks(buf, el.dataStart, Math.min(el.dataEnd, segmentEnd), tracks);
      }
    }
    break;
  }
  const durationSec =
    infoComplete && info.duration !== undefined && info.duration > 0
      ? (info.duration * info.timecodeScale) / 1e9
      : undefined;
  return durationSec === undefined ? { tracks } : { tracks, durationSec };
}
