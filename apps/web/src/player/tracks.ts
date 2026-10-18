import type { Probe, ProbeStream } from './server';

/* Pistes audio et sous-titres : normalisation des langues, libellés, choix par défaut. Fonctions pures, testées. */

const LANG_ALIASES: Record<string, string> = {
  fre: 'fr', fra: 'fr', french: 'fr', francais: 'fr', 'français': 'fr',
  eng: 'en', english: 'en', ger: 'de', deu: 'de', german: 'de', spa: 'es', spanish: 'es', ita: 'it', italian: 'it',
  por: 'pt', portuguese: 'pt', jpn: 'ja', japanese: 'ja', kor: 'ko', korean: 'ko', chi: 'zh', zho: 'zh', chinese: 'zh',
  rus: 'ru', russian: 'ru', ara: 'ar', arabic: 'ar', dut: 'nl', nld: 'nl', dutch: 'nl', pol: 'pl', tur: 'tr', swe: 'sv', und: '', unknown: '', mul: '', zxx: '', mis: '', qaa: '',
  vf: 'fr', vff: 'fr', vfq: 'fr', vfi: 'fr', truefrench: 'fr', vostfr: 'fr', jp: 'ja', jap: 'ja', cze: 'cs', ces: 'cs', por_br: 'pt',
};

const LANG_NAMES: Record<string, string> = {
  fr: 'Français', en: 'Anglais', de: 'Allemand', es: 'Espagnol', it: 'Italien', pt: 'Portugais', ja: 'Japonais', ko: 'Coréen',
  zh: 'Chinois', ru: 'Russe', ar: 'Arabe', nl: 'Néerlandais', pl: 'Polonais', tr: 'Turc', sv: 'Suédois',
};

/** Code de langue à deux lettres (fre, fra, fr-FR, French → fr) ; vide si inconnu. */
export function normalizeLang(raw: string | undefined | null): string {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return '';
  if (t in LANG_ALIASES) return LANG_ALIASES[t];
  const base = t.split(/[-_]/)[0];
  if (base in LANG_ALIASES) return LANG_ALIASES[base];
  return /^[a-z]{2}$/.test(base) ? base : base.length === 3 ? '' : base;
}

const stripAccents = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Langue déduite d'un titre de piste (« Français VFF », « English 5.1 », « VOSTFR »…). */
const TITLE_LANGS: Array<[RegExp, string]> = [
  [/\b(vff|vfq|vfi|vf|vostfr|truefrench|french|francais|fre|fra)\b/, 'fr'],
  [/\b(english|anglais|eng|vo)\b/, 'en'],
  [/\b(japanese|japonais|jpn|jap)\b/, 'ja'],
  [/\b(spanish|espagnol|espanol|castellano|spa)\b/, 'es'],
  [/\b(german|allemand|deutsch|ger|deu)\b/, 'de'],
  [/\b(italian|italien|italiano|ita)\b/, 'it'],
];

export function langFromTitle(title: string | undefined | null): string {
  const t = stripAccents(title ?? '');
  for (const [re, code] of TITLE_LANGS) if (re.test(t)) return code;
  return '';
}

/** Langue d'une piste : balise de langue, sinon indice dans le titre. */
export function trackLang(lang: string | undefined | null, title?: string | null): string {
  return normalizeLang(lang) || langFromTitle(title);
}

export function langName(code: string): string {
  const c = normalizeLang(code);
  return LANG_NAMES[c] ?? (c ? c.toUpperCase() : 'Inconnue');
}

const CODEC_LABEL: Record<string, string> = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'TrueHD', dts: 'DTS', 'dts-hd': 'DTS-HD', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC',
  subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', mov_text: 'Texte', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB',
};

export function codecLabel(codec: string | undefined): string {
  const c = (codec ?? '').toLowerCase();
  return CODEC_LABEL[c] ?? (c ? c.toUpperCase() : '');
}

export function channelsLabel(n: number | undefined): string {
  if (!n || n <= 0) return '';
  return ({ 1: 'Mono', 2: 'Stéréo', 6: '5.1', 7: '6.1', 8: '7.1' } as Record<number, string>)[n] ?? n + ' canaux';
}

export interface AudioTrack {
  id: string;
  /** Titre brut de la piste dans le fichier (« Français VFF »). */
  title?: string;
  lang: string;
  label: string;
  codec: string;
  channels: number;
  selected: boolean;
}

export interface SubtitleTrack {
  id: string;
  title?: string;
  lang: string;
  label: string;
  codec: string;
  forced: boolean;
  /** `embedded` : dans le fichier ; `external` : addon / OpenSubtitles. */
  origin: 'embedded' | 'external';
  /** Texte rendu par le lecteur (SRT, VTT, ASS) ; PGS / VobSub (image) ne le sont pas. */
  renderable: boolean;
  url?: string;
  /** Fournisseur d'une piste externe (lastAddon, OpenSubtitles). */
  source?: string;
  /** Nom de release annoncé par le fournisseur, et correspondance par empreinte du fichier (OpenSubtitles). */
  release?: string;
  hashMatch?: boolean;
  downloads?: number;
  rating?: number;
  /** Pour les pistes `embedded` lues par le moteur (hls.js, mpv). */
  engineId?: string | number;
  selected: boolean;
}

