import { getSkipPref, type SkipPrefName } from '../data/prefs';

/* Segments de saut (intro, récap, générique) fournis par lastAddon : lecture tolérante, segment actif, repères. */

export type SkipKind = 'intro' | 'recap' | 'credits' | 'postcredits' | 'preview';

export interface SkipSegment {
  kind: SkipKind;
  start: number;
  end: number;
}

const KINDS: readonly string[] = ['intro', 'recap', 'credits', 'postcredits', 'preview'];

export function normalizeSkip(resp: unknown): SkipSegment[] {
  const list = (resp as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) return [];
  const out: SkipSegment[] = [];
  for (const s of list) {
    const r = s as Partial<SkipSegment> | null;
    if (!r || typeof r.kind !== 'string' || !KINDS.includes(r.kind)) continue;
    if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end - r.start < 3 || r.start < 0) continue;
    out.push({ kind: r.kind as SkipKind, start: r.start, end: r.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export const SKIP_LABEL: Record<SkipKind, string> = {
  intro: 'Passer l’intro', recap: 'Passer le récap', credits: 'Passer le générique', postcredits: 'Passer la scène post-générique', preview: 'Passer l’aperçu',
};

/** Segment à proposer à l’instant `t` (intro / récap / aperçu ; le générique relève de la carte « épisode suivant »). */
export function activeSkip(segments: readonly SkipSegment[], t: number): SkipSegment | null {
  return segments.find((s) => (s.kind === 'intro' || s.kind === 'recap' || s.kind === 'preview') && t >= s.start - 0.25 && t < s.end - 1) ?? null;
}

/** Début du générique de fin : segment connu, sinon les 45 dernières secondes. */
export function creditsStart(segments: readonly SkipSegment[], duration: number): number | null {
  const c = segments.find((s) => s.kind === 'credits' && s.start > duration * 0.5);
  if (c) return c.start;
  return duration > 600 ? duration - 45 : null;
}

export interface NextCardState {
  show: boolean;
  /** Secondes avant le lancement automatique (null : pas de compte à rebours, ou attente de la fin d'une scène post-générique). */
  countdown: number | null;
  /** Part restante du compte à rebours (1 → 0), pour l'anneau. */
  ratio: number;
}

export const NEXT_COUNTDOWN = 10;

/** Instant où le compte à rebours démarre : début du générique, ou fin de la scène post-générique si elle existe. */
export function countdownStart(segments: readonly SkipSegment[], duration: number): number | null {
  const start = creditsStart(segments, duration);
  if (start === null) return null;
  const post = segments.find((s) => s.kind === 'postcredits' && s.start >= start - 1);
  return post ? Math.max(start, post.end) : start;
}

/**
 * Carte « épisode suivant » : affichée dès le générique ; le compte à rebours (10 s) n'existe que si le saut automatique
 * est activé, et attend la fin de la scène post-générique quand il y en a une.
 */
export function nextEpisodeCard(segments: readonly SkipSegment[], t: number, duration: number, hasNext: boolean, auto: boolean): NextCardState {
  const hidden: NextCardState = { show: false, countdown: null, ratio: 0 };
  if (!hasNext || !duration) return hidden;
  const start = creditsStart(segments, duration);
  if (start === null || t < start) return hidden;
  if (!auto) return { show: true, countdown: null, ratio: 0 };
  const from = countdownStart(segments, duration) ?? start;
  if (t < from) return { show: true, countdown: null, ratio: 0 };
  const countdown = Math.max(0, NEXT_COUNTDOWN - Math.floor(t - from));
  return { show: true, countdown, ratio: countdown / NEXT_COUNTDOWN };
}

/** Films : le générique est atteint (ligne « Plus d'infos / Recommandés »). */
export function movieEndRow(segments: readonly SkipSegment[], t: number, duration: number): boolean {
  const start = creditsStart(segments, duration);
  return start !== null && t >= start;
}

/** Saut automatique selon les réglages (`intro`, `recap`). */
export function autoSkipEnabled(kind: SkipKind, pref: (n: SkipPrefName) => boolean = getSkipPref): boolean {
  if (kind === 'intro') return pref('intro');
  if (kind === 'recap') return pref('recap');
  return false;
}

/** Repères de chapitres sur la barre de lecture, en fraction de la durée. */
export function chapterMarks(segments: readonly SkipSegment[], duration: number): Array<{ kind: SkipKind; from: number; to: number }> {
  if (!duration) return [];
  return segments.map((s) => ({ kind: s.kind, from: Math.min(1, s.start / duration), to: Math.min(1, s.end / duration) }));
}
