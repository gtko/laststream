import { CINEMA_ELEMENTS, DEFAULT_CINEMA_HIDDEN, cinemaOn, type CinemaElement, type CinemaState, type CinemaUntil, type SocialState } from '../data/socialStore';
import type { Message } from '../data/socialV2Api';
import type { PlaybackSocial } from '../data/socialV3Api';

/* Logique pure du social pendant la lecture (Social v3, lot F5) : mode cinéma, file de bulles, carte de chaleur,
 * anti-spoiler, « regarde aussi ». Aucun DOM, aucun réseau : tout est testé en direct. */

// ---- Mode cinéma ----
/** Éléments masqués proposés d'office par la maquette : bulles, notes, marqueurs et présence d'amis. */
export const CINEMA_MENU_DEFAULT: CinemaElement[] = [...DEFAULT_CINEMA_HIDDEN, 'friendsPresence'];

export const CINEMA_LABELS: Record<CinemaElement, string> = {
  bubbles: 'Bulles de messages',
  notes: 'Notes et emojis',
  markers: 'Marqueurs sur la barre',
  friendsPresence: '« Un ami regarde aussi »',
  myPresence: 'Ma présence (invisible)',
  partyRequests: 'Demandes de watch party',
};

export type CinemaDuration = 'film' | 'hour' | 'always';
export const HOUR_MS = 3_600_000;

/** Échéance du store pour une durée choisie dans le menu. */
export function untilFor(d: CinemaDuration, now: number): CinemaUntil {
  return d === 'hour' ? now + HOUR_MS : d;
}

/** Durée du menu correspondant à une échéance du store (une échéance numérique = « 1 heure »). */
export function durationOf(until: CinemaUntil | null): CinemaDuration {
  return until === 'always' ? 'always' : typeof until === 'number' ? 'hour' : 'film';
}

/** Réglage de départ du lecteur selon `prefs.playbackSocial` : 'cinema' démarre le mode, 'messages' ne garde que les bulles. */
export function startPolicy(p: PlaybackSocial | undefined): { cinema: boolean; quiet: CinemaElement[] } {
  if (p === 'cinema') return { cinema: true, quiet: [] };
  if (p === 'messages') return { cinema: false, quiet: ['notes', 'markers', 'friendsPresence'] };
  return { cinema: false, quiet: [] };
}

/** Éléments sociaux masqués à cet instant : ceux du mode cinéma actif, plus ceux du réglage « messages seulement ». */
export function hiddenElements(c: CinemaState, now: number, quiet: readonly CinemaElement[] = []): Set<CinemaElement> {
  const out = new Set<CinemaElement>(quiet);
  if (cinemaOn(c, now)) for (const e of c.hidden) out.add(e);
  return out;
}

/** Cases du menu : ordre fixe de la maquette. */
export const menuElements = (): readonly CinemaElement[] => CINEMA_ELEMENTS;

/** Réglage proposé quand le mode démarre : celui du store s'il a été touché, sinon la maquette. */
export function menuSelection(hidden: readonly CinemaElement[]): CinemaElement[] {
  const same = hidden.length === DEFAULT_CINEMA_HIDDEN.length && DEFAULT_CINEMA_HIDDEN.every((e) => hidden.includes(e));
  return same ? [...CINEMA_MENU_DEFAULT] : [...hidden];
}

export function toggleElement(list: readonly CinemaElement[], el: CinemaElement): CinemaElement[] {
  return list.includes(el) ? list.filter((x) => x !== el) : [...list, el];
}

/** Le mode « jusqu'à la fin du film » prend fin quand la lecture est terminée ou à moins d'une seconde de la fin. */
/**
 * Fin de session du lecteur : le mode cinéma est levé à la vraie fermeture, pas au changement d'épisode (`silent`), où la
 * séance continue.
 */
export function cinemaEndsOnTeardown(silent: boolean, active: boolean): boolean {
  return !silent && active;
}

export function filmEnded(until: CinemaUntil | null, st: { time: number; duration: number; ended?: boolean }): boolean {
  if (until !== 'film') return false;
  if (st.ended) return true;
  return Number.isFinite(st.duration) && st.duration > 30 && st.time >= st.duration - 1;
}

