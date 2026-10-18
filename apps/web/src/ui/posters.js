/* Affiches manquantes (titres importés, bibliothèque sans image) : retrouvées une fois, avec une file d'attente, puis
 * enregistrées dans le profil. Une tuile n'est jamais laissée vide si TMDB connaît le titre. */
import { tmdb } from '../data/lt';
import { userStore } from '../data/userStore';
import { IMG } from './constants.js';
import { state } from './state.js';

const done = new Map();
const queue = [];
let active = 0;

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active += 1;
    job().finally(() => { active -= 1; pump(); });
  }
}

/** Retrouve l'affiche d'un titre (une seule requête par titre, mise en cache). */
export function resolvePoster(it) {
  if (!done.has(it.key)) {
    done.set(it.key, new Promise((resolve) => {
      queue.push(async () => {
        try {
          const raw = await tmdb(it.type + '/' + it.id);
          resolve({ poster: raw.poster_path || '', backdrop: raw.backdrop_path || '' });
        } catch (_) {
          done.delete(it.key); // réessayé au prochain affichage
          resolve(null);
        }
      });
      pump();
    }));
  }
  return done.get(it.key);
}

function paint(key, poster) {
  document.querySelectorAll('[data-tile="' + key + '"] .card-media').forEach((media) => {
    if (media.querySelector('img')) return;
    const alt = media.closest('.tile-land') ? '' : (state.byKey.get(key) || {}).name || '';
    media.insertAdjacentHTML('afterbegin', '<img src="' + IMG('w342', poster) + '" alt="' + alt.replace(/"/g, '&quot;') + '" loading="lazy" decoding="async">');
    media.classList.remove('no-img');
  });
}

/** À appeler après avoir affiché des tuiles : complète celles qui n'ont pas d'affiche. */
export function fillMissingPosters(items) {
  items.filter((it) => !it.poster && it.id).forEach(async (it) => {
    const r = await resolvePoster(it);
    if (!r || !r.poster) return;
    it.posterPath = r.poster;
    it.poster = IMG('w342', r.poster);
    it.backdropPath = it.backdropPath || r.backdrop;
    paint(it.key, r.poster);
    if (userStore.updateLibraryPoster) userStore.updateLibraryPoster(it.key, r.poster);
  });
}
