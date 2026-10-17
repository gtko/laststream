/**
 * Types unifiés des pistes audio et sous-titres, communs aux conteneurs MKV et MP4, et helpers de
 * normalisation (langues ISO 639, codecs, Atmos). Module pur : aucune E/S.
 */

/** Piste audio telle qu'exposée au reste de l'addon. */
export interface AudioTrack {
  /** ISO 639-1 si connue (fr, en, ja…), sinon code brut (und, xyz…). */
  lang: string;
  /** Codec lisible (AAC, AC3, EAC3, DTS, DTS-HD, TrueHD, Opus, FLAC…), ou identifiant brut si inconnu. */
  codec: string;
  /** Nombre de canaux, si le conteneur le fournit. */
  channels?: number;
  /** Présent pour E-AC-3 et TrueHD : vrai si la piste est signalée Atmos (nom de piste). */
  atmos?: boolean;
  /** Nom de piste (Name MKV), si présent. */
  name?: string;
}

/** Piste de sous-titres. */
export interface SubtitleTrack {
  /** ISO 639-1 si connue, sinon code brut. */
  lang: string;
  name?: string;
}

/** Paires ISO 639-2 (bibliographique et terminologique) → ISO 639-1, pour les langues courantes. */
const ISO_639_2_TO_1: ReadonlyMap<string, string> = new Map(
  (
    'aar:aa abk:ab afr:af alb:sq sqi:sq amh:am ara:ar arm:hy hye:hy aze:az baq:eu eus:eu bel:be ben:bn ' +
    'bos:bs bre:br bul:bg bur:my mya:my cat:ca chi:zh zho:zh cze:cs ces:cs dan:da dut:nl nld:nl eng:en ' +
    'epo:eo est:et fin:fi fre:fr fra:fr geo:ka kat:ka ger:de deu:de gle:ga glg:gl gre:el ell:el heb:he ' +
    'hin:hi hrv:hr hun:hu ice:is isl:is ind:id ita:it jpn:ja kaz:kk khm:km kor:ko lao:lo lat:la lav:lv ' +
    'lit:lt mac:mk mkd:mk mal:ml may:ms msa:ms mon:mn nob:nb nor:no nno:nn per:fa fas:fa pan:pa pol:pl ' +
    'por:pt rum:ro ron:ro rus:ru slo:sk slk:sk slv:sl spa:es srp:sr swa:sw swe:sv tam:ta tel:te tgl:tl ' +
    'tha:th tur:tr ukr:uk urd:ur vie:vi wel:cy cym:cy yid:yi'
  )
    .split(' ')
    .map((pair): [string, string] => {
      const [iso2 = '', iso1 = ''] = pair.split(':');
      return [iso2, iso1];
    }),
);

/**
 * Convertit un code ISO 639-2 (fre, fra, eng…) en ISO 639-1 (fr, en…). Un code à deux lettres est renvoyé
 * tel quel (en minuscules). Un code inconnu est renvoyé brut (ex. 'und').
 */
export function toIso639_1(code: string): string {
  const lower = code.trim().toLowerCase();
  if (lower.length === 2) return lower;
  return ISO_639_2_TO_1.get(lower) ?? lower;
}

/**
 * Normalise une étiquette de langue (BCP 47 comme fr-CA, ou ISO 639-2 comme fre) en ISO 639-1 si connue.
 * Seule la sous-balise principale compte : 'fr-CA' → 'fr', 'zh-Hant' → 'zh'. Vide ou invalide → 'und'.
 */
export function normalizeLanguageTag(tag: string | null | undefined): string {
  const primary = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary)) return 'und';
  return toIso639_1(primary);
}

/** Codec MKV (CodecID) vers nom lisible. DTS-HD se détecte au nom de piste (le CodecID A_DTS est commun). */
export function mkvCodecName(codecId: string, name?: string): string {
  const id = codecId.toUpperCase();
  if (id.startsWith('A_AAC')) return 'AAC';
  if (id.startsWith('A_AC3')) return 'AC3';
  if (id === 'A_EAC3') return 'EAC3';
  if (id === 'A_AC4') return 'AC4';
  if (id.startsWith('A_DTS')) return /dts[- ]?hd|\bma\b|\bhra\b/i.test(name ?? '') ? 'DTS-HD' : 'DTS';
  if (id === 'A_TRUEHD' || id === 'A_MLP') return 'TrueHD';
  if (id === 'A_OPUS') return 'Opus';
  if (id === 'A_FLAC') return 'FLAC';
  if (id.startsWith('A_MPEG/L3')) return 'MP3';
  if (id.startsWith('A_MPEG/L2')) return 'MP2';
  if (id.startsWith('A_VORBIS')) return 'Vorbis';
  if (id.startsWith('A_PCM')) return 'PCM';
  if (id === 'A_ALAC') return 'ALAC';
  return codecId;
}

/** Codec MP4 (fourcc du sample entry) vers nom lisible. Un fourcc inconnu est renvoyé brut. */
export function mp4CodecName(fourcc: string): string {
  switch (fourcc) {
    case 'mp4a':
      return 'AAC';
    case 'ac-3':
      return 'AC3';
    case 'ec-3':
      return 'EAC3';
    case 'ac-4':
      return 'AC4';
    case 'dtsc':
    case 'dtse':
      return 'DTS';
    case 'dtsh':
    case 'dtsl':
      return 'DTS-HD';
    case 'mlpa':
      return 'TrueHD';
    case 'Opus':
    case 'opus':
      return 'Opus';
    case 'fLaC':
      return 'FLAC';
    case '.mp3':
      return 'MP3';
    case 'alac':
      return 'ALAC';
    case 'sowt':
    case 'twos':
    case 'in24':
    case 'in32':
    case 'fl32':
    case 'fl64':
    case 'lpcm':
      return 'PCM';
    default:
      return fourcc.trim();
  }
}

/**
 * Indique si une piste est Atmos. Ne s'applique qu'à E-AC-3 et TrueHD (undefined sinon) ; l'indice est le nom
 * de piste ('Atmos' ou 'JOC'). Le JOC binaire n'est pas lu : sans nom, la piste est déclarée non Atmos.
 */
export function detectAtmos(codec: string, name?: string): boolean | undefined {
  if (codec !== 'EAC3' && codec !== 'TrueHD') return undefined;
  return /atmos|\bjoc\b/i.test(name ?? '');
}

/** Entrée brute pour construire une AudioTrack. */
export interface AudioTrackInput {
  /** Langue brute (ISO 639-2 ou BCP 47) ; normalisée ici. */
  language: string | null | undefined;
  codec: string;
  channels?: number;
  name?: string;
  atmos?: boolean;
}

/** Construit une AudioTrack normalisée. Les champs absents ou vides ne sont pas ajoutés. */
export function buildAudioTrack(input: AudioTrackInput): AudioTrack {
  const track: AudioTrack = { lang: normalizeLanguageTag(input.language), codec: input.codec };
  if (input.channels !== undefined) track.channels = input.channels;
  if (input.atmos !== undefined) track.atmos = input.atmos;
  const name = input.name?.trim();
  if (name) track.name = name;
  return track;
}
