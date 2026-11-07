import type { MarkKind } from './skip';

/* Marquage d'un segment (intro, récap, générique) directement sur la barre de progression : calculs de la plage. */

/** Durée minimale d'un segment accepté par lastAddon (voir `buildSubmission`). */
export const MARK_MIN = 3;
/** Largeur de la plage proposée à l'ouverture. */
const START_SPAN = 30;

export interface MarkRange { start: number; end: number }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Plage de départ : de la position de lecture à +30 s, bornée à la durée. */
export function initialRange(time: number, duration: number): MarkRange {
  if (!(duration > MARK_MIN)) return { start: 0, end: Math.max(MARK_MIN, duration || MARK_MIN) };
  const start = clamp(Number.isFinite(time) ? time : 0, 0, duration - MARK_MIN);
  return { start, end: Math.min(duration, start + START_SPAN) };
}

/** Déplace une poignée en gardant la plage dans la durée et à 3 s au moins ; l'autre poignée ne bouge pas. */
export function moveHandle(range: MarkRange, which: 'start' | 'end', t: number, duration: number): MarkRange {
  if (!(duration > 0) || !Number.isFinite(t)) return range;
  if (which === 'start') return { start: clamp(t, 0, Math.max(0, range.end - MARK_MIN)), end: range.end };
  return { start: range.start, end: clamp(t, Math.min(duration, range.start + MARK_MIN), duration) };
}

/** Type proposé d'après la place de la plage dans l'épisode (un clic suffit à le corriger) : générique en fin d'épisode, sinon intro. */
export function guessKind(range: MarkRange, duration: number): MarkKind {
  return duration > 0 && range.start >= duration * 0.75 ? 'credits' : 'intro';
}

/** Une plage est envoyable si elle dure 3 s au moins. */
export const rangeValid = (r: MarkRange): boolean => r.end - r.start >= MARK_MIN - 1e-6;
