import { codecLabel, channelsLabel, langName, normalizeLang, type AudioTrack, type SubtitleTrack } from './tracks';

/* Présentation des pistes : regroupement par langue (langue préférée d'abord), libellés lisibles, pastilles.
 * Fonctions pures, testées. */

const strip = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Variante annoncée dans le titre de la piste : VFF, VFQ, VFI, VO, VOSTFR, SDH… */
export function variantOf(title: string | undefined | null): string {
  const t = strip(title ?? '');
  const m = /\b(vff|vfq|vfi|vf|truefrench|vo|vostfr)\b/.exec(t);
  return m ? m[1].toUpperCase().replace('TRUEFRENCH', 'VF') : '';
}

export interface AudioItem {
  track: AudioTrack;
  /** Ligne principale : « Français (VFF) », « Japonais (VO) »… */
  label: string;
  /** Ligne secondaire : « E-AC3 5.1 », « AAC 2.0 »… */
  detail: string;
  badges: string[];
}

export interface AudioGroup {
  lang: string;
  name: string;
  items: AudioItem[];
}

const isCommentary = (t: string): boolean => /commentar|commentaire|director/.test(strip(t));
const isDescriptive = (t: string): boolean => /audio.?description|audiodescription|descriptive|\bad\b|malvoyant/.test(strip(t));

/** Débit des canaux : 2 → « 2.0 », 6 → « 5.1 », 8 → « 7.1 ». */
export function channelLayout(n: number): string {
  return ({ 1: '1.0', 2: '2.0', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1' } as Record<number, string>)[n] ?? (n > 0 ? String(n) : '');
}

export function audioDetail(t: Pick<AudioTrack, 'codec' | 'channels'>, title = ''): string {
  const atmos = /atmos/i.test(title) ? ' Atmos' : '';
  const codec = t.codec === 'eac3' ? 'E-AC3' : t.codec === 'ac3' ? 'AC3' : codecLabel(t.codec);
  return [codec + atmos, channelLayout(t.channels)].filter(Boolean).join(' ');
}

/** Pistes audio regroupées par langue ; langues préférées en premier, puis ordre d'apparition. `titles` : titres bruts par id. */
export function groupAudioTracks(tracks: readonly AudioTrack[], preferred: readonly string[], titles: Readonly<Record<string, string>> = {}, defaultId?: string): AudioGroup[] {
  const prefs = preferred.map(normalizeLang).filter(Boolean);
  const groups = new Map<string, AudioGroup>();
  tracks.forEach((track, i) => {
    const lang = track.lang || '';
    const title = titles[track.id] ?? '';
    const variant = variantOf(title);
    const name = lang ? langName(lang) : 'Langue inconnue';
    const badges: string[] = [];
    if (track.id === defaultId || (defaultId === undefined && i === 0)) badges.push('Par défaut');
    if (isCommentary(title)) badges.push('Commentaire');
    if (isDescriptive(title)) badges.push('Audiodescription');
    const item: AudioItem = { track, label: variant ? name + ' (' + variant + ')' : name, detail: audioDetail(track, title), badges };
    const g = groups.get(lang) ?? { lang, name, items: [] };
    g.items.push(item);
    groups.set(lang, g);
  });
  const rank = (g: AudioGroup): number => { const k = prefs.indexOf(g.lang); return k < 0 ? 99 : k; };
  return [...groups.values()].map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

// ---------- Sous-titres ----------

export interface SubtitleItem {
  track: SubtitleTrack;
  label: string;
  chips: string[];
  /** Raison de non-prise en charge (sous-titres image). */
  unsupported: string;
}

export interface SubtitleGroup {
  lang: string;
  name: string;
  items: SubtitleItem[];
}

export interface SubtitleSection {
  id: 'embedded' | 'external';
  title: string;
  groups: SubtitleGroup[];
}

const FORMAT: Record<string, string> = { subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'VTT', mov_text: 'TXT', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB' };

export function subtitleLabel(t: SubtitleTrack, title = ''): string {
  const base = t.lang ? langName(t.lang) : title || 'Sous-titres';
  const sdh = /\b(sdh|cc|hearing|malentendant)/.test(strip(title)) ? ' — SDH/malentendants' : '';
  const forced = t.forced ? ' — forcés' : '';
  return base + forced + sdh;
}

function groupSubs(tracks: readonly SubtitleTrack[], prefs: readonly string[], titles: Readonly<Record<string, string>>): SubtitleGroup[] {
  const groups = new Map<string, SubtitleGroup>();
  for (const track of tracks) {
    const title = titles[track.id] ?? '';
    const chips: string[] = [];
    const fmt = FORMAT[track.codec];
    if (fmt) chips.push(fmt);
    if (track.origin === 'external' && track.source) chips.push(track.source);
    if (track.hashMatch) chips.push('Synchronisé avec ce fichier');
    if (track.downloads) chips.push(track.downloads >= 1000 ? String(Math.round(track.downloads / 100) / 10).replace('.', ',') + ' k téléch.' : track.downloads + ' téléch.');
    if (track.rating) chips.push('★ ' + track.rating.toFixed(1));
    const item: SubtitleItem = { track, label: subtitleLabel(track, title), chips, unsupported: track.renderable ? '' : 'Image (PGS) : non pris en charge dans le navigateur' };
    const g = groups.get(track.lang) ?? { lang: track.lang, name: track.lang ? langName(track.lang) : 'Langue inconnue', items: [] };
    g.items.push(item);
    groups.set(track.lang, g);
  }
  const rank = (g: SubtitleGroup): number => { const k = prefs.indexOf(g.lang); return k < 0 ? 99 : k; };
  return [...groups.values()].map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

/** Sections « Intégrés au fichier » puis « Externes » (vides omises), chacune groupée par langue. */
export function sectionSubtitleTracks(tracks: readonly SubtitleTrack[], preferred: readonly string[], titles: Readonly<Record<string, string>> = {}): SubtitleSection[] {
  const prefs = preferred.map(normalizeLang).filter(Boolean);
  const out: SubtitleSection[] = [];
  const emb = tracks.filter((t) => t.origin === 'embedded');
  const ext = tracks.filter((t) => t.origin === 'external');
  if (emb.length) out.push({ id: 'embedded', title: 'Intégrés au fichier', groups: groupSubs(emb, prefs, titles) });
  if (ext.length) out.push({ id: 'external', title: 'Externes', groups: groupSubs(ext, prefs, titles) });
  return out;
}

export { channelsLabel };
