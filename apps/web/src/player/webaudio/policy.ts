import type { DecodeCap } from '../../relay/protocol';
import { chooseCompatibleSource, fileCodecsOf, type ChoiceResult, type FileCodecs, type SourceLike } from '../../party/compat';
import type { MediaCaps } from '../server';

/* Son en lecture web sans serveur de streaming : qui joue la piste audio ?
 *  - `native`      : le navigateur la décode (rien à faire) ;
 *  - `app`         : le navigateur ne la décode pas mais l'app sait (AC-3 / E-AC-3 via @mediabunny/ac3, ou AudioDecoder) :
 *                    la vidéo reste muette sur sa piste native, un moteur audio de repli joue le son en WebAudio ;
 *  - `unsupported` : aucun décodeur (DTS, TrueHD…) : vidéo sans son, avec une note ;
 *  - `cors`        : la source n'autorise pas la lecture par plages depuis la page : vidéo sans son, avec une note et une
 *                    autre source proposée ;
 *  - `none`        : pas de repli (coque Windows, Android, HLS, lien non HTTP(S), fichier sans audio).
 * Fonctions pures (capacités injectées), testées. */

export type AudioPlan =
  | { mode: 'none' | 'native' | 'app' }
  | { mode: 'unsupported'; codec: string; note: string }
  | { mode: 'cors'; note: string }
  /** La source ne livre pas l'en-tête (ou aucun son) en temps utile : image seule, avec une note. */
  | { mode: 'stalled'; note: string };

export const NOTE_CORS = 'Son non disponible dans le navigateur pour cette source';
export const NOTE_STALLED = 'Son indisponible : la source met trop de temps à répondre';
export const NOTE_DTS = 'Son DTS non pris en charge par le navigateur';

const LABEL: Record<string, string> = { dts: 'DTS', truehd: 'TrueHD', ac3: 'AC-3', eac3: 'E-AC-3', aac: 'AAC', opus: 'Opus', flac: 'FLAC', mp3: 'MP3', vorbis: 'Vorbis' };
const label = (codec: string): string => LABEL[codec] ?? codec.toUpperCase();

export function unsupportedNote(codec: string): string {
  return codec === 'dts' ? NOTE_DTS : 'Son ' + label(codec) + ' non pris en charge par le navigateur';
}

/** Codecs que mediabunny ne décode pas et que l'app n'essaie même pas. */
export const NO_DECODER = new Set(['dts', 'truehd']);
export const isAc3Family = (codec: string): boolean => codec === 'ac3' || codec === 'eac3';

export interface AudioPlanInput {
  /** Navigateur seul : ni coque Windows, ni application Android. */
  web: boolean;
  /** La lecture passe par le transcodage HLS du serveur : le son est déjà converti. */
  hls: boolean;
  url: string | null;
  /** Codec de la piste audio principale d'après mediabunny (`aac`, `ac3`, `eac3`, `dts`…) ; null : aucune piste. */
  codec: string | null;
  /** Nom du conteneur d'après mediabunny (`MP4`, `Matroska`, `WebM`…). */
  container: string;
  caps: Pick<MediaCaps, 'audioCodecs'>;
  /** L'app sait décoder cette piste (`canDecode` de mediabunny, décodeur AC-3 chargé). */
  appCanDecode: boolean;
  /** Sonde de plage : `ok`, ou un refus (CORS, plage ignorée, erreur HTTP). */
  range: 'ok' | 'denied' | 'norange' | 'error';
  /** Preuve que le navigateur est resté muet (octets décodés à 0) : on ignore ce que `canPlayType` annonce. */
  nativeSilent?: boolean;
}

/**
 * Le navigateur joue-t-il lui-même cette piste ? AC-3 / E-AC-3 : `canPlayType` est annoncé sans réserve par Chrome alors que
 * le conteneur Matroska n'est pas lu avec ces codecs, et la preuve réelle vient du compteur d'octets décodés (voir
 * `nativeAudioSilent`) : on ne s'y fie qu'en MP4. Autres codecs : la liste des capacités suffit.
 */
export function browserPlaysAudio(codec: string, container: string, caps: Pick<MediaCaps, 'audioCodecs'>): boolean {
  if (!caps.audioCodecs.includes(codec)) return false;
  if (isAc3Family(codec) && /matroska|webm/i.test(container)) return false;
  return true;
}

