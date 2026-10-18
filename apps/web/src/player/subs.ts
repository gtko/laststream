/* Sous-titres : lecture de SRT / WebVTT / ASS en cues, recherche de la cue active avec décalage, réglages d'affichage. */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** « 00:01:02,500 » ou « 1:02.5 » → secondes ; NaN si illisible. */
export function parseTimestamp(raw: string): number {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(raw);
  if (!m) return NaN;
  const frac = m[4] ? Number('0.' + m[4].padEnd(3, '0')) : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const TIME_LINE = /([\d:.,]+)\s*-->\s*([\d:.,]+)/;

/** SRT et WebVTT partagent le découpage en blocs « minutage / texte ». */
export function parseCues(source: string): Cue[] {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => TIME_LINE.test(l));
    if (i < 0) continue;
    const m = TIME_LINE.exec(lines[i]);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    const body = lines.slice(i + 1).join('\n').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** ASS / SSA : lignes `Dialogue:` ; les balises de style sont retirées, `\N` devient un retour à la ligne. */
export function parseAss(source: string): Cue[] {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let format: string[] = [];
  const cues: Cue[] = [];
  for (const line of lines) {
    if (/^Format:/i.test(line) && format.length === 0 && /Start/i.test(line)) format = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
    if (!/^Dialogue:/i.test(line)) continue;
    const cols = format.length ? format : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = line.slice(9).split(',');
    const textIdx = cols.indexOf('text');
    const body = parts.slice(textIdx).join(',');
    const start = parseTimestamp(parts[cols.indexOf('start')] ?? '');
    const end = parseTimestamp(parts[cols.indexOf('end')] ?? '');
    const clean = body.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && clean) cues.push({ start, end, text: clean });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function parseSubtitles(source: string, hint = ''): Cue[] {
  if (/\[Script Info\]|^Dialogue:/im.test(source) || /\.(ass|ssa)(\?|$)/i.test(hint)) return parseAss(source);
  return parseCues(source);
}

/** Cue visible à l'instant `time` avec un décalage `offset` (secondes : positif = sous-titres plus tard) et un rapport de vitesse. */
export function activeCue(cues: readonly Cue[], time: number, offset = 0, rate = 1): Cue | null {
  const t = (time - offset) / (rate > 0 ? rate : 1);
  let lo = 0;
  let hi = cues.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Les cues peuvent se chevaucher : on remonte de quelques positions.
  for (let i = best; i >= 0 && i > best - 4; i--) if (t < cues[i].end) return cues[i];
  return null;
}

/** HTML sûr d'une cue : tout est échappé, seules <i>, <b>, <u> sont conservées. */
export function cueHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>').replace(/&lt;\/?[^&]*?&gt;/g, '').replace(/\n/g, '<br>');
}

// ---------- Réglages ----------

export type SubBackground = 'none' | 'shadow' | 'box';

export interface SubtitleStyle {
  /** Taille en % de la taille de base (50 à 200). */
  size: number;
  /** Distance au bord bas en % de la hauteur (2 à 40). */
  position: number;
  background: SubBackground;
  color: 'white' | 'yellow';
  mode: 'auto' | 'always' | 'off';
  font: 'sans' | 'serif' | 'mono';
  /** Bord de l'écran dont `position` mesure la distance. */
  edge: 'bottom' | 'top';
}

export const DEFAULT_SUB_STYLE: SubtitleStyle = { size: 100, position: 8, background: 'shadow', color: 'white', mode: 'auto', font: 'sans', edge: 'bottom' };
export const SUB_STYLE_KEY = 'laststream.player.subtitles';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function normalizeSubStyle(x: Partial<SubtitleStyle> | null | undefined): SubtitleStyle {
  const d = DEFAULT_SUB_STYLE;
  const o = x ?? {};
  return {
    size: clamp(Number.isFinite(o.size) ? Number(o.size) : d.size, 50, 200),
    position: clamp(Number.isFinite(o.position) ? Number(o.position) : d.position, 2, 40),
    background: o.background === 'none' || o.background === 'box' || o.background === 'shadow' ? o.background : d.background,
    color: o.color === 'yellow' ? 'yellow' : 'white',
    mode: o.mode === 'always' || o.mode === 'off' ? o.mode : 'auto',
    font: o.font === 'serif' || o.font === 'mono' ? o.font : 'sans',
    edge: o.edge === 'top' ? 'top' : 'bottom',
  };
}

export function readSubStyle(): SubtitleStyle {
  try {
    const raw = globalThis.localStorage?.getItem(SUB_STYLE_KEY);
    return normalizeSubStyle(raw ? (JSON.parse(raw) as Partial<SubtitleStyle>) : null);
  } catch {
    return { ...DEFAULT_SUB_STYLE };
  }
}

export function writeSubStyle(s: SubtitleStyle): void {
  try { globalThis.localStorage?.setItem(SUB_STYLE_KEY, JSON.stringify(s)); } catch { /* ignoré */ }
}

/** Décalage de synchronisation par pas de 0,1 s, borné à ±60 s. */
export function stepOffset(current: number, deltaSec: number): number {
  return clamp(Math.round((current + deltaSec) * 10) / 10, -60, 60);
}

export function offsetLabel(sec: number): string {
  const v = Math.round(sec * 10) / 10;
  return (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + ' s';
}
