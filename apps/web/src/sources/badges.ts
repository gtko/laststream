/* Badges des formats (vidéo, HDR, audio, canaux) et pastille d'adéquation au débit, pour le sélecteur de sources.
 * Logos officiels (Wikimedia Commons, dans public/badges/, sources et marques dans SOURCES.md) pour les formats qui en
 * ont un ; sinon badges maison : libellés, couleurs et pictogrammes originaux. Une valeur inconnue reste un texte
 * neutre (mêmes classes qu'avant). Fonctions pures, testées. */

/** Données d'une source : libellés (picker) ou valeurs brutes lastAddon (h264, x265, DDP, DTS:X…). */
export interface BadgeInfo {
  /** REMUX, BluRay, WEB-DL… */
  source?: string;
  /** AVC, HEVC, AV1… ou brut (h264, x265…). */
  codec?: string;
  /** Puces HDR (DV, HDR10+…) ou texte brut (Dolby Vision, DoVi…). */
  hdr?: readonly string[];
  /** « TrueHD Atmos 7.1 » ou liste brute de codecs audio. */
  audio?: string | readonly string[];
  /** Disposition brute des canaux (« 5.1 »). */
  channels?: string;
  /** 10 pour une source 10-bit (voir `bitDepthOf`). */
  bitDepth?: number;
}

export type BadgePart = 'video' | 'audio';
export type FitLevel = 'fluid' | 'tight' | 'risky' | 'unknown';

interface Rule {
  re: RegExp;
  id: string;
  label: string;
  /** Nom complet : aria-label et infobulle. */
  name: string;
}

const SOURCE_RULES: Rule[] = [
  { re: /remux/i, id: 'remux', label: 'REMUX', name: 'REMUX · copie intégrale du Blu-ray, qualité maximale' },
  { re: /blu-?ray|bdrip|brrip/i, id: 'bluray', label: 'BluRay', name: 'BluRay · source Blu-ray réencodée' },
  { re: /web-?dl/i, id: 'webdl', label: 'WEB-DL', name: 'WEB-DL · flux web sans réencodage' },
  { re: /web-?rip/i, id: 'webrip', label: 'WEBRip', name: 'WEBRip · capture web recompressée' },
  { re: /hdtv|pdtv/i, id: 'hdtv', label: 'HDTV', name: 'HDTV · capture de diffusion télévisée' },
  { re: /dvd/i, id: 'dvd', label: 'DVD', name: 'DVD · source DVD' },
  { re: /\bweb\b/i, id: 'web', label: 'WEB', name: 'WEB · source web' },
  { re: /cam|telesync|\bts\b/i, id: 'cam', label: 'CAM', name: 'CAM · enregistrement en salle, qualité faible' },
];

const CODEC_RULES: Rule[] = [
  { re: /\bav1\b|av01/i, id: 'av1', label: 'AV1', name: 'AV1 · codec vidéo libre et efficace (AOMedia)' },
  { re: /\bvp9\b/i, id: 'vp9', label: 'VP9', name: 'VP9 · codec vidéo libre' },
  { re: /hevc|h\.?265|x\.?265/i, id: 'hevc', label: 'HEVC · H.265', name: 'HEVC (H.265) · codec vidéo haute efficacité' },
  { re: /avc|h\.?264|x\.?264/i, id: 'avc', label: 'AVC · H.264', name: 'AVC (H.264) · codec vidéo très répandu' },
];

/** Ordre d'importance : DV, HDR10+, HDR10, HLG, puis le HDR générique. */
const HDR_RULES: Rule[] = [
  { re: /dolby|^dv$|\bdv\b|dovi/i, id: 'dv', label: 'Dolby Vision', name: 'Dolby Vision · vidéo HDR dynamique' },
  { re: /hdr10\+|hdr10plus/i, id: 'hdr10p', label: 'HDR10+', name: 'HDR10+ · HDR dynamique ouverte' },
  { re: /hdr10/i, id: 'hdr10', label: 'HDR10', name: 'HDR10 · HDR statique' },
  { re: /\bhlg\b/i, id: 'hlg', label: 'HLG', name: 'HLG · HDR de diffusion' },
  { re: /hdr/i, id: 'hdr', label: 'HDR', name: 'HDR · plage dynamique étendue' },
];

