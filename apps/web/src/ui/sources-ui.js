/* « Lecture » : branche les boutons de l'interface sur le sélecteur de sources (src/sources) et le lecteur (src/player). */
import { getAutoplay } from '../data/prefs';
import { closePlayer, playBest, playSource } from '../player/session.js';
import { openSourcePicker } from '../sources/picker.js';
import { nextToWatch } from './fiche.js';
import { hv } from './hover.js';
import { state } from './state.js';

/** Cible de lecture d'après le bouton « Lecture » cliqué (fiche, épisode, aperçu au survol). */
export function playFrom(btn) {
  const hc = btn.closest('#hovercard');
  let type; let id; let name; let season = null; let episode = null;
  const ep = btn.closest('.ep');
  if (hc) {
    const it = state.byKey.get(hv.key);
    if (!it) return;
    ({ type, id, name } = it);
    if (type === 'tv') { season = 1; episode = 1; }
  } else {
    const m = state.model;
    if (!m) return;
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
  const request = { type, id: String(id), name, season, episode, key: type + ':' + id };
  // Lecture automatique de la meilleure source (réglage activé par défaut) ; sinon le sélecteur détaillé.
  if (getAutoplay()) playBest(request, btn);
  else openSources(request, btn);
}

/** Tiroir des sources : choisir une source lance le lecteur. */
export function openSources(request, opener) {
  return openSourcePicker(request, opener, {
    onPick: (view, views) => playSource(request, views, view, opener),
  });
}

/** Reprise directe (carte « Reprendre la lecture ») : meilleure source, position enregistrée. */
export function playDirect(request, opener) {
  return playBest(request, opener, { resume: 'auto' });
}

export const closeVideo = closePlayer;