export function chooseAudioPlan(i: AudioPlanInput): AudioPlan {
  if (!i.web || i.hls || !i.url || !/^https?:\/\//i.test(i.url) || !i.codec) return { mode: 'none' };
  if (!i.nativeSilent && browserPlaysAudio(i.codec, i.container, i.caps)) return { mode: 'native' };
  if (NO_DECODER.has(i.codec)) return { mode: 'unsupported', codec: i.codec, note: unsupportedNote(i.codec) };
  if (i.range !== 'ok') return { mode: 'cors', note: NOTE_CORS };
  if (!i.appCanDecode) return { mode: 'unsupported', codec: i.codec, note: unsupportedNote(i.codec) };
  return { mode: 'app' };
}

/** Plan quand l'en-tête est illisible (CORS refusé) : seul le nom de la source dit si c'est du DTS / TrueHD. */
export function chooseAudioPlanBlind(nameCodec: string | null): AudioPlan {
  if (nameCodec && NO_DECODER.has(nameCodec)) return { mode: 'unsupported', codec: nameCodec, note: unsupportedNote(nameCodec) };
  return { mode: 'cors', note: NOTE_CORS };
}

/**
 * Chromium : l'élément n'a décodé aucun octet audio alors que la vidéo avance depuis un moment. Preuve réelle qu'il est muet,
 * quelle que soit l'annonce de `canPlayType`. `undefined` (Firefox, Safari) : pas de mesure, donc pas de verdict.
 */
export function nativeAudioSilent(decodedBytes: number | undefined, playedSeconds: number, minSeconds = 2.5): boolean {
  return decodedBytes === 0 && playedSeconds >= minSeconds;
}

export type RangeProbe = 'ok' | 'denied' | 'norange' | 'error';

/**
 * Sonde Range d'un octet : la page peut-elle lire cette source par plages ? Un refus CORS se manifeste par un `fetch` qui
 * échoue (TypeError) ; une réponse 200 veut dire que le serveur ignore `Range` ; 4xx / 5xx : source en erreur.
 * Aucune URL dans le résultat.
 */
export async function probeRange(url: string, fetchImpl: typeof fetch = (i, n) => fetch(i, n), timeoutMs = 8000, signal?: AbortSignal): Promise<RangeProbe> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = (): void => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 206) return 'ok';
    if (res.status === 200) return 'norange';
    return 'error';
  } catch {
    return ctl.signal.aborted ? 'error' : 'denied';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---- Source alternative quand le son n'est pas lisible ----

/** Codecs que le navigateur lit seul, au vocabulaire des capacités de décodage de la watch party. */
export function readableCaps(caps: Pick<MediaCaps, 'videoCodecs' | 'audioCodecs'>): DecodeCap[] {
  const out: DecodeCap[] = [];
  const v = (names: string[], cap: DecodeCap): void => { if (names.some((n) => caps.videoCodecs.includes(n))) out.push(cap); };
  v(['h264'], 'h264');
  v(['hevc', 'h265'], 'hevc');
  v(['av1'], 'av1');
  v(['vp9'], 'vp9');
  const a = (name: string, cap: DecodeCap): void => { if (caps.audioCodecs.includes(name)) out.push(cap); };
  a('aac', 'aac');
  a('opus', 'opus');
  a('flac', 'flac');
  return out;
}

export interface AlternativeOptions<V extends SourceLike = SourceLike> {
  /** Sonde d'en-tête (plages) ; null : on s'en tient au nom des sources. */
  probe?: ((view: V, signal: AbortSignal) => Promise<FileCodecs | null>) | null;
  probeLimit?: number;
  timeoutMs?: number;
}

/**
 * Meilleure autre source dont le son est lisible tel quel (AAC / Opus / FLAC) et dont la vidéo l'est aussi, dans l'ordre de
 * classement reçu. L'en-tête prime sur le nom (`chooseCompatibleSource`) ; une source dont le son n'est pas identifié
 * n'est jamais proposée (on ne remplace pas un son muet par un son incertain).
 */
export async function pickReadableAlternative<V extends SourceLike>(
  views: readonly V[], currentIndex: number | null, caps: Pick<MediaCaps, 'videoCodecs' | 'audioCodecs'>, opts: AlternativeOptions<V> = {},
): Promise<ChoiceResult<V> | null> {
  const readable = readableCaps(caps);
  if (!readable.some((c) => c === 'aac' || c === 'opus' || c === 'flac')) return null;
  const guests = [{ id: 'web', caps: readable }];
  const probe = opts.probe ?? (async () => null);
  // Le nom écarte d'emblée AC-3 / E-AC-3 / DTS ; sans sonde, seules les sources dont le nom annonce un son lisible restent.
  const pool = views.filter((v) => {
    const a = fileCodecsOf(v).audio;
    return a === null ? !!opts.probe : (readable as readonly string[]).includes(a);
  });
  const res = await chooseCompatibleSource(pool, guests, currentIndex, probe, { probeLimit: opts.probe ? opts.probeLimit : 0, timeoutMs: opts.timeoutMs });
  if (!res) return null;
  const audio = (res.codecs ?? fileCodecsOf(res.view)).audio;
  return audio && (readable as readonly string[]).includes(audio) ? res : null;
}
