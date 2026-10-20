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
function resolvePoster(it) {
  if (!done.has(it.key)) {
    done.set(it.key, new Promise((resolve) => {
      queue.push(async () => {
        try {
          // 1. détail ; 2. images TMDB (affiches dans toutes les langues, puis fonds) ; 3. série : affiche d'une saison.
          const raw = await tmdb(it.type + '/' + it.id);
          let poster = raw.poster_path || '';
          let backdrop = raw.backdrop_path || '';
          if (!poster) {
            const im = await tmdb(it.type + '/' + it.id + '/images', { include_image_language: 'fr,en,null' }).catch(() => null);
            poster = (im && im.posters && im.posters[0] && im.posters[0].file_path) || '';
            backdrop = backdrop || (im && im.backdrops && im.backdrops[0] && im.backdrops[0].file_path) || '';
          }
          if (!poster && it.type === 'tv') {
            const seasons = (raw.seasons || []).filter((s) => s.poster_path);
            poster = (seasons[0] && seasons[0].poster_path) || '';
          }
          resolve({ poster, backdrop });
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

function paint(key, path, isBackdrop) {
  document.querySelectorAll('[data-tile="' + key + '"] .card-media').forEach((media) => {
    if (media.querySelector('img')) return;
    const alt = media.closest('.tile-land') ? '' : (state.byKey.get(key) || {}).name || '';
    media.insertAdjacentHTML('afterbegin', '<img src="' + IMG(isBackdrop ? 'w780' : 'w342', path) + '" alt="' + alt.replace(/"/g, '&quot;') + '" loading="lazy" decoding="async">');
    media.classList.remove('no-img');
  });
}

/** À appeler après avoir affiché des tuiles : complète celles qui n'ont pas d'affiche. */
export function fillMissingPosters(items) {
  items.filter((it) => !it.poster && it.id).forEach(async (it) => {
    const r = await resolvePoster(it);
    if (r && !r.poster && !r.backdrop) it.noImage = true;
    if (!r || (!r.poster && !r.backdrop)) return;
    it.posterPath = r.poster || it.posterPath;
    it.poster = r.poster ? IMG('w342', r.poster) : it.poster;
    it.backdropPath = it.backdropPath || r.backdrop;
    paint(it.key, r.poster || r.backdrop, !r.poster);
    if (r.poster && userStore.updateLibraryPoster) userStore.updateLibraryPoster(it.key, r.poster);
  });
}
