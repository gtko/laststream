/* « Lecture » : branche les boutons de l'interface sur le sélecteur de sources (src/sources) et le lecteur (src/player). */
import { getAutoplay } from '../data/prefs';
import { canonAiredOn } from '../data/series';
import { closePlayer, playBest } from '../player/session.js';
import { prefetchSources } from '../sources/load';
import { nextToWatch } from './fiche.js';
import { hv } from './hover.js';
import { state } from './state.js';

/** Cible de lecture d'après le bouton « Lecture » (fiche, épisode, aperçu au survol) ; null si le titre est inconnu. */
function requestFrom(btn) {
  const hc = btn.closest('#hovercard');
  let type; let id; let name; let season = null; let episode = null;
  const ep = btn.closest('.ep');
  if (hc) {
    const it = state.byKey.get(hv.key);
    if (!it) return null;
    ({ type, id, name } = it);
    if (type === 'tv') { season = 1; episode = 1; }
  } else {
    const m = state.model;
    if (!m) return null;
    ({ type, name } = m);
    id = m.id;
    if (type === 'tv') {
      if (ep) {
        [season, episode] = ep.dataset.ep.split(':').map(Number);
      } else {
        const n = nextToWatch(m);
        season = n ? n.s : 1;
        episode = n ? n.e : 1;
      }
    }
  }
  return { type, id: String(id), name, season, episode, key: type + ':' + id };
}

export function playFrom(btn) {
  if (btn.dataset.playKey) { playAiringEpisode(btn); return; }
  const request = requestFrom(btn);
  if (!request) return;
  // Le lecteur s'ouvre tout de suite ; la meilleure source est choisie dedans (ou le sélecteur, réglage désactivé).
  // Épisode diffusé dans les 14 prochains jours (data-air) : lisible, et « Pas encore disponible » si aucune source.
  const air = btn.closest('.ep')?.dataset.air;
  playBest(request, btn, air ? { notYetAired: air } : {});
}

/**
 * Carte ou ligne d'un épisode bientôt diffusé (calendrier, suivis, fiche) : data-play-key = clé du titre,
 * data-play-season / data-play-episode, data-name, data-air (date de diffusion). Lance la recherche de sources de cet épisode.
 */
async function playAiringEpisode(btn) {
  const key = btn.dataset.playKey;
  const [type, id] = key.split(':');
  const it = state.byKey.get(key);
  const air = btn.dataset.air || '';
  // Numérotation de la structure canonique (TVDB ou groupe TMDB, comme la liste des épisodes) : l'épisode diffusé ce
  // jour-là fixe la saison, l'épisode et l'identifiant de flux. Sans correspondance, les numéros du bouton sont gardés.
  const canon = type === 'tv' && air ? await canonAiredOn(id, air).catch(() => null) : null;
  const request = {
    type, id: String(id), name: btn.dataset.name || (it && it.name) || '', key,
    season: canon ? canon.season : Number(btn.dataset.playSeason),
    episode: canon ? canon.episode : Number(btn.dataset.playEpisode),
    streamId: canon && canon.streamId ? canon.streamId : null,
  };
  playBest(request, btn, air ? { notYetAired: air } : {});
}

/** Sélecteur de sources, ouvert dans le lecteur : choisir une source lance la lecture. */
export function openSources(request, opener) {
  return playBest(request, opener, { picker: true });
}

/** Reprise directe (carte « Reprendre la lecture ») : meilleure source, position enregistrée. `extra` : options de playBest. */
export function playDirect(request, opener, extra = {}) {
  return playBest(request, opener, { resume: 'auto', ...extra });
}

export const closeVideo = closePlayer;

// Préchargement : un survol ou un focus de plus de 300 ms sur « Lecture » lance la recherche de sources en arrière-plan,
// pour que le lecteur s'ouvre souvent avec la source déjà choisie.
let hoverTimer = null;
const playBtn = (t) => (t instanceof Element ? t.closest('[data-play]') : null);
function armPrefetch(e) {
  const b = playBtn(e.target);
  if (!b) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const r = requestFrom(b);
    if (r && getAutoplay()) prefetchSources(r);
  }, 300);
}
const disarmPrefetch = () => clearTimeout(hoverTimer);
document.addEventListener('pointerover', armPrefetch);
document.addEventListener('focusin', armPrefetch);
document.addEventListener('pointerout', (e) => { if (playBtn(e.target)) disarmPrefetch(); });
document.addEventListener('focusout', (e) => { if (playBtn(e.target)) disarmPrefetch(); });
