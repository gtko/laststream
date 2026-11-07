/* Supprimer après visionnage (ODY-234) : quand un titre (film, ou épisode) passe en « vu », son téléchargement terminé est retiré
 * si le réglage est actif et hors profil enfant. Un téléchargement en cours ou en attente n'est jamais touché. Ne lève jamais. */
import { isKidProfile } from '../data/auth';
import { getDownloads } from './service';
import { getDeleteAfterWatch } from './settings';
import { downloadId } from './types';

/** Titre marqué vu : `key` est la clé de titre (`movie:550`, `tv:1399`), `season` et `episode` seulement pour un épisode. */
export async function onWatched(key: string, season?: number, episode?: number): Promise<void> {
  try {
    if (!getDeleteAfterWatch() || isKidProfile()) return;
    const m = await getDownloads();
    const id = downloadId(key, season, episode);
    if (!m || m.get(id)?.state !== 'done') return;
    await m.remove(id);
  } catch {
    /* erreur avalée : le téléchargement reste, le visionnage n'est pas gêné */
  }
}

/** Quand supprimer : en streaming, tout de suite ; en lecture d'un fichier téléchargé, à la fermeture du lecteur (`later`). */
export function watchedPlan(offline: boolean, key: string, season?: number, episode?: number): { later: { key: string; season?: number; episode?: number } | null } {
  return { later: offline ? { key, season, episode } : null };
}
