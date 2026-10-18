/* Rangée d’épisodes de la fiche : image de repli (jamais de carte vide) et épisode à mettre en avant à l’ouverture. */
import { userStore } from '../data/userStore';
import { IMG } from './constants.js';
import { progressResume } from './resume.js';

/**
 * Image d’une carte d’épisode : still (URL complète ou chemin TMDB), sinon le fond de la série (à assombrir, avec le
 * numéro en surimpression), sinon aucune image (dégradé + numéro).
 * @returns {{ src: string, fallback: boolean }}
 */
export function episodeImage(still, backdropPath, size = 'w500') {
  const src = IMG(size, still);
  if (src) return { src, fallback: false };
  return { src: IMG('w780', backdropPath), fallback: true };
}

/**
 * Épisode à mettre en avant dans une saison chargée : en cours (entamé, non vu), sinon premier diffusé non vu, sinon
 * dernier diffusé, sinon le premier. `eps` au format TMDB (episode_number, air_date).
 * @returns {number | null} numéro d’épisode
 */
export function focusEpisode(eps, { today, isSeen, inProgress }) {
  if (!eps.length) return null;
  const aired = eps.filter((e) => !e.air_date || e.air_date <= today);
  const cur = aired.find((e) => !isSeen(e.episode_number) && inProgress(e.episode_number));
  if (cur) return cur.episode_number;
  const next = aired.find((e) => !isSeen(e.episode_number));
  if (next) return next.episode_number;
  const last = aired[aired.length - 1] || eps[0];
  return last.episode_number;
}

/** scrollLeft qui centre la carte dans la rangée, borné à la plage défilable. */
export function centerLeft({ cardLeft, cardWidth, viewWidth, scrollWidth }) {
  const max = Math.max(0, scrollWidth - viewWidth);
  return Math.min(max, Math.max(0, Math.round(cardLeft - (viewWidth - cardWidth) / 2)));
}

/** Fait défiler la rangée jusqu’à la carte, sans animation. */
export function scrollToCard(list, card) {
  const apply = () => {
    if (!list.isConnected || !card.isConnected) return;
    const lr = list.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const left = centerLeft({ cardLeft: cr.left - lr.left + list.scrollLeft, cardWidth: cr.width, viewWidth: list.clientWidth, scrollWidth: list.scrollWidth });
    const prev = list.style.scrollBehavior;
    list.style.scrollBehavior = 'auto';
    list.scrollLeft = left;
    list.style.scrollBehavior = prev;
  };
  apply();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply); // mise en page terminée (polices, images)
}

/** Épisode entamé et non terminé de ce titre (le plus récent), { s, e } ou null. */
export function inProgressRef(key) {
  const p = userStore.continueWatching(50).find((x) => x.key === key && x.season != null && x.episode != null && !x.finished && !x.suggested);
  return p ? { s: p.season, e: p.episode } : null;
}

/** Vrai si l’épisode a une progression à reprendre. */
export const hasResume = (key, s, e) => !!progressResume(userStore.getProgress(key, s, e));
