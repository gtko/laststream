import type { MediaRef, Note } from '../data/socialV2Api';

/* Timeline des notes du lecteur (Social v2) : fonctions pures, sans DOM ni réseau.
 * `crossing` dit quelles notes une lecture normale vient de franchir ; `rearmed` relâche les notes d'une zone revisitée
 * après un retour en arrière ; `clusterNotes` regroupe les notes trop proches sur la barre et les place en pourcentage. */

/** Saut maximal (s) entre deux relevés pour compter comme une lecture normale : au-delà, c'est un seek ou un saut. */
export const MAX_JUMP = 3;
/** Retour en arrière minimal (s) qui relâche les notes de la zone revisitée. */
const REWIND_MIN = 0.5;
/** Distance (en % de la durée) en dessous de laquelle deux notes forment un même marqueur. */
const CLUSTER_GAP_PCT = 1;
/** Longueur maximale d'une note texte, en caractères (points de code). */
export const NOTE_MAX = 140;
/** Rangée d'emojis rapides du popover « Réagir ici ». */
export const QUICK_EMOJIS: readonly string[] = ['😂', '🔥', '😱', '❤️', '🤯', '😭', '👏'];
/** Couleur de repli pour un marqueur quand la couleur d'avatar reçue n'est pas une couleur sûre. */
export const FALLBACK_COLOR = '#94a3b8';

export type NoteKind = Note['kind'];
type NoteMedia = Pick<MediaRef, 'type' | 'tmdbId' | 'season' | 'episode'>;

export interface CrossingOptions {
  /** Saut maximal entre deux relevés (s) ; défaut MAX_JUMP. */
  maxJump?: number;
  /** Ids déjà franchis : jamais renvoyés une seconde fois. */
  fired?: ReadonlySet<string>;
}

export interface NoteCluster {
  /** Position moyenne du groupe sur la barre, en % (0 à 100). */
  pct: number;
  notes: Note[];
}

/** Clé stable d'un média (film ou épisode), pour filtrer les notes en direct sur le média lu. */
export function mediaKey(m: { type: string; tmdbId: number | string; season?: number | null; episode?: number | null }): string {
  return `${m.type}:${Number(m.tmdbId)}:${m.season ?? ''}:${m.episode ?? ''}`;
}

/** Notes sans doublon d'identifiant (la première occurrence gagne), triées par position. */
export function uniqueNotes(notes: readonly Note[]): Note[] {
  const seen = new Map<string, Note>();
  for (const n of notes) if (!seen.has(n.id)) seen.set(n.id, n);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * Notes que la lecture vient de franchir entre deux relevés (en secondes). Une note est franchie quand
 * `prevPos < pos <= curPos`. Rien n'est franchi pour un retour en arrière, une immobilité, un saut plus grand que
 * `maxStep` (seek) ou une valeur non finie. Les notes de `fired` sont exclues.
 */
export function crossing(prevPos: number, curPos: number, notes: readonly Note[], opts: CrossingOptions = {}): Note[] {
  if (!Number.isFinite(prevPos) || !Number.isFinite(curPos)) return [];
  const step = curPos - prevPos;
  if (step <= 0 || step > (opts.maxJump ?? MAX_JUMP)) return [];
  const fired = opts.fired;
  return uniqueNotes(notes).filter((n) => n.pos > prevPos && n.pos <= curPos && !(fired && fired.has(n.id)));
}

/**
 * Ids des notes à relâcher quand la lecture revient en arrière d'au moins `REWIND_MIN` secondes : celles situées entre
 * `curPos` (exclu) et `prevPos` (inclus). Elles s'afficheront de nouveau en repassant par là.
 */
export function rearmed(prevPos: number, curPos: number, notes: readonly Note[]): string[] {
  if (!Number.isFinite(prevPos) || !Number.isFinite(curPos)) return [];
  if (prevPos - curPos < REWIND_MIN) return [];
  return uniqueNotes(notes).filter((n) => n.pos > curPos && n.pos <= prevPos).map((n) => n.id);
}

/** Position d'une note en % de la barre, ou null si la durée est inconnue ou la position hors de la vidéo. */
export function markerPct(pos: number, duration: number): number | null {
  if (!Number.isFinite(pos) || !Number.isFinite(duration) || duration <= 0) return null;
  if (pos < 0 || pos > duration + 1) return null;
  return Math.min(100, Math.max(0, (pos / duration) * 100));
}

/**
 * Regroupe les notes dont les marqueurs tombent à moins de `gapPct` % l'un de l'autre (chaîne de proximité, ordre des
 * positions). Chaque groupe est placé à la moyenne de ses marqueurs. Notes hors de la vidéo : ignorées.
 */
export function clusterNotes(notes: readonly Note[], duration: number, gapPct: number = CLUSTER_GAP_PCT): NoteCluster[] {
  const placed: Array<{ pct: number; note: Note }> = [];
  for (const note of uniqueNotes(notes)) {
    const pct = markerPct(note.pos, duration);
    if (pct !== null) placed.push({ pct, note });
  }
  const groups: Array<{ sum: number; last: number; notes: Note[] }> = [];
  for (const { pct, note } of placed) {
    const cur = groups[groups.length - 1];
    if (cur && pct - cur.last <= gapPct) {
      cur.notes.push(note);
      cur.sum += pct;
      cur.last = pct;
    } else {
      groups.push({ sum: pct, last: pct, notes: [note] });
    }
  }
  return groups.map((g) => ({ pct: g.sum / g.notes.length, notes: g.notes }));
}

const COLOR_RE = /^(#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|hsl\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?%\s*,\s*\d{1,3}(?:\.\d+)?%\s*\))$/i;

/** Couleur d'avatar utilisable telle quelle en CSS (hexadécimal ou hsl simple) ; sinon la couleur de repli. */
export function safeColor(c: unknown): string {
  return typeof c === 'string' && COLOR_RE.test(c.trim()) ? c.trim() : FALLBACK_COLOR;
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*$/u;

/** Vrai pour un seul emoji (éventuellement avec variante ou modificateur de couleur). */
export function isEmoji(s: string): boolean {
  return EMOJI_RE.test(s);
}

/** Longueur d'un texte en caractères (points de code), comme le serveur la compte. */
export function noteLength(s: string): number {
  return Array.from(s).length;
}

/** Corps de note prêt à envoyer : texte rogné de 1 à 140 caractères, ou emoji seul ; null si invalide. */
export function noteBody(kind: NoteKind, raw: string): string | null {
  const body = raw.trim();
  if (kind === 'emoji') return isEmoji(body) ? body : null;
  if (body === '' || noteLength(body) > NOTE_MAX) return null;
  return body;
}
