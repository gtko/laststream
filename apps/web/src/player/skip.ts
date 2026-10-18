import { getSkipPref, type SkipPrefName } from '../data/prefs';

/* Segments de saut (intro, récap, générique) fournis par lastAddon : lecture tolérante, segment actif, repères. */

export type SkipKind = 'intro' | 'recap' | 'credits' | 'postcredits' | 'preview';

export interface SkipSegment {
  kind: SkipKind;
  start: number;
  end: number;
  /** Déduit d'une autre saison par lastAddon, pas confirmé pour cet épisode : le bouton demande confirmation. */
  inferred?: boolean;
  /** Confiance de la source (0 à 1), si elle la donne. */
  confidence?: number;
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
    out.push({ kind: r.kind as SkipKind, start: r.start, end: r.end, ...(r.inferred === true ? { inferred: true } : {}), ...(typeof r.confidence === 'number' ? { confidence: r.confidence } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Libellé du bouton : « Passer l'intro » ou, pour un segment déduit, « Passer l'intro ? ». */
export function skipLabel(seg: Pick<SkipSegment, 'kind' | 'inferred'>): string {
  return SKIP_LABEL[seg.kind] + (seg.inferred ? ' ?' : '');
}

export const SKIP_LABEL: Record<SkipKind, string> = {
  intro: 'Passer l’intro', recap: 'Passer le récap', credits: 'Passer le générique', postcredits: 'Passer la scène post-générique', preview: 'Passer l’aperçu',
};

/** Segment à proposer à l’instant `t` (intro / récap / aperçu ; le générique relève de la carte « épisode suivant »). */
export function activeSkip(segments: readonly SkipSegment[], t: number): SkipSegment | null {
  return segments.find((s) => (s.kind === 'intro' || s.kind === 'recap' || s.kind === 'preview') && t >= s.start - 0.25 && t < s.end - 1) ?? null;
}

export const CREDITS_MIN_CONFIDENCE = 0.6;
/** Sans données fiables, la carte « épisode suivant » n'apparaît que dans les dernières secondes. */
export const FALLBACK_TAIL_SECONDS = 25;

/** Un générique n'est retenu que s'il est fiable (ni déduit, ni peu sûr) et commence dans les 15 % finaux (4 min au plus). */
export function validCredits(seg: SkipSegment, duration: number): boolean {
  if (seg.kind !== 'credits' || seg.inferred) return false;
  if (typeof seg.confidence === 'number' && seg.confidence < CREDITS_MIN_CONFIDENCE) return false;
  return seg.start >= duration - Math.min(duration * 0.15, 240) && seg.start < duration;
}

/** Début du générique de fin : segment valide, sinon les 25 dernières secondes. */
export function creditsStart(segments: readonly SkipSegment[], duration: number): number | null {
  if (!(duration > 0)) return null;
  const c = segments.find((s) => validCredits(s, duration));
  if (c) return c.start;
  return duration > FALLBACK_TAIL_SECONDS * 2 ? duration - FALLBACK_TAIL_SECONDS : null;
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
  // Jamais pendant une intro ou un récap.
  if (segments.some((s) => (s.kind === 'intro' || s.kind === 'recap') && t >= s.start && t < s.end)) return hidden;
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
export function autoSkipEnabled(kind: SkipKind, pref: (n: SkipPrefName) => boolean = getSkipPref, inferred = false): boolean {
  if (inferred) return false;
  if (kind === 'intro') return pref('intro');
  if (kind === 'recap') return pref('recap');
  return false;
}

/** Repères de chapitres sur la barre de lecture, en fraction de la durée. */
export function chapterMarks(segments: readonly SkipSegment[], duration: number): Array<{ kind: SkipKind; from: number; to: number }> {
  if (!duration) return [];
  return segments.map((s) => ({ kind: s.kind, from: Math.min(1, s.start / duration), to: Math.min(1, s.end / duration) }));
}

// ---------- Analyse et nouvelle interrogation des segments ----------

export const REPOLL_EVERY_MS = 30_000;
export const REPOLL_MAX = 10;
export const ANALYZE_MIN_SECONDS = 60;
export const ANALYZE_MAX_SECONDS = 86_400;
const STREAMING_SERVER_PORT = '11470';

/** Adresse privée ou locale : boucle locale, réseau privé, lien local, nom sans point ou en .local. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.localhost') || (!h.includes('.') && !h.includes(':'))) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h.includes(':') && (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd'));
}

/**
 * Adresse à confier à lastAddon pour analyser l'épisode : le lien direct réellement lu (débrideur…) ou le serveur de
 * streaming local (127.0.0.1:11470, repris même derrière le relais /_ss). Jamais une autre adresse privée ; null sinon.
 */
export function analyzeUrl(url: string, serverBase = '', proxyPath = '/_ss'): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Derrière le relais de l'application, on redonne l'adresse du serveur de streaming local.
  if (serverBase && serverBase.endsWith(proxyPath) && url.startsWith(serverBase)) {
    return 'http://127.0.0.1:' + STREAMING_SERVER_PORT + url.slice(serverBase.length);
  }
  if (isPrivateHost(u.hostname)) {
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    return loopback && u.port === STREAMING_SERVER_PORT ? url : null;
  }
  return url;
}

export function validAnalyzeDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration >= ANALYZE_MIN_SECONDS && duration <= ANALYZE_MAX_SECONDS;
}

/** Nouvelle interrogation des segments pendant que lastAddon analyse l'épisode (toutes les 30 s, 10 fois au plus, en lecture). */
export function shouldRepoll(s: { analyzing: boolean; polls: number; lastAt: number; now: number; playing: boolean }): boolean {
  return s.analyzing && s.playing && s.polls < REPOLL_MAX && s.now - s.lastAt >= REPOLL_EVERY_MS;
}

// ---------- Envoi de segments à lastAddon ----------

export type MarkKind = 'intro' | 'recap' | 'credits';

export interface SkipSubmission {
  type: 'movie' | 'series';
  imdbId: string;
  season: number;
  episode: number;
  kind: MarkKind;
  start: number;
  end: number;
  duration: number;
  /** Retour négatif : « ce n'est pas l'intro ». */
  negative?: boolean;
}

/** Valide un segment saisi à la main (début < fin, 3 s au moins, dans la durée) ; null si invalide. */
export function buildSubmission(
  target: { type: 'movie' | 'series'; imdbId: string; season: number; episode: number },
  kind: MarkKind, start: number, end: number, duration: number, negative = false,
): SkipSubmission | null {
  if (!target.imdbId || !Number.isFinite(start) || !Number.isFinite(end) || !(duration > 0)) return null;
  const a = Math.max(0, Math.round(start * 10) / 10);
  const b = Math.min(duration, Math.round(end * 10) / 10);
  if (b - a < 3) return null;
  return { ...target, kind, start: a, end: b, duration: Math.round(duration * 10) / 10, ...(negative ? { negative: true } : {}) };
}