const AUDIO_RULES: Rule[] = [
  { re: /truehd/i, id: 'truehd', label: 'TrueHD', name: 'TrueHD · audio sans perte' },
  { re: /dts-?hd[ .-]?ma|dts-?hd/i, id: 'dtshdma', label: 'DTS-HD MA', name: 'DTS-HD Master Audio · audio sans perte' },
  { re: /dts[-:. ]?x\b/i, id: 'dtsx', label: 'DTS:X', name: 'DTS:X · audio à objets' },
  { re: /\bdts\b/i, id: 'dts', label: 'DTS', name: 'DTS · audio multicanal' },
  { re: /ddp|dd\+|e-?ac-?3|eac3/i, id: 'ddp', label: 'DD+', name: 'Dolby Digital Plus (E-AC-3) · audio compressé' },
  { re: /\bdd\b|\bac-?3\b/i, id: 'dd', label: 'DD', name: 'Dolby Digital (AC-3) · audio compressé' },
  { re: /flac/i, id: 'flac', label: 'FLAC', name: 'FLAC · audio sans perte' },
  { re: /opus/i, id: 'opus', label: 'Opus', name: 'Opus · audio compressé efficace' },
  { re: /aac/i, id: 'aac', label: 'AAC', name: 'AAC · audio compressé' },
  { re: /mp3/i, id: 'mp3', label: 'MP3', name: 'MP3 · audio compressé' },
];

const ATMOS: Rule = { re: /atmos/i, id: 'atmos', label: 'Atmos', name: 'Dolby Atmos · audio spatial à objets' };
const BIT10 = { id: 'bit10', label: '10-bit', name: '10-bit · profondeur de couleur de 10 bits' };

const CHANNEL_RULES: Rule[] = [
  { re: /^2\.0$/, id: 'ch20', label: '2.0', name: '2.0 · stéréo' },
  { re: /^5\.1$/, id: 'ch51', label: '5.1', name: '5.1 · surround (6 canaux)' },
  { re: /^7\.1$/, id: 'ch71', label: '7.1', name: '7.1 · surround (8 canaux)' },
];

// Pictogrammes originaux (barres HDR, orbite objet, haut-parleur) : dessinés pour ces badges, pas des logos.
const ICON_BARS = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="1.5" y="9.5" width="3" height="5" rx="1"/><rect x="6.5" y="5.5" width="3" height="9" rx="1"/><rect x="11.5" y="1.5" width="3" height="13" rx="1"/></svg>';
const ICON_ORBIT = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><ellipse cx="8" cy="8" rx="7" ry="3.2" fill="none" stroke="currentColor" stroke-width="1.3" transform="rotate(-24 8 8)"/><circle cx="8" cy="8" r="2.2"/></svg>';
const ICON_SPEAKER = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.5 5.5h2.5L8 2.5v11L4 10.5H1.5z"/><path d="M10.5 5.5a3.2 3.2 0 0 1 0 5M12.7 3.3a6.3 6.3 0 0 1 0 9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICONS: Record<string, string> = {
  dv: ICON_BARS, hdr10p: ICON_BARS, hdr10: ICON_BARS, hlg: ICON_BARS, hdr: ICON_BARS,
  atmos: ICON_ORBIT, ch20: ICON_SPEAKER, ch51: ICON_SPEAKER, ch71: ICON_SPEAKER,
};

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Échappement pour le texte et les attributs (guillemets compris). */
export const escapeHtml = (s: string): string => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

const match = (rules: readonly Rule[], text: string): Rule | null => rules.find((r) => r.re.test(text)) ?? null;