/** « 1 h 33 restantes » / « 12 min restantes » pour la ligne « jusqu'à la fin de ce film ». */
export function remainingLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h} h ${String(mm).padStart(2, '0')} restantes`;
  return `${Math.max(1, m)} min restantes`;
}

/** Indicateur discret : « Mode cinéma · N messages en attente » (pas de compteur à zéro, singulier à un). */
export function indicatorText(count: number): string {
  if (count <= 0) return 'Mode cinéma';
  return `Mode cinéma · ${count} message${count > 1 ? 's' : ''} en attente`;
}

// ---- File de bulles ----
export const STACK_MAX = 3;
export interface BubbleQueue { current: Message | null; next: Message[] }
export const emptyQueue = (): BubbleQueue => ({ current: null, next: [] });

/** Un message arrive : il prend la place libre, sinon il s'empile derrière (jamais deux fois, au plus STACK_MAX en attente). */
export function pushBubble(q: BubbleQueue, m: Message, locked: boolean): BubbleQueue {
  if (q.current?.id === m.id || q.next.some((x) => x.id === m.id)) return q;
  if (!q.current && !locked) return { current: m, next: q.next };
  return { current: q.current, next: [...q.next, m].slice(-STACK_MAX) };
}

/** La bulle courante se ferme : la plus ancienne en attente la remplace. */
export function advanceBubble(q: BubbleQueue): BubbleQueue {
  const [head, ...rest] = q.next;
  return { current: head ?? null, next: rest };
}

// ---- Carte de chaleur ----
export type HeatLevel = 0 | 1 | 2 | 3;
export interface HeatBar { h: number; level: HeatLevel }

/** Barres de la carte : hauteur en 0..1 (2 px minimum côté rendu) et teinte selon la part du maximum. Rien si tout est nul. */
export function heatBars(buckets: readonly number[]): HeatBar[] {
  const clean = buckets.map((b) => (Number.isFinite(b) && b > 0 ? b : 0));
  const max = Math.max(0, ...clean);
  if (max <= 0) return [];
  return clean.map((v) => {
    const r = v / max;
    return { h: r, level: r >= 0.8 ? 3 : r >= 0.5 ? 2 : r >= 0.25 ? 1 : 0 };
  });
}

/** Index de la tranche portant la position courante. */
export function bucketAt(time: number, duration: number, n: number): number {
  if (!(duration > 0) || n <= 0 || !Number.isFinite(time)) return -1;
  return Math.min(n - 1, Math.max(0, Math.floor((time / duration) * n)));
}

// ---- Anti-spoiler ----
/** Une note est « à venir » (estompée, contenu caché) si elle se situe au-delà de la position de lecture. */
export function isFuture(notePos: number, time: number, antiSpoiler: boolean): boolean {
  return antiSpoiler && Number.isFinite(notePos) && Number.isFinite(time) && notePos > time + 1;
}

// ---- « Un ami regarde aussi » ----
export interface WatchMedia { type: 'movie' | 'series'; tmdbId: number; season?: number; episode?: number }
export interface WatchPeer { pid: string; name: string; color: string; pos: number }
export const WATCH_FRESH_MS = 90_000;

/** Amis et foyer qui regardent le même film ou épisode, avec leur position estimée à `now` (jamais sans `pos`, jamais périmée). */
export function friendsWatching(s: Pick<SocialState, 'friends' | 'household'>, media: WatchMedia | null, now: number, duration = 0): WatchPeer[] {
  if (!media) return [];
  const seen = new Set<string>();
  const out: WatchPeer[] = [];
  for (const f of [...s.friends, ...s.household]) {
    const w = f.watching;
    if (!w || seen.has(f.pid) || f.status === 'offline') continue;
    if (w.type !== media.type || w.tmdbId !== media.tmdbId) continue;
    if (media.type === 'series' && (w.season !== media.season || w.episode !== media.episode)) continue;
    if (typeof w.pos !== 'number' || !Number.isFinite(w.pos) || typeof w.at !== 'number') continue;
    const age = now - w.at;
    if (age > WATCH_FRESH_MS) continue;
    let pos = w.pos + (w.paused ? 0 : Math.max(0, age) / 1000);
    const dur = w.duration ?? duration;
    if (dur > 0) pos = Math.min(pos, dur);
    seen.add(f.pid);
    out.push({ pid: f.pid, name: f.nickname || f.handle.name, color: f.avatarColor, pos: Math.max(0, pos) });
  }
  return out;
}

// ---- Interface tactile ----
/** Version tactile (Android, paysage) : pointeur grossier ou petite fenêtre. Faux hors navigateur. */
export function isTouchLayout(): boolean {
  try {
    const mm = globalThis.matchMedia;
    if (typeof mm !== 'function') return false;
    return mm('(pointer: coarse)').matches || mm('(max-width: 767px)').matches;
  } catch { return false; }
}

/** Initiale d'un avatar de repli (la lettre colorée de la maquette). */
export const initialOf = (name: string): string => (Array.from(name || '?')[0] || '?').toUpperCase();
