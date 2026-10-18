/* Reprise de lecture : timecode et pourcentage vus, affichés sur les vignettes (épisodes, films, « Reprendre la lecture »). */
import { SEEN_PROGRESS_RATIO } from '../data/seen';
import { esc } from './util.js';

const MIN_PCT = 2; // en deçà, rien n’est entamé
const SEEN_PCT = Math.round(SEEN_PROGRESS_RATIO * 100); // à partir de là le titre est « vu »

const pad = (n) => String(n).padStart(2, '0');

/** Timecode : h:mm:ss à partir d’une heure, sinon mm:ss (secondes tronquées). */
export function fmtTimecode(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60);
}

/**
 * Position et durée en secondes → { label: '23:41 · 47 %', ratio } (ratio de 0 à 1), ou null.
 * Null si la durée est inconnue, si moins de 2 % est entamé ou si le titre est vu (90 % et plus).
 * Les bornes portent sur le pourcentage affiché, pour qu’un 90 % affiché ne soit jamais un titre non vu.
 */
export function formatResume(timeSec, durationSec) {
  if (!Number.isFinite(timeSec) || !Number.isFinite(durationSec) || durationSec <= 0 || timeSec < 0) return null;
  const ratio = Math.min(1, timeSec / durationSec);
  const pct = Math.round(ratio * 100);
  if (pct < MIN_PCT || pct >= SEEN_PCT) return null;
  return { label: fmtTimecode(timeSec) + ' · ' + pct + ' %', ratio };
}

/** Même règle appliquée à une entrée de progression du UserStore (`null` si absente). */
export function progressResume(progress) {
  return progress ? formatResume(progress.position, progress.duration) : null;
}

/** Pastille de timecode, en bas à gauche d’une vignette (le parent doit être positionné). */
export const resumePillHTML = (label) => '<span class="resume-pill" aria-hidden="true">' + esc(label) + '</span>';
