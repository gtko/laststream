import { userStore } from '../data/userStore';
import { state } from './state.js';

/** Cible de lecture directe d'un titre du catalogue (clé `movie:603`, `tv:95396`) : un film, ou l'épisode en cours / le premier d'une série. */
export function directPlayRequest(key) {
  const it = state.byKey.get(key);
  if (!it) return null;
  let season = null;
  let episode = null;
  if (it.type === 'tv') {
    const cont = userStore.continueWatching().find((e) => e.type === 'tv' && e.id === it.id && e.season != null);
    season = cont ? cont.season : 1;
    episode = cont ? cont.episode : 1;
  }
  return { type: it.type, id: String(it.id), name: it.name, season, episode, key };
}
