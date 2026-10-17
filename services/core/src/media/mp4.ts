/**
 * Parseur MP4/MOV minimal : boîtes de premier niveau (ftyp, moov, mdat…) et, dans moov, mvhd, trak > mdia
 * (mdhd, hdlr) > minf > stbl > stsd. Tolérant à la troncature : une boîte coupée est lue dans la mesure de
 * ce qui est présent, et une boîte dont l'en-tête est incomplet est ignorée. Fonctions pures, sans E/S.
 */

/** Taille d'un en-tête de boîte standard (taille 32 bits + type). */
const HEADER = 8;

/** Boîte MP4 de premier niveau, vue depuis un buffer de début. Offsets absolus (base ajoutée). */
export interface MoovLocation {
  /** Offset absolu du début de la boîte moov (son en-tête). */
  offset: number;
  /** Taille déclarée. 0 = jusqu'à la fin du fichier (taille inconnue). */
  size: number;
  /** Vrai si la boîte entière est présente dans le buffer. */
  complete: boolean;
}

/** Résultat du scan des boîtes de premier niveau. */
export interface TopLevelScan {
  /** moov trouvé (complet ou tronqué). */
  moov?: MoovLocation;
  /**
   * Offset absolu du premier box de premier niveau situé après la zone lisible, quand le moov n'a pas été trouvé
   * et qu'il reste de la lecture à faire. Absent si la chaîne des boîtes ne permet pas de la localiser.
   */
  nextOffset?: number;
}

/** Vrai si le buffer contient une boîte ftyp en position 4 (MP4, MOV, 3GP…). */
export function isMp4Head(buf: Buffer): boolean {
  return buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp';
}

/**
 * Parcourt les boîtes de premier niveau d'un buffer qui commence à l'offset absolu `base`. Renvoie l'offset du
 * moov s'il est présent (même tronqué), sinon l'offset de la boîte suivante à lire, c'est-à-dire la fin de la
 * première boîte qui dépasse la zone lisible (mdat énorme, par exemple). Taille 1 (64 bits) prise en charge.
 */
export function scanTopLevelBoxes(buf: Buffer, base = 0): TopLevelScan {
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < HEADER) return { nextOffset: base + pos };
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = HEADER;
    if (size === 1) {
      if (buf.length - pos < 16) return { nextOffset: base + pos };
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    }
    if (size === 0) {
      // Boîte qui va jusqu'à la fin du fichier : rien ne vient après.
      return type === 'moov' ? { moov: { offset: base + pos, size: 0, complete: false } } : {};
    }
    if (size < header) return {};
    const end = pos + size;
    if (type === 'moov') {
      return { moov: { offset: base + pos, size, complete: end <= buf.length } };
    }
    if (end > buf.length) return { nextOffset: base + end };
    pos = end;
  }
  return { nextOffset: base + pos };
}

/** Offset absolu du moov présent dans un buffer de début, ou undefined si absent. */
export function findMoovOffset(buf: Buffer): number | undefined {
  return scanTopLevelBoxes(buf).moov?.offset;
}

/** Piste MP4 lue dans trak, avec langue et codec bruts (fourcc). */
export interface Mp4Track {
  /** Type de handler : soun (audio), vide (vidéo), subt, text, sbtl… */
  handler: string;
  /** Code ISO 639-2 décodé depuis mdhd ('und' si absent ou invalide). */
  language: string;
  /** Fourcc du premier sample entry (mp4a, ac-3, ec-3…). Chaîne vide si absent. */
  codec: string;
  /** Nombre de canaux (sample entry), pour l'audio. */
  channels?: number;
}

/** Résultat du parseur moov. */
export interface Mp4Info {
  tracks: Mp4Track[];
  /** Durée en secondes (mvhd duration / timescale), si lisible. */
  durationSec?: number;
}

/** Boîte vue dans un parent. `end` est borné à la limite de lecture ; `complete` indique l'absence de troncature. */
interface Box {
  type: string;
  payload: number;
  end: number;
  complete: boolean;
}

/** Énumère les boîtes consécutives de [start, limit). Une boîte tronquée est renvoyée puis l'énumération s'arrête. */
function* boxes(buf: Buffer, start: number, limit: number): Generator<Box> {
  let pos = start;
  while (pos + HEADER <= limit) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = HEADER;
    if (size === 1) {
      if (pos + 16 > limit) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = limit - pos;
    }
    if (size < header) return;
    const declaredEnd = pos + size;
    const complete = declaredEnd <= limit;
    yield { type, payload: pos + header, end: Math.min(declaredEnd, limit), complete };
    if (!complete) return;
    pos = declaredEnd;
  }
}

