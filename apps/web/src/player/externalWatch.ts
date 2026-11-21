/* Suivi d'une lecture dans un lecteur externe (VLC, Infuse…) : l'app ne reçoit pas la position du lecteur, elle l'estime avec le
 * temps passé hors de l'app. Au retour, la position estimée est enregistrée (« Continuer » reprend là) ; à 80 % de la durée, ou à
 * moins de deux minutes de la fin (le générique), le titre ou l'épisode est marqué comme vu. Le suivi survit à la fermeture de
 * l'app (stockage local) : il est réglé au prochain retour ou au prochain démarrage. Fonctions pures testées (externalWatch.test.ts). */
import { userStore, type ProgressEntry } from '../data/userStore';

const STORAGE_KEY = 'laststream.externalWatch';
/** Part de la durée à partir de laquelle une lecture externe compte comme vue. */
const EXTERNAL_WATCHED_RATIO = 0.8;
/** Reste à lire (secondes) en deçà duquel on est au générique : vu, même sous 80 %. */
const CREDITS_TAIL_SEC = 120;
/** Absence trop courte (secondes) pour être une lecture : retour immédiat, app absente, lien refusé. */
const MIN_ELAPSED_SEC = 60;

/** Lecture externe en cours : titre, épisode, durée connue au lancement, départ (ms) et position de départ (s). */
export interface ExternalWatch {
  entry: Omit<ProgressEntry, 'updatedAt' | 'position' | 'duration'>;
  /** Durée en secondes (épisode, film ou estimation de la source) ; 0 si inconnue. */
  duration: number;
  startedAt: number;
  /** Position de départ estimée (relance depuis le même écran) ; 0 sinon. */
  offset: number;
  /** La page a été quittée après le lancement : le lecteur a bien pris la main. Sans cela, rien n'est compté. */
  left: boolean;
}

export interface ExternalEstimate { position: number; duration: number; watched: boolean }

/** Position estimée au retour, ou null si l'absence est trop courte, la page jamais quittée ou la durée inconnue. */
export function estimateExternal(w: ExternalWatch, now: number): ExternalEstimate | null {
  if (!w.left || !(w.duration > 0)) return null;
  const elapsed = (now - w.startedAt) / 1000;
  if (!(elapsed >= MIN_ELAPSED_SEC)) return null;
  const position = Math.min(w.duration, Math.max(0, w.offset) + elapsed);
  const watched = position >= w.duration * EXTERNAL_WATCHED_RATIO || w.duration - position <= CREDITS_TAIL_SEC;
  return { position, duration: w.duration, watched };
}

/** Durée retenue (secondes) : celle de l'épisode ou du film (minutes TMDB), sinon l'estimation de la source, sinon 0. */
export function externalDuration(runtimeMin: number | null | undefined, sourceSec: number | null | undefined): number {
  if (typeof runtimeMin === 'number' && runtimeMin > 0) return runtimeMin * 60;
  if (typeof sourceSec === 'number' && Number.isFinite(sourceSec) && sourceSec > 0) return sourceSec;
  return 0;
}

function load(): ExternalWatch | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as ExternalWatch;
    return w && w.entry && typeof w.entry.key === 'string' && typeof w.startedAt === 'number' ? w : null;
  } catch { return null; }
}

function save(w: ExternalWatch | null): void {
  try {
    if (w) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(w));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* stockage indisponible : le suivi se perd, sans gêner la lecture */ }
}

/** Démarre le suivi d'une lecture externe (remplace un suivi précédent). */
export function beginExternalWatch(entry: ExternalWatch['entry'], duration: number, offset = 0, now = Date.now()): void {
  save({ entry, duration, startedAt: now, offset, left: false });
}

/** La page vient d'être quittée (le lecteur externe a pris la main) : le suivi compte désormais, à partir de maintenant. */
export function noteExternalLeft(now = Date.now()): void {
  const w = load();
  if (w && !w.left) save({ ...w, left: true, startedAt: now });
}

/** Fermeture de l'écran externe : un suivi pas encore armé (page jamais quittée) est abandonné ; un suivi armé reste à régler. */
export function dropPendingExternalWatch(): void {
  const w = load();
  if (w && !w.left) save(null);
}

/** Abandonne le suivi en cours sans rien enregistrer. */
export function dropExternalWatch(): void {
  save(null);
}

/**
 * Retour dans l'app : enregistre la position estimée et marque vu au-delà du seuil. Renvoie l'estimation enregistrée, ou null
 * (rien en cours, page jamais quittée, absence trop courte). Le suivi est clos dans tous les cas où la page a été quittée.
 */
export function settleExternalWatch(now = Date.now()): (ExternalEstimate & { watch: ExternalWatch }) | null {
  const w = load();
  if (!w || !w.left) return null;
  save(null);
  const est = estimateExternal(w, now);
  if (!est) return null;
  const { entry } = w;
  // Vu : position en fin de durée, pour que « Continuer » propose la suite plutôt qu'une reprise à 80 %.
  userStore.setProgress({ ...entry, position: est.watched ? est.duration : est.position, duration: est.duration });
  if (est.watched) {
    const refs = entry.type === 'tv' && entry.season != null && entry.episode != null ? [{ season: entry.season, episode: entry.episode }] : null;
    Promise.resolve(userStore.setWatched(entry.key, refs, true)).catch(() => undefined);
  }
  return { ...est, watch: w };
}
