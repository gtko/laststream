/* Sous-titres texte de l'hôte, partagés aux invités par le canal relais (trames SUBS, voir src/relay/protocol.ts).
 * Seul le TEXTE des cues transite : pas d'URL, ni dans les pistes ni dans les journaux. Les id et libellés sont générés
 * à partir de la langue ; l'adresse de la source n'entre jamais ici. Côté invité, chaque message est validé à la lettre. */

import type { Cue } from '../player/subs';
import { langName, normalizeLang } from '../player/tracks';
import { MAX_SUBS_WIRE_BYTES } from '../relay/protocol';

export interface PartySubtitleTrack {
  id: string;
  lang: string;
  label: string;
  vtt: string;
}

/** Sous-titre chargé par l'hôte : langue et cues en mémoire (aucune adresse). */
export interface LoadedSubtitle {
  lang: string;
  cues: readonly Cue[];
}

export const MAX_PARTY_TRACKS = 8;
/** VTT par piste, et total des pistes d'un message. */
export const MAX_VTT_BYTES = 512 * 1024;
export const MAX_PARTY_BYTES = 2 * 1024 * 1024;

const HEADER = 'WEBVTT\n\n';
const TRACK_KEYS = ['id', 'lang', 'label', 'vtt'];
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Horodatage VTT « hh:mm:ss.mmm », jamais négatif. */
function stamp(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms % 1000, 3)}`;
}

/** Échappement du texte VTT : & < > et caractères de contrôle retirés, tabulations remplacées par une espace. */
function escapeText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\t/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Une ligne de cue : seules <i>, <b>, <u> sont gardées (équilibrées : une balise fermante sans ouvrante est retirée, une
 * ouvrante restée ouverte est fermée en fin de ligne). Les autres balises sont retirées ; le reste est échappé.
 */
function cleanLine(line: string): string {
  const open: string[] = [];
  let out = '';
  for (const tok of line.split(/(<[^>]*>)/)) {
    if (tok === '') continue;
    if (tok.startsWith('<') && tok.endsWith('>')) {
      const m = /^<(\/?)(i|b|u)\s*>$/i.exec(tok);
      if (!m) continue;
      const name = m[2].toLowerCase();
      if (m[1] === '') {
        open.push(name);
        out += `<${name}>`;
      } else {
        const at = open.lastIndexOf(name);
        if (at < 0) continue;
        while (open.length > at) out += `</${open.pop()}>`;
      }
      continue;
    }
    out += escapeText(tok);
  }
  while (open.length > 0) out += `</${open.pop()}>`;
  return out.trim();
}

/** Texte d'une cue nettoyé, lignes vides retirées ; chaîne vide si rien ne reste. */
function cleanText(raw: string): string {
  return raw
    .replace(/\{\\[^}\n]*\}/g, '')
    .split('\n')
    .map(cleanLine)
    .filter((l) => l !== '')
    .join('\n');
}

/** Bloc VTT d'une cue, ou null si elle est vide ou sans minutage fini et croissant. */
function cueBlock(cue: Cue): string | null {
  if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return null;
  const text = cleanText(cue.text);
  if (text === '') return null;
  return `${stamp(cue.start)} --> ${stamp(cue.end)}\n${text}\n\n`;
}

/**
 * VTT normalisé d'une liste de cues. Les cues vides ou invalides sont ignorées. Au-delà de `maxBytes` (UTF-8), la sortie
 * s'arrête avant la première cue qui ne tient plus : la piste est tronquée par cues entières, jamais au milieu d'une cue.
 */
export function cuesToVtt(cues: readonly Cue[], maxBytes = MAX_VTT_BYTES): string {
  let out = HEADER;
  let size = encoder.encode(HEADER).byteLength;
  for (const cue of cues) {
    const block = cueBlock(cue);
    if (block === null) continue;
    const n = encoder.encode(block).byteLength;
    if (size + n > maxBytes) break;
    out += block;
    size += n;
  }
  return out;
}

const safeLang = (raw: string): string => {
  const code = normalizeLang(raw);
  return /^[a-z]{2,3}$/.test(code) ? code : '';
};

/**
 * Pistes à partager pour un ensemble donné : au plus MAX_PARTY_TRACKS, total de VTT borné par MAX_PARTY_BYTES (une piste qui
 * ne tient pas arrête la liste). Une piste dont le VTT dépasse MAX_VTT_BYTES est écartée.
 */
export function boundTracks(tracks: readonly PartySubtitleTrack[]): PartySubtitleTrack[] {
  const out: PartySubtitleTrack[] = [];
  let total = 0;
  for (const t of tracks.slice(0, MAX_PARTY_TRACKS)) {
    const n = encoder.encode(t.vtt).byteLength;
    if (n > MAX_VTT_BYTES) continue;
    if (total + n > MAX_PARTY_BYTES) break;
    total += n;
    out.push(t);
  }
  return out;
}

/**
 * Pistes partagées pour le sous-titre texte chargé par l'hôte : une piste (id « s1 »), langue normalisée, libellé dérivé de
 * la langue. Rien si aucun cue n'est rendable ou si l'hôte n'a pas de sous-titre texte chargé (mpv, rien à partager).
 */
export function buildPartySubtitles(loaded: LoadedSubtitle | null): PartySubtitleTrack[] {
  if (!loaded || loaded.cues.length === 0) return [];
  const vtt = cuesToVtt(loaded.cues, MAX_VTT_BYTES);
  if (vtt === HEADER) return [];
  const lang = safeLang(loaded.lang);
  return boundTracks([{ id: 's1', lang, label: lang ? langName(lang) : 'Sous-titres', vtt }]);
}

/** Charge JSON du message SUBS : les pistes, sans autre champ que celui de PartySubtitleTrack. */
export function encodePartySubtitles(tracks: readonly PartySubtitleTrack[]): Uint8Array {
  const clean = boundTracks(tracks).map(({ id, lang, label, vtt }) => ({ id, lang, label, vtt }));
  return encoder.encode(JSON.stringify(clean));
}

const hasControl = (s: string): boolean => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const looksLikeUrl = (s: string): boolean => /:\/\/|\bwww\./i.test(s);

function validId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v);
}

function validLang(v: unknown): v is string {
  return typeof v === 'string' && (v === '' || /^[a-z]{2,3}$/.test(v));
}

function validLabel(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 80 && !hasControl(v) && !looksLikeUrl(v);
}

/** VTT reçu : en-tête WEBVTT, pas de caractère de contrôle, et « < » seulement pour <i>, <b>, <u> (texte seulement). */
function validVtt(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('WEBVTT')) return false;
  if (encoder.encode(v).byteLength > MAX_VTT_BYTES) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) return false;
  return !/<(?!\/?[biu]>)/i.test(v);
}

function parseTrack(item: unknown): PartySubtitleTrack | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  if (Object.keys(o).some((k) => !TRACK_KEYS.includes(k))) return null;
  if (!validId(o.id) || !validLang(o.lang) || !validLabel(o.label) || !validVtt(o.vtt)) return null;
  return { id: o.id, lang: o.lang, label: o.label, vtt: o.vtt };
}

/**
 * Décodage d'un message SUBS reçu. Rend null (tout le message rejeté) dès qu'une entrée est malformée : JSON invalide, pas un
 * tableau, plus de 8 pistes, champ inconnu (dont tout champ d'adresse), type ou taille hors bornes, total au-delà de 2 Mio.
 */
export function parsePartySubtitles(bytes: Uint8Array): PartySubtitleTrack[] | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SUBS_WIRE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(strictDecoder.decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > MAX_PARTY_TRACKS) return null;
  const out: PartySubtitleTrack[] = [];
  let total = 0;
  for (const item of raw) {
    const track = parseTrack(item);
    if (track === null) return null;
    total += encoder.encode(track.vtt).byteLength;
    if (total > MAX_PARTY_BYTES) return null;
    out.push(track);
  }
  return out;
}
