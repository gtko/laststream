interface Interval {
  start: number;
  end: number;
}

export interface CreditsGuess {
  /** Secondes depuis le début de la fenêtre analysée. */
  start: number;
  confidence: number;
}

const MIN_BLACK_SECONDS = 25;
/** Marge (secondes) entre la fin de la zone noire et la fin de la fenêtre. */
const END_TOLERANCE = 4;

/** Intervalles d'une sortie ffmpeg (blackdetect : black_start/black_end, silencedetect : silence_start/silence_end). */
function parseIntervals(stderr: string, startKey: string, endKey: string, windowLength: number): Interval[] {
  const intervals: Interval[] = [];
  let open: number | undefined;
  const pattern = new RegExp(`${startKey}[:=]\\s*(-?[\\d.]+)|${endKey}[:=]\\s*(-?[\\d.]+)`, 'g');
  for (const match of stderr.matchAll(pattern)) {
    if (match[1] !== undefined) {
      open = Math.max(0, Number(match[1]));
    } else if (match[2] !== undefined && open !== undefined) {
      intervals.push({ start: open, end: Number(match[2]) });
      open = undefined;
    }
  }
  // Zone encore ouverte à la fin de la fenêtre (ffmpeg n'émet pas toujours la fin au EOF).
  if (open !== undefined) intervals.push({ start: open, end: windowLength });
  return intervals.filter((interval) => Number.isFinite(interval.start) && interval.end > interval.start);
}

/**
 * Début du générique d'après blackdetect (zone sombre longue qui va jusqu'à la fin) et silencedetect (de la musique,
 * donc peu de silence, renforce la confiance). Sans zone noire de 25 s au moins qui atteint la fin : undefined.
 */
export function parseCreditsOutput(stderr: string, windowLength: number): CreditsGuess | undefined {
  const black = parseIntervals(stderr, 'black_start', 'black_end', windowLength);
  const last = black.at(-1);
  if (last === undefined) return undefined;
  if (windowLength - last.end > END_TOLERANCE) return undefined;
  const length = last.end - last.start;
  // Une zone noire qui couvre toute la fenêtre n'indique pas où commence le générique.
  if (length < MIN_BLACK_SECONDS || last.start < 5) return undefined;
  const silence = parseIntervals(stderr, 'silence_start', 'silence_end', windowLength);
  const silent = silence.reduce(
    (sum, interval) => sum + Math.max(0, Math.min(interval.end, last.end) - Math.max(interval.start, last.start)),
    0,
  );
  const music = silent / length < 0.5;
  return { start: last.start, confidence: music ? 0.7 : 0.6 };
}