/**
 * Logos officiels publiés dans public/badges/ (fichiers, licences et marques : public/badges/SOURCES.md). `mono` : logo noir
 * sur fond transparent, éclairci en CSS (.bdg-mono). Les formats absents d'ici gardent le badge maison.
 */
const LOGOS: Record<string, { file: string; mono?: boolean }> = {
  dv: { file: 'dolby-vision.svg', mono: true },
  atmos: { file: 'dolby-atmos.svg', mono: true },
  dd: { file: 'dolby-digital.svg', mono: true },
  ddp: { file: 'dolby-digital-plus.svg', mono: true },
  truehd: { file: 'dolby-truehd.svg', mono: true },
  dtshdma: { file: 'dts-hd-ma.svg' },
  dts: { file: 'dts.svg' },
  hdr10: { file: 'hdr10.svg', mono: true },
  hdr10p: { file: 'hdr10plus.svg', mono: true },
  av1: { file: 'av1.svg' },
  avc: { file: 'avc.svg' },
  opus: { file: 'opus.svg' },
  aac: { file: 'aac.svg' },
};

function chip(rule: Pick<Rule, 'id' | 'label' | 'name'>): string {
  const aria = ' role="img" aria-label="' + escapeHtml(rule.name) + '" title="' + escapeHtml(rule.name) + '"';
  const logo = LOGOS[rule.id];
  if (logo) {
    return '<span class="bdg bdg-' + rule.id + ' bdg-logo' + (logo.mono ? ' bdg-mono' : '') + '"' + aria + '>' +
      '<img class="bdg-img" src="/badges/' + logo.file + '" alt="" decoding="async"></span>';
  }
  return '<span class="bdg bdg-' + rule.id + '"' + aria + '>' +
    (ICONS[rule.id] ?? '') + '<span class="bdg-t" aria-hidden="true">' + escapeHtml(rule.label) + '</span></span>';
}

const neutral = (cls: string, text: string): string => '<span class="' + cls + '">' + escapeHtml(text) + '</span>';

/** 10 si le texte annonce un 10-bit (« 10bit », « 10-bit », « Hi10P »), sinon undefined. */
export function bitDepthOf(text: string): number | undefined {
  return /\b(10[- ]?bit|hi10p?)\b/i.test(text) ? 10 : undefined;
}

function videoPart(info: BadgeInfo): string {
  let out = '';
  const src = (info.source ?? '').trim();
  if (src) {
    const r = match(SOURCE_RULES, src);
    out += r ? chip(r) : neutral('s-type', src);
  }
  // HDR : une puce par format reconnu, dans l'ordre d'importance ; le HDR générique cède la place à HDR10 et HDR10+.
  const ids = new Set<string>();
  const unknownHdr: string[] = [];
  for (const raw of info.hdr ?? []) {
    const t = raw.trim();
    if (!t) continue;
    const r = match(HDR_RULES, t);
    if (r) ids.add(r.id);
    else unknownHdr.push(t);
  }
  if (ids.has('hdr10p') || ids.has('hdr10')) ids.delete('hdr');
  for (const r of HDR_RULES) if (ids.has(r.id)) out += chip(r);
  for (const t of unknownHdr) out += neutral('s-hdr', t);
  const codec = (info.codec ?? '').trim();
  if (codec) {
    const r = match(CODEC_RULES, codec);
    out += r ? chip(r) : neutral('s-codec', codec);
  }
  if (info.bitDepth === 10) out += chip(BIT10);
  return out;
}

const CHANNEL_TOKEN = /\b([1-9])[ .]([01])\b/;

