import { capsFromMask, type DecodeCap } from '../relay/protocol';

/* Compatibilité des invités d'une watch party avec le fichier que lit l'hôte. Les invités décodent la vidéo et le son
 * que l'hôte leur relaie : une piste que le navigateur d'un invité ne sait pas décoder rend la vidéo illisible (vidéo)
 * ou muette (son). Fonctions pures : parseur des codecs tirés du nom de la source, verdict par invité, avertissement, et
 * choix d'une autre source déjà chargée. Aucune URL ici : seulement des noms de fichiers et des codes de codec. */

/** Codecs d'un fichier, dans le vocabulaire des capacités de décodage (null : inconnu). */
export interface FileCodecs {
  video: DecodeCap | null;
  /** TrueHD n'a pas de décodeur côté invité : une piste TrueHD est connue, et jamais décodable. */
  audio: DecodeCap | 'truehd' | null;
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
  sizeBytes?: number;
  stream?: { infoHash?: string; fileIdx?: number; url?: string; behaviorHints?: { filename?: string; videoSize?: number } } | null;
}

/** Invité du salon : `caps` est null tant qu'il n'a pas annoncé ses capacités. */
export interface GuestStatus {
  id: string;
  caps: readonly DecodeCap[] | null;
}

/** Verdict pour un invité : tout va, le son ne passera pas, ou la vidéo ne peut pas être lue. */
export type GuestVerdict = 'ok' | 'no-audio' | 'unplayable';

const CODEC_LABEL: Record<DecodeCap | 'truehd', string> = {
  truehd: 'TrueHD',
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
function sourceCodecText(view: SourceLike | null | undefined): string {
  if (!view) return '';
  return [view.codec, view.audio, view.filename, view.stream?.behaviorHints?.filename].filter(Boolean).join(' ');
}

/** Codecs d'une source (voir `sourceCodecText`). */
export function fileCodecsOf(view: SourceLike | null | undefined): FileCodecs {
  return parseSourceCodecs(sourceCodecText(view));
}

/** Verdict d'un invité pour un fichier : la vidéo inconnue ou décodable compte pour OK, la vidéo prime sur le son. */
export function verdictOf(file: FileCodecs, caps: readonly DecodeCap[]): GuestVerdict {
  const has = (codec: string): boolean => (caps as readonly string[]).includes(codec);
  if (file.video && !has(file.video)) return 'unplayable';
  if (file.audio && !has(file.audio)) return 'no-audio';
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
 * Source lisible sans torrent : ni magnet, ni infoHash, ni débridage sur l'appareil (règle « jamais de torrent »).
 */
export function isStreamable(view: SourceLike): boolean {
  return view.playable !== false && !view.client && !view.stream?.infoHash && !/^magnet:/i.test(view.stream?.url ?? '');
}

/** Le son de la source est-il connu (codec d'après son nom) ? Sinon, la bascule le signale comme « son non vérifié ». */
export function audioKnown(view: SourceLike): boolean {
  return fileCodecsOf(view).audio !== null;
}

/**
 * Source utilisable pour une bascule ou un repli : lisible sans torrent, avec au moins un codec connu, et sans
 * incompatibilité connue avec les invités annoncés (un invité sans annonce ne bloque rien).
 */
function isCompatibleFile(file: FileCodecs, guests: readonly GuestStatus[]): boolean {
  if (!file.video && !file.audio) return false;
  return guests.every((g) => g.caps === null || verdictOf(file, g.caps) === 'ok');
}

/**
 * Source utilisable pour une bascule ou un repli : lisible sans torrent et compatible (`isCompatibleFile`). Les codecs
 * viennent de l'en-tête si on les a lus (`codecs`), sinon du nom de la source.
 */
export function isCompatibleSource(view: SourceLike, guests: readonly GuestStatus[], codecs?: FileCodecs | null): boolean {
  return isStreamable(view) && isCompatibleFile(codecs ?? fileCodecsOf(view), guests);
}

/** Attend `p` au plus `ms` ms ; au-delà, `onTimeout` est appelé et le résultat est null. Un rejet donne null aussi. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void = () => undefined): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(null);
    }, ms);
  });
  const value = p.then((v) => v, () => null);
  return Promise.race([value, timeout]).finally(() => clearTimeout(timer));
}

/** Résultat d'un choix : la source, ses codecs lus dans l'en-tête (null si on a retenu le nom), et la méthode. */
export interface ChoiceResult<V> {
  view: V;
  codecs: FileCodecs | null;
  source: 'header' | 'name';
}

/**
 * Choix d'une source compatible avec tous les invités annoncés. D'abord la sonde d'en-tête, sur les `probeLimit` meilleures
 * sources streamables (dans l'ordre de classement, séquentiel, `timeoutMs` chacune) : la première dont l'en-tête est
 * compatible gagne. Sinon, repli sur le parseur de nom, sans les sources dont l'en-tête a été lu et refusé.
 * `probe` reçoit un signal annulé au délai ; il rend les codecs lus, ou null si la lecture est impossible.
 */
export async function chooseCompatibleSource<V extends SourceLike>(
  views: readonly V[],
  guests: readonly GuestStatus[],
  currentIndex: number | null,
  probe: (view: V, signal: AbortSignal) => Promise<FileCodecs | null>,
  opts: { probeLimit?: number; timeoutMs?: number } = {},
): Promise<ChoiceResult<V> | null> {
  if (!guests.some((g) => g.caps !== null)) return null;
  const limit = opts.probeLimit ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const pool = views.filter((v) => v.index !== currentIndex && isStreamable(v));
  const rejected = new Set<V>();
  for (const v of pool.slice(0, limit)) {
    const ctl = new AbortController();
    const codecs = await withTimeout(probe(v, ctl.signal), timeoutMs, () => ctl.abort());
    if (!codecs) continue;
    if (isCompatibleFile(codecs, guests)) return { view: v, codecs, source: 'header' };
    rejected.add(v);
  }
  const named = pickCompatibleSource(views.filter((v) => v.index !== currentIndex && !rejected.has(v)), guests, null);
  return named ? { view: named, codecs: null, source: 'name' } : null;
}

/**
 * Source à proposer pour que tous les invités annoncés puissent lire (voir `isCompatibleSource`), sans la source en cours.
 * Classement : plus de codecs connus d'abord ; à égalité, une source dont le son est connu ; puis l'ordre de la liste.
 * Null si aucune ne convient, ou si aucun invité n'a annoncé ses capacités.
 */
export function pickCompatibleSource<V extends SourceLike>(views: readonly V[], guests: readonly GuestStatus[], currentIndex: number | null): V | null {
  if (!guests.some((g) => g.caps !== null)) return null;
  let best: V | null = null;
  let bestRank = -1;
  for (const v of views) {
    if (currentIndex !== null && v.index === currentIndex) continue;
    if (!isCompatibleSource(v, guests)) continue;
    const file = fileCodecsOf(v);
    const known = (file.video ? 1 : 0) + (file.audio ? 1 : 0);
    const rank = known * 2 + (file.audio ? 1 : 0);
    if (rank > bestRank) {
      best = v;
      bestRank = rank;
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
