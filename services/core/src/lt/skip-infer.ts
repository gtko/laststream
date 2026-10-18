import { median } from '../user/skip-segments.js';

/** Écart maximal (secondes) entre deux épisodes pour que leurs segments concordent (position et durée). */
export const AGREE_SECONDS = 5;
/** Nombre minimal d'épisodes de la saison (hors cible) qui doivent concorder. */
export const MIN_AGREEING = 2;

/**
 * Segment d'un épisode voisin. Intro : `a` = début, `b` = fin (secondes depuis le début). Générique : `a` et `b` sont
 * les distances à la fin de l'épisode (durée − début, durée − fin), pour que la position se compare à la fin.
 */
export interface Span {
  episode: number;
  a: number;
  b: number;
}

interface Consensus {
  a: number;
  b: number;
  support: number;
}

/**
 * Plage consensuelle : pour chaque ancre, les épisodes dont `a` est à ±AGREE_SECONDS et dont la longueur (b − a) l'est
 * aussi. Garde le groupe le plus nombreux (le plus tôt en cas d'égalité), s'il compte au moins MIN_AGREEING épisodes.
 * Bornes : médianes du groupe.
 */
export function consensus(spans: readonly Span[]): Consensus | undefined {
  let best: Consensus | undefined;
  for (const anchor of spans) {
    const length = anchor.b - anchor.a;
    const group = spans.filter(
      (other) => Math.abs(other.a - anchor.a) <= AGREE_SECONDS && Math.abs(other.b - other.a - length) <= AGREE_SECONDS,
    );
    if (group.length < MIN_AGREEING) continue;
    const candidate: Consensus = {
      a: median(group.map((span) => span.a)),
      b: median(group.map((span) => span.b)),
      support: group.length,
    };
    if (
      best === undefined ||
      candidate.support > best.support ||
      (candidate.support === best.support && candidate.a < best.a)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Intro déduite : début et fin médians des épisodes voisins qui concordent. */
export function inferIntro(spans: readonly Span[]): { start: number; end: number } | undefined {
  const found = consensus(spans);
  return found === undefined ? undefined : { start: found.a, end: found.b };
}

/**
 * Générique déduit, par rapport à la fin de l'épisode : les bornes médianes (distances à la fin) sont reportées sur la
 * durée de l'épisode cible. Refusé si la plage sort de l'épisode.
 */
export function inferCredits(spans: readonly Span[], duration: number): { start: number; end: number } | undefined {
  const found = consensus(spans);
  if (found === undefined) return undefined;
  const start = duration - found.a;
  const end = duration - found.b;
  if (start < 0 || end > duration || start >= end) return undefined;
  return { start, end };
}