/** Premier enfant du type demandé. */
function child(buf: Buffer, parent: Box, type: string): Box | undefined {
  for (const box of boxes(buf, parent.payload, parent.end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** Entier 32 bits non signé à `pos`, si les 4 octets tiennent avant `end`. */
function uint32(buf: Buffer, pos: number, end: number): number | undefined {
  return pos + 4 <= end ? buf.readUInt32BE(pos) : undefined;
}

/** Durée en secondes d'un mvhd (version 0 : champs 32 bits, version 1 : 64 bits). */
function readDuration(buf: Buffer, box: Box): number | undefined {
  const version = buf[box.payload] ?? 0;
  const timescalePos = box.payload + (version === 1 ? 20 : 12);
  const timescale = uint32(buf, timescalePos, box.end);
  const durationPos = timescalePos + 4;
  if (timescale === undefined || timescale === 0) return undefined;
  let duration: number | undefined;
  if (version === 1) {
    if (durationPos + 8 <= box.end) duration = buf.readUInt32BE(durationPos) * 2 ** 32 + buf.readUInt32BE(durationPos + 4);
  } else {
    duration = uint32(buf, durationPos, box.end);
  }
  return duration === undefined ? undefined : duration / timescale;
}

/** Langue de mdhd : 1 bit de remplissage puis trois codes de 5 bits (lettre - 0x60). */
function readLanguage(buf: Buffer, mdhd: Box | undefined): string {
  if (mdhd === undefined) return 'und';
  const version = buf[mdhd.payload] ?? 0;
  const pos = mdhd.payload + (version === 1 ? 32 : 20);
  if (pos + 2 > mdhd.end) return 'und';
  const packed = buf.readUInt16BE(pos);
  const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f].map((value) => value + 0x60);
  if (letters.some((code) => code < 0x61 || code > 0x7a)) return 'und';
  return String.fromCharCode(...letters);
}

/** Type de handler (hdlr) : fourcc à l'offset 8 du payload. */
function readHandler(buf: Buffer, hdlr: Box): string | undefined {
  const pos = hdlr.payload + 8;
  return pos + 4 <= hdlr.end ? buf.toString('latin1', pos, pos + 4) : undefined;
}

/** Premier sample entry de stsd : (position, fourcc). Sa taille déclarée n'est pas vérifiée ici. */
function firstSampleEntry(buf: Buffer, stsd: Box): { start: number; fourcc: string } | undefined {
  const start = stsd.payload + 8;
  if (start + HEADER > stsd.end) return undefined;
  return { start, fourcc: buf.toString('latin1', start + 4, start + 8) };
}

/**
 * Nombre de canaux d'un sample entry audio. Champ à l'offset 24 du sample entry (versions 0 et 1, MP4 et QuickTime).
 * La version 2 de QuickTime place le nombre réel ailleurs : il n'est pas renvoyé.
 */
function readChannels(buf: Buffer, entryStart: number, end: number): number | undefined {
  const versionPos = entryStart + 16;
  if (versionPos + 2 > end) return undefined;
  if (buf.readUInt16BE(versionPos) === 2) return undefined;
  const pos = entryStart + 24;
  return pos + 2 <= end ? buf.readUInt16BE(pos) : undefined;
}

function parseTrak(buf: Buffer, trak: Box): Mp4Track | undefined {
  const mdia = child(buf, trak, 'mdia');
  if (mdia === undefined) return undefined;
  const handler = child(buf, mdia, 'hdlr');
  const handlerType = handler === undefined ? undefined : readHandler(buf, handler);
  if (handlerType === undefined) return undefined;
  const minf = child(buf, mdia, 'minf');
  const stbl = minf === undefined ? undefined : child(buf, minf, 'stbl');
  const stsd = stbl === undefined ? undefined : child(buf, stbl, 'stsd');
  const entry = stsd === undefined ? undefined : firstSampleEntry(buf, stsd);
  const track: Mp4Track = {
    handler: handlerType,
    language: readLanguage(buf, child(buf, mdia, 'mdhd')),
    codec: entry?.fourcc ?? '',
  };
  if (entry !== undefined && stsd !== undefined && handlerType === 'soun') {
    const channels = readChannels(buf, entry.start, stsd.end);
    if (channels !== undefined) track.channels = channels;
  }
  return track;
}

/**
 * Parse une boîte moov. `buf` doit commencer à l'en-tête du moov (offset 0). Tolérant à la troncature :
 * les pistes et champs présents dans le buffer sont renvoyés, le reste est ignoré.
 */
export function parseMoov(buf: Buffer): Mp4Info {
  const info: Mp4Info = { tracks: [] };
  const [moov] = boxes(buf, 0, buf.length);
  if (moov === undefined || moov.type !== 'moov') return info;
  for (const box of boxes(buf, moov.payload, moov.end)) {
    if (box.type === 'mvhd') {
      const duration = readDuration(buf, box);
      if (duration !== undefined) info.durationSec = duration;
    } else if (box.type === 'trak') {
      const track = parseTrak(buf, box);
      if (track !== undefined) info.tracks.push(track);
    }
  }
  return info;
}
