import { capsFromMask, type DecodeCap } from '../relay/protocol';

/* Compatibilité des invités d'une watch party avec le fichier que lit l'hôte. Les invités décodent la vidéo et le son
 * que l'hôte leur relaie : une piste que le navigateur d'un invité ne sait pas décoder rend la vidéo illisible (vidéo)
 * ou muette (son). Fonctions pures : parseur des codecs tirés du nom de la source, verdict par invité, avertissement, et
 * choix d'une autre source déjà chargée. Aucune URL ici : seulement des noms de fichiers et des codes de codec. */

/** Codecs d'un fichier, dans le vocabulaire des capacités de décodage (null : inconnu). */
export interface FileCodecs {
  video: DecodeCap | null;
  audio: DecodeCap | null;
}

/** Vue d'une source (liste des sources du titre, ou source lue) : seuls les champs utiles au choix. */
export interface SourceLike {
  index?: number;
  playable?: boolean;
  client?: boolean;
  filename?: string;
  /** Codec et son tels que la liste des sources les affiche (ex. « x265 », « DTS-HD MA 5.1 »). */
  codec?: string;
  audio?: string;
  stream?: { infoHash?: string; behaviorHints?: { filename?: string } } | null;
}

/** Invité du salon : `caps` est null tant qu'il n'a pas annoncé ses capacités. */
export interface GuestStatus {
  id: string;
  caps: readonly DecodeCap[] | null;
}

/** Verdict pour un invité : tout va, le son ne passera pas, ou la vidéo ne peut pas être lue. */
export type GuestVerdict = 'ok' | 'no-audio' | 'unplayable';

export const CODEC_LABEL: Record<DecodeCap, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  aac: 'AAC',
  opus: 'Opus',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  flac: 'FLAC',
};

/* Motifs par ordre de priorité à égalité de position. La position du premier motif trouvé décide (un nom qui cite
 * « x264 » puis « HEVC » est lu comme H.264). */
const VIDEO_PATTERNS: ReadonlyArray<readonly [DecodeCap, RegExp]> = [
  ['hevc', /\b(?:x265|h\.?265|hevc)\b/i],
  ['h264', /\b(?:x264|h\.?264|avc)\b/i],
  ['av1', /\bav1\b/i],
  ['vp9', /\bvp9\b/i],
];

const AUDIO_PATTERNS: ReadonlyArray<readonly [DecodeCap, RegExp]> = [
  ['eac3', /\b(?:e-?ac-?3|ec-?3|ddp(?=\d|\b)|dd\+|dolby digital\s*plus|atmos)/i],
  ['ac3', /\b(?:ac-?3|dd(?=\d|\b)|dolby digital)/i],
  ['dts', /\bdts(?:[-\s:]?(?:hd|x|ma|es))?\b/i],
  ['aac', /\baac(?=\d|\.|\b)/i],
  ['opus', /\bopus\b/i],
  ['flac', /\bflac\b/i],
];

/** TrueHD n'a pas de capacité de décodage : une piste TrueHD est traitée comme inconnue (jamais lue comme E-AC-3 Atmos). */
const TRUEHD = /\btrue-?hd\b/i;

/** Premier codec reconnu par ses motifs dans `text` (le plus tôt dans le texte gagne). */
function firstMatch<C extends DecodeCap>(text: string, patterns: ReadonlyArray<readonly [C, RegExp]>): C | null {
  let best: C | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const [codec, re] of patterns) {
    const m = re.exec(text);
    if (m && m.index < bestAt) {
      best = codec;
      bestAt = m.index;
    }
  }
  return best;
}

/** Codecs vidéo et audio cités dans un nom de fichier ou un titre de source. Inconnus : null. */
export function parseSourceCodecs(text: string): FileCodecs {
  const video = firstMatch(text, VIDEO_PATTERNS);
  const audio = TRUEHD.test(text) ? null : firstMatch(text, AUDIO_PATTERNS);
  return { video, audio };
}