function audioPart(info: BadgeInfo): string {
  const text = (Array.isArray(info.audio) ? info.audio.join(' ') : String(info.audio ?? '')).trim();
  let out = '';
  const codec = match(AUDIO_RULES, text);
  const tokenFound = CHANNEL_TOKEN.exec(text);
  const channelsRaw = (info.channels ?? '').trim() || (tokenFound ? tokenFound[1] + '.' + tokenFound[2] : '');
  // Texte restant (codec inconnu) : sans les canaux ni le mot « Atmos », déjà traités à part.
  const rest = text.replace(CHANNEL_TOKEN, ' ').replace(/atmos/gi, ' ').replace(/\s+/g, ' ').trim();
  if (codec) out += chip(codec);
  else if (rest) out += neutral('s-audio', rest);
  if (ATMOS.re.test(text)) out += chip(ATMOS);
  if (channelsRaw) {
    const ch = match(CHANNEL_RULES, channelsRaw.replace(/[ ,]/, '.'));
    out += ch ? chip(ch) : neutral('s-ch', channelsRaw);
  }
  return out;
}

/**
 * HTML des badges d'une source. `part` : « video » (source, HDR, codec vidéo, 10-bit) ou « audio » (codec audio, Atmos,
 * canaux). Une valeur non reconnue devient un texte neutre, sans badge.
 */
export function codecBadges(info: BadgeInfo, part: BadgePart = 'video'): string {
  return part === 'audio' ? audioPart(info) : videoPart(info);
}

/** Niveau d'adéquation d'une source au débit de la connexion, en Mb/s. Bornes : ≤ 60 % fluide, ≤ 90 % juste, au-delà risque. */
export function fitLevel(sourceMbps: number | null | undefined, connMbps: number | null | undefined): FitLevel {
  const ok = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!ok(sourceMbps) || !ok(connMbps) || connMbps === 0) return 'unknown';
  // Comparaison multipliée : pas d'erreur d'arrondi sur les bornes exactes (60 % et 90 %).
  if (sourceMbps * 100 <= connMbps * 60) return 'fluid';
  if (sourceMbps * 100 <= connMbps * 90) return 'tight';
  return 'risky';
}

const toMbps = (kbps: number | null | undefined): number | null => (typeof kbps === 'number' && Number.isFinite(kbps) && kbps >= 0 ? kbps / 1000 : null);
const mbpsLabel = (mbps: number): string => mbps.toFixed(1).replace('.', ',') + ' Mb/s';

const FIT_TEXT: Record<Exclude<FitLevel, 'unknown'>, { label: string; word: string; glyph: string }> = {
  fluid: { label: 'Fluide', word: 'fluide', glyph: '✓' },
  tight: { label: 'Juste', word: 'juste', glyph: '~' },
  risky: { label: 'Risque de coupures', word: 'risque de coupures', glyph: '!' },
};

/**
 * Pastille d'adéquation au débit (débits en kb/s, comme `bitrateKbps` et la mesure). Connexion inconnue ou source sans
 * débit : pastille neutre « Débit inconnu » (le bouton « Mesurer » est dans le sélecteur, pas dans la carte).
 */
export function fitBadge(sourceKbps: number | null | undefined, connKbps: number | null | undefined): string {
  const s = toMbps(sourceKbps);
  const c = toMbps(connKbps);
  const level = fitLevel(s, c);
  if (level === 'unknown') {
    const why = c === null || c === 0 ? 'Débit de ta connexion inconnu : mesure-le pour savoir si la source passe' : 'Débit de la source inconnu';
    return '<span class="s-fit fit-unknown" role="img" aria-label="' + escapeHtml(why) + '" title="' + escapeHtml(why) + '">Débit inconnu</span>';
  }
  const t = FIT_TEXT[level];
  const aria = mbpsLabel(s as number) + ' sur une connexion de ' + mbpsLabel(c as number) + ' : ' + t.word;
  return '<span class="s-fit fit-' + level + '" role="img" aria-label="' + escapeHtml(aria) + '" title="' + escapeHtml(aria) + '">' +
    '<span class="s-fit-g" aria-hidden="true">' + t.glyph + '</span>' + escapeHtml(t.label) + '</span>';
}