export function audioTrackLabel(t: { lang: string; title?: string; codec?: string; channels?: number }): string {
  const ln = t.lang ? langName(t.lang) : '';
  const title = (t.title ?? '').trim();
  // Le titre du fichier (« Français VFF ») est plus précis que le nom de langue seul.
  const base = title && ln ? (stripAccents(title).includes(stripAccents(ln)) ? title : ln + ' (' + title + ')') : ln || title || 'Piste audio';
  const tech = [codecLabel(t.codec), channelsLabel(t.channels)].filter(Boolean).join(' ');
  return tech ? base + ' · ' + tech : base;
}

const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'pgssub', 'dvdsub']);

export interface ProbeTracks {
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  videoCodec: string;
  durationSec: number | null;
  /** Heure du premier paquet du fichier (s) : les sous-titres extraits par le serveur gardent cette origine. */
  startTime: number;
  /** Images par seconde de la vidéo. */
  fps: number | null;
  width: number | null;
  height: number | null;
}

/** Pistes d'un fichier d'après le probe du serveur (identifiants `a<n>` / `s<n>` = indice dans le fichier). */
export function parseProbe(probe: Probe | null): ProbeTracks {
  const empty: ProbeTracks = { audio: [], subtitles: [], videoCodec: '', durationSec: null, startTime: 0, fps: null, width: null, height: null };
  if (!probe) return empty;
  const video = probe.streams.find((s) => s.track === 'video');
  const audio = probe.streams.filter((s) => s.track === 'audio').map((s: ProbeStream, i) => {
    const lang = trackLang(s.lang ?? s.language, s.title ?? s.label);
    return { id: 'a' + (s.id ?? i), title: s.title ?? s.label ?? '', lang, codec: (s.codec ?? '').toLowerCase(), channels: s.channels ?? 0, selected: false, label: audioTrackLabel({ lang, title: s.title ?? s.label, codec: s.codec, channels: s.channels }) };
  });
  const subtitles = probe.streams.filter((s) => s.track === 'subtitle').map((s: ProbeStream, i): SubtitleTrack => {
    const lang = trackLang(s.lang ?? s.language, s.title ?? s.label);
    const codec = (s.codec ?? '').toLowerCase();
    const forced = s.forced === true || /forc/i.test(s.title ?? s.label ?? '');
    return {
      id: 's' + (s.id ?? i), title: s.title ?? s.label ?? '', lang, codec, forced, origin: 'embedded', renderable: !IMAGE_SUBS.has(codec), engineId: s.id ?? i, selected: false,
      label: (lang ? langName(lang) : s.title || 'Sous-titres') + (forced ? ' (forcés)' : '') + (codec ? ' · ' + codecLabel(codec) : ''),
    };
  });
  const d = probe.format?.duration;
  const vStart = (video as { startTime?: number } | undefined)?.startTime;
  const startTime = typeof vStart === 'number' && Number.isFinite(vStart) ? Math.max(0, vStart) : 0;
  const fps = typeof video?.frameRate === 'number' && video.frameRate > 0 ? video.frameRate : null;
  return { audio, subtitles, videoCodec: (video?.codec ?? '').toLowerCase(), durationSec: typeof d === 'number' && d > 0 ? d : null, startTime, fps, width: video?.width ?? null, height: video?.height ?? null };
}

/** Piste audio par défaut : langue préférée, sinon langue d'origine annoncée par le fichier, sinon la première. Index, ou -1 si vide. */
export function pickDefaultAudio(tracks: readonly AudioTrack[], preferred: readonly string[]): number {
  if (!tracks.length) return -1;
  for (const p of preferred) {
    const lang = normalizeLang(p);
    const matches = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.lang === lang);
    if (matches.length) {
      // À langue égale, la piste la plus riche (canaux) que le navigateur peut décoder, la première en cas d'égalité.
      return matches.sort((a, b) => b.t.channels - a.t.channels || a.i - b.i)[0].i;
    }
  }
  return 0;
}

export type SubtitleMode = 'auto' | 'always' | 'off';

/**
 * Sous-titres par défaut. `auto` : aucun si l'audio est dans la langue préférée (sauf pistes « forcés »), sinon la
 * langue préférée ; `always` : toujours la langue préférée ; `off` : aucun. Index ou -1.
 */
export function pickDefaultSubtitle(tracks: readonly SubtitleTrack[], preferredLang: string, audioLang: string, mode: SubtitleMode): number {
  const pref = normalizeLang(preferredLang);
  const usable = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.renderable);
  if (mode === 'off' || !usable.length) return -1;
  const mine = usable.filter(({ t }) => t.lang === pref);
  const audioIsPref = normalizeLang(audioLang) === pref;
  if (mode === 'auto' && audioIsPref) {
    const forced = mine.find(({ t }) => t.forced);
    return forced ? forced.i : -1;
  }
  if (!mine.length) return -1;
  // Hors « forcés » d'abord : une piste complète vaut mieux qu'une piste qui ne traduit que les passages étrangers.
  const full = mine.find(({ t }) => !t.forced);
  return (full ?? mine[0]).i;
}

/** Sous-titres mémorisés pour le titre : `off`, ou première piste complète dans la langue mémorisée (-1 si absente). */
export function pickRememberedSubtitle(tracks: readonly SubtitleTrack[], code: string): number {
  if (code === 'off') return -1;
  const lang = normalizeLang(code);
  const mine = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.renderable && t.lang === lang);
  const full = mine.find(({ t }) => !t.forced);
  return (full ?? mine[0])?.i ?? -1;
}
