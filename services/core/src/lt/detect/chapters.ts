import type { AutoKind } from '../../user/skip-segments.js';
import { isRecord } from '../../sources/http.js';
import { runProcess } from './proc.js';
import type { MediaTools } from './tools.js';

/** Segment trouvé (secondes depuis le début de l'épisode). */
export interface Found {
  kind: AutoKind;
  start: number;
  end: number;
}

/** Confiance d'un segment tiré des chapitres du conteneur. */
export const CHAPTER_CONFIDENCE = 0.95;
const MIN_SEGMENT = 5;

/** Minuscules, sans accents ni ponctuation (les caractères CJK sont conservés). */
function normalize(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const INTRO_PHRASES =
  /(^| )(opening credits|title sequence|generique d ouverture|generique de debut|generique debut|ouverture|opening|introduction|intro|theme song)( |$)|^op( ?\d+)?$|オープニング|イントロ|^op$/;
const CREDITS_PHRASES =
  /(^| )(end credits|ending credits|closing credits|generique de fin|generique fin|ending|outro|credits|end titles)( |$)|^ed( ?\d+)?$|エンディング/;
const PREVIEW_PHRASES =
  /(^| )(preview|previews|next episode|next time|coming up|avant premiere|prochain episode|episode suivant|a suivre|prochainement|teaser)( |$)|次回|予告/;
const RECAP_PHRASES =
  /(^| )(recap|resume|previously|precedemment|precedemment dans|dans les episodes precedents|last time|summary)( |$)|前回|あらすじ/;

/**
 * Type de segment d'un titre de chapitre (FR, EN, JA), ou 'bare' pour un « Générique » sans précision (intro en
 * début d'épisode, fin sinon), ou undefined (contenu, prologue, cold open : pas à sauter).
 */
export function classifyChapterTitle(title: string): AutoKind | 'bare' | undefined {
  const text = normalize(title);
  if (text === '') return undefined;
  if (PREVIEW_PHRASES.test(text)) return 'preview';
  if (RECAP_PHRASES.test(text)) return 'recap';
  if (INTRO_PHRASES.test(text)) return 'intro';
  if (CREDITS_PHRASES.test(text)) return 'credits';
  if (/^generique$/.test(text)) return 'bare';
  return undefined;
}

interface Chapter {
  start: number;
  end: number;
  title: string;
}

/** Chapitres d'une sortie `ffprobe -show_chapters -of json`. */
function parseChapters(json: unknown): Chapter[] {
  if (!isRecord(json) || !Array.isArray(json.chapters)) return [];
  const chapters: Chapter[] = [];
  for (const item of json.chapters) {
    if (!isRecord(item)) continue;
    const start = Number(item.start_time);
    const end = Number(item.end_time);
    const tags = isRecord(item.tags) ? item.tags : {};
    const title = typeof tags.title === 'string' ? tags.title : typeof tags.TITLE === 'string' ? tags.TITLE : '';
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) chapters.push({ start, end, title });
  }
  return chapters.sort((a, b) => a.start - b.start);
}

/** Segments à sauter déduits des chapitres : le premier de chaque type, au moins 5 s. */
export function segmentsFromChapters(chapters: readonly Chapter[], duration: number): Found[] {
  const found: Found[] = [];
  const seen = new Set<AutoKind>();
  for (const chapter of chapters) {
    let kind = classifyChapterTitle(chapter.title);
    if (kind === undefined) continue;
    if (kind === 'bare') kind = chapter.start > duration * 0.5 ? 'credits' : 'intro';
    if (seen.has(kind) || chapter.end - chapter.start < MIN_SEGMENT) continue;
    seen.add(kind);
    found.push({ kind, start: chapter.start, end: Math.min(chapter.end, duration) });
  }
  return found;
}

/** Chapitres d'un média (ffprobe lit seulement l'en-tête, via le relais local). */
export async function probeChapters(tools: MediaTools, mediaUrl: string, timeoutMs = 45_000): Promise<Chapter[]> {
  const result = await runProcess(
    tools.ffprobe,
    ['-v', 'error', '-show_chapters', '-of', 'json', '-rw_timeout', '15000000', mediaUrl],
    { timeoutMs, maxStdout: 4 * 1024 * 1024 },
  );
  if (result.code !== 0) return [];
  try {
    return parseChapters(JSON.parse(result.stdout.toString('utf8')) as unknown);
  } catch {
    return [];
  }
}
