/* Écriture des éléments importés sur le profil actif. Avec un compte, chaque écriture attend la réponse du serveur (le moteur
 * ne passe à l'élément suivant qu'une fois l'écriture confirmée, ce qui rend l'import reprenable) ; toutes les routes utilisées
 * sont idempotentes (PUT par titre), une reprise ne crée donc pas de doublon. Sans compte, le stockage local de l'appareil. */

import { isServerMode, auth } from '../auth';
import { putLibrary, putProgress, putWatched, UserApiError, type MediaKind } from '../userApi';
import { userStore } from '../userStore';
import { addListItem, createList, getList, getLists, type ListDetail } from '../socialV3Api';
import { posterUrlOf } from '../serverUserStore';
import type { EpisodeRef, MigrationList } from './types';

/** Titre résolu sur TMDB, prêt à écrire. */
export interface ResolvedTitle {
  type: 'movie' | 'tv';
  id: number;
  title: string;
  poster: string;
  year?: string;
  imdb?: string;
}

export interface MigrationSink {
  /** Faux si le profil n'a pas de listes (sans compte, ou serveur sans l'API des listes) : les listes vont dans la bibliothèque. */
  readonly hasLists: boolean;
  library(t: ResolvedTitle, addedAt: number): Promise<void>;
  /** Liste `name` du profil (créée au besoin, réutilisée si elle existe déjà) ; renvoie son identifiant. */
  ensureList(list: MigrationList, name: string, known?: string): Promise<string>;
  /** Ajoute à la liste ; vrai si le titre y était déjà. */
  listItem(listId: string, t: ResolvedTitle): Promise<boolean>;
  watched(t: ResolvedTitle, episodes: EpisodeRef[] | null): Promise<void>;
  progress(t: ResolvedTitle, ep: Partial<EpisodeRef>, positionSec: number, durationSec: number): Promise<void>;
}

const kind = (t: 'movie' | 'tv'): MediaKind => (t === 'tv' ? 'series' : 'movie');

/** Titre déjà dans la liste. */
const listHas = (detail: ListDetail | null, t: ResolvedTitle): boolean =>
  !!detail && Array.isArray(detail.items) && detail.items.some((i) => i.tmdbId === t.id && i.type === kind(t.type));

function serverSink(profileId: string, listsApi: boolean): MigrationSink {
  const listCache = new Map<string, ListDetail | null>();
  return {
    hasLists: listsApi,
    async library(t) {
      await putLibrary(profileId, kind(t.type), t.id, { title: t.title || String(t.id), poster: posterUrlOf(t.poster), ...(t.imdb ? { imdbId: t.imdb } : {}) });
    },
    async ensureList(_list, name, known) {
      if (known) return known;
      const { lists } = await getLists();
      const found = lists.find((l) => l.name === name);
      if (found) return found.id;
      return (await createList({ name, members: [] })).id;
    },
    async listItem(listId, t) {
      if (!listCache.has(listId)) listCache.set(listId, await getList(listId).catch(() => null));
      if (listHas(listCache.get(listId) ?? null, t)) return true;
      try {
        await addListItem(listId, { type: kind(t.type), tmdbId: t.id, title: t.title || String(t.id), ...(t.poster ? { poster: t.poster } : {}) });
        return false;
      } catch (err) {
        if (err instanceof UserApiError && err.status === 409) return true; // déjà dans la liste
        throw err;
      }
    },
    async watched(t, episodes) {
      await putWatched(profileId, { type: kind(t.type), tmdbId: t.id, ...(t.imdb ? { imdbId: t.imdb } : {}), ...(episodes ? { episodes } : {}), watched: true });
    },
    async progress(t, ep, positionSec, durationSec) {
      await putProgress(profileId, { type: kind(t.type), tmdbId: t.id, ...(ep.season !== undefined ? { season: ep.season, episode: ep.episode } : {}), positionSec: Math.floor(positionSec), durationSec: Math.floor(durationSec) });
    },
  };
}

function localSink(): MigrationSink {
  return {
    hasLists: false,
    async library(t, addedAt) {
      if (!userStore.inLibrary(t.type + ':' + t.id)) userStore.addToLibrary({ id: t.id, type: t.type, title: t.title, poster: t.poster, year: t.year, addedAt: addedAt || Date.now() });
    },
    async ensureList() { return ''; },
    async listItem() { return false; },
    async watched(t, episodes) {
      await userStore.setWatched(t.type + ':' + t.id, episodes, true);
    },
    async progress(t, ep, positionSec, durationSec) {
      userStore.setProgress({ key: t.type + ':' + t.id, type: t.type, id: t.id, title: t.title, poster: t.poster, ...ep, position: positionSec, duration: durationSec });
    },
  };
}

/** Sonde l'API des listes (absente des anciens serveurs, réservée aux profils adultes). */
async function listsAvailable(): Promise<boolean> {
  if (auth.profile?.isKid) return false;
  try {
    await getLists();
    return true;
  } catch {
    return false;
  }
}

/** Écrivain du profil actif. */
export async function activeSink(): Promise<MigrationSink> {
  if (isServerMode() && auth.profile) return serverSink(auth.profile.id, await listsAvailable());
  return localSink();
}