/** Texte à analyser pour une source : nom de fichier, codec et son affichés, nom de fichier de l'addon. */
export function sourceCodecText(view: SourceLike | null | undefined): string {
  if (!view) return '';
  return [view.codec, view.audio, view.filename, view.stream?.behaviorHints?.filename].filter(Boolean).join(' ');
}

/** Codecs d'une source (voir `sourceCodecText`). */
export function fileCodecsOf(view: SourceLike | null | undefined): FileCodecs {
  return parseSourceCodecs(sourceCodecText(view));
}

/** Verdict d'un invité pour un fichier : la vidéo inconnue ou décodable compte pour OK, la vidéo prime sur le son. */
export function verdictOf(file: FileCodecs, caps: readonly DecodeCap[]): GuestVerdict {
  if (file.video && !caps.includes(file.video)) return 'unplayable';
  if (file.audio && !caps.includes(file.audio)) return 'no-audio';
  return 'ok';
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Avertissement pour l'hôte, ou null si tous les invités qui ont annoncé leurs capacités peuvent tout lire.
 * Exemples : « 1 invité n’aura pas le son (DTS) », « 1 invité ne peut pas lire cette vidéo (HEVC) ».
 */
export function compatWarning(file: FileCodecs, guests: readonly GuestStatus[]): string | null {
  let unplayable = 0;
  let noAudio = 0;
  for (const g of guests) {
    if (!g.caps) continue;
    const v = verdictOf(file, g.caps);
    if (v === 'unplayable') unplayable += 1;
    else if (v === 'no-audio') noAudio += 1;
  }
  const parts: string[] = [];
  if (unplayable > 0 && file.video) {
    parts.push(
      unplayable + plural(unplayable, ' invité ne peut', ' invités ne peuvent') + ' pas lire cette vidéo (' + CODEC_LABEL[file.video] + ')',
    );
  }
  if (noAudio > 0 && file.audio) {
    parts.push(noAudio + plural(noAudio, ' invité n’aura', ' invités n’auront') + ' pas le son (' + CODEC_LABEL[file.audio] + ')');
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Source à proposer pour que tous les invités annoncés puissent lire : parmi les sources déjà chargées, sans torrent
 * (ni débridage sur l'appareil, ni infoHash), sans la source en cours, et sans incompatibilité connue. Une source dont
 * aucun codec n'est connu n'est pas proposée. À égalité, la plus confirmée (vidéo et son connus) puis la première
 * de la liste (ordre de classement). Null si aucune ne convient, ou si aucun invité n'a annoncé ses capacités.
 */
export function pickCompatibleSource<V extends SourceLike>(views: readonly V[], guests: readonly GuestStatus[], currentIndex: number | null): V | null {
  const announced = guests.filter((g): g is GuestStatus & { caps: readonly DecodeCap[] } => g.caps !== null);
  if (!announced.length) return null;
  let best: V | null = null;
  let bestKnown = 0;
  for (const v of views) {
    if (v.playable === false || v.client || v.stream?.infoHash) continue;
    if (currentIndex !== null && v.index === currentIndex) continue;
    const file = fileCodecsOf(v);
    const known = (file.video ? 1 : 0) + (file.audio ? 1 : 0);
    if (known === 0) continue;
    if (announced.some((g) => verdictOf(file, g.caps) !== 'ok')) continue;
    if (known > bestKnown) {
      best = v;
      bestKnown = known;
    }
  }
  return best;
}

/** Statuts des invités présents (`guest:true`) : capacités lues dans le masque de l'hôte, par identifiant de pair. */
export function guestStatuses(
  participants: ReadonlyArray<{ username: string; guest?: boolean; peerId?: string }>,
  caps: ReadonlyMap<string, number>,
): GuestStatus[] {
  return participants
    .filter((p) => p.guest)
    .map((p) => {
      const mask = p.peerId !== undefined ? caps.get(p.peerId) : undefined;
      return { id: p.username, caps: mask === undefined ? null : capsFromMask(mask) };
    });
}
