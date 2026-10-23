/* Lecture d'un titre dont l'identifiant est propre à un addon Stremio (ODY-252) : fonctions pures utilisées par `session.js`.
 * Une demande de lecture « addon » porte `request.addon` ; la session ne la mêle jamais aux ids TMDB / IMDb (progression, épisodes,
 * sous-titres, présence, salon, analyse d'intro, « vu » du serveur). */

import { addonTitleKey } from '../data/addonUserStore';
import type { AddonVideo } from '../sources/addonSources';

export interface AddonPlayback {
  /** Clé de l'addon (registre) ou du titre : la progression est toujours rangée sous `addonProgressKey`, calculé depuis `type` et `id`. */
  key: string;
  /** Base de l'addon (sans `manifest.json`). */
  base: string;
  /** Type Stremio d'origine (`movie`, `series`, `anime`…). */
  type: string;
  /** Identifiant de la fiche chez l'addon. */
  id: string;
  title: string;
  /** Épisodes de la fiche (route `meta`) : sert à l'épisode suivant. */
  videos?: AddonVideo[];
}

interface MaybeAddonRequest {
  addon?: Partial<AddonPlayback> | null;
}

/** La demande vient d'un addon (clé et base présentes) ; les autres demandes suivent le chemin TMDB / IMDb habituel. */
export function addonOf(req: MaybeAddonRequest | null | undefined): AddonPlayback | null {
  const a = req?.addon;
  if (!a || typeof a.key !== 'string' || !a.key || typeof a.base !== 'string' || !a.base) return null;
  return { key: a.key, base: a.base, type: a.type ?? '', id: a.id ?? '', title: a.title ?? '', ...(Array.isArray(a.videos) ? { videos: a.videos } : {}) };
}

/** Clé de progression du titre dans `addonUserStore` (`addon:<type>:<id>`), la même que celle de la bibliothèque. */
export const addonProgressKey = (a: Pick<AddonPlayback, 'type' | 'id'>): string => addonTitleKey(a.type, a.id);

/** Épisodes numérotés de la fiche, triés par saison puis épisode. */
export function numberedVideos(videos: readonly AddonVideo[] | undefined): Array<AddonVideo & { season: number; episode: number }> {
  const list = (videos ?? []).filter((v): v is AddonVideo & { season: number; episode: number } =>
    typeof v.season === 'number' && v.season > 0 && typeof v.episode === 'number' && v.episode > 0);
  return list.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Épisode de la fiche pour une saison et un numéro. */
export function addonVideoOf(videos: readonly AddonVideo[] | undefined, season: number, episode: number): AddonVideo | undefined {
  return numberedVideos(videos).find((v) => v.season === season && v.episode === episode);
}

/** Épisode qui suit `cur` dans la liste de l'addon ; null sans liste, sans épisode courant ou en fin de série (lancement automatique désactivé). */
export function addonNextEpisode(videos: readonly AddonVideo[] | undefined, cur: { season?: number | null; episode?: number | null }): { season: number; episode: number } | null {
  if (cur.season == null || cur.episode == null) return null;
  const list = numberedVideos(videos);
  const i = list.findIndex((v) => v.season === cur.season && v.episode === cur.episode);
  const next = i >= 0 ? list[i + 1] : undefined;
  return next ? { season: next.season, episode: next.episode } : null;
}

/** Identifiant à passer à la route `stream` de l'addon : celui de l'épisode (`streamId`), sinon celui de la fiche. */
export function addonStreamIdOf(req: MaybeAddonRequest & { streamId?: string | null }): string {
  return (typeof req.streamId === 'string' && req.streamId) || addonOf(req)?.id || '';
}

/**
 * Position de reprise : la progression n'est reprise que pour le même épisode (ou pour un film). Forme attendue par `resumeDecision`.
 */
export function addonResumeSource(
  saved: { t: number; d: number; episode?: { season: number; episode: number } } | null,
  cur: { season?: number | null; episode?: number | null },
): { position: number; duration: number } | null {
  if (!saved) return null;
  if (cur.season != null && (saved.episode?.season !== cur.season || saved.episode?.episode !== cur.episode)) return null;
  return { position: saved.t, duration: saved.d };
}
