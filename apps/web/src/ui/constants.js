/* Port du prototype (voir tools/port-prototype.mjs). */


import { t } from '../i18n';
export const IMG = (size, p) => (p ? (/^https?:\/\//.test(p) ? p : 'https://image.tmdb.org/t/p/' + size + p) : '');
export const YT_ORIGIN = 'https://www.youtube-nocookie.com'; // origine du lecteur YouTube (API IFrame) : cible de postMessage
export const DWELL_MS = 4000; // accueil : aperçu après 4 s sur la mise en avant
export const FICHE_IDLE_MS = 3000; // fiche : bande-annonce après 3 s
export const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
export const STILL = new URLSearchParams(location.search).has('still');
/** Onglets : identifiants en français (voir tabHref), libellés traduits à l'affichage. */
export const TABS = [
  ['Accueil', 'home', true],
  ['Découvrir', 'compass', false],
  ['Bibliothèque', 'list', false],
  ['Stats', 'stats', false],
  ['Profil', '', false],
];
export const EMPTY_DETAIL = {
  name: '', overview: '', tagline: '', logo: '', trailer: '', trailerVO: false, genres: [], minutes: 0, runtime: '',
  cert: '', ratings: {}, vote: '',
};
export const DAY_MS = 864e5;
export const GENRE_FR = {
  28: t('Action'), 12: t('Aventure'), 16: t('Animation'), 35: t('Comédie'), 80: t('Policier'), 99: t('Documentaire'), 18: t('Drame'), 10751: t('Famille'),
  14: t('Fantastique'), 36: t('Histoire'), 27: t('Horreur'), 10402: t('Musique'), 9648: t('Mystère'), 10749: t('Romance'), 878: t('Science-fiction'),
  10770: t('Téléfilm'), 53: t('Thriller'), 10752: t('Guerre'), 37: t('Western'), 10759: t('Action'), 10762: t('Enfants'), 10763: t('Actualités'),
  10764: t('Téléréalité'), 10765: t('Science-fiction'), 10766: t('Feuilleton'), 10767: t('Talk-show'), 10768: t('Guerre'),
};
