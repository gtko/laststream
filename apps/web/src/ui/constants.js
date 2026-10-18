/* Port du prototype (voir tools/port-prototype.mjs). */


export const IMG = (size, p) => (p ? (/^https?:\/\//.test(p) ? p : 'https://image.tmdb.org/t/p/' + size + p) : '');
export const DWELL_MS = 4000; // accueil : aperçu après 4 s sur la mise en avant
export const FICHE_IDLE_MS = 3000; // fiche : bande-annonce après 3 s
export const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
export const STILL = new URLSearchParams(location.search).has('still');
export const TABS = [
  ['Accueil', 'home', true],
  ['Découvrir', 'compass', false],
  ['Bibliothèque', 'list', false],
  ['Stats', 'stats', false],
  ['Profil', '', false],
];
export const EMPTY_DETAIL = {
  name: '', overview: '', tagline: '', logo: '', trailer: '', genres: [], minutes: 0, runtime: '',
  cert: '', ratings: {}, vote: '',
};
export const DAY_MS = 864e5;
export const GENRE_FR = {
  28: 'Action', 12: 'Aventure', 16: 'Animation', 35: 'Comédie', 80: 'Policier', 99: 'Documentaire', 18: 'Drame', 10751: 'Famille',
  14: 'Fantastique', 36: 'Histoire', 27: 'Horreur', 10402: 'Musique', 9648: 'Mystère', 10749: 'Romance', 878: 'Science-fiction',
  10770: 'Téléfilm', 53: 'Thriller', 10752: 'Guerre', 37: 'Western', 10759: 'Action', 10762: 'Enfants', 10763: 'Actualités',
  10764: 'Téléréalité', 10765: 'Science-fiction', 10766: 'Feuilleton', 10767: 'Talk-show', 10768: 'Guerre',
};
