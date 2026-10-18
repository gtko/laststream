import type { VideoLang } from './prefs';

/** Vidéo TMDB (champs utiles). */
export interface TmdbVideo {
  key?: string;
  site?: string;
  type?: string;
  name?: string;
  official?: boolean;
  published_at?: string;
  size?: number;
  iso_639_1?: string | null;
  iso_3166_1?: string | null;
}

/**
 * Rang d'une vidéo (plus petit = meilleur) :
 * 0 bande-annonce dans la langue choisie, 1 teaser dans cette langue, 2 autre vidéo dans cette langue,
 * 3 bande-annonce en anglais, 4 teaser en anglais, 5 le reste. Voir `compareVideos` pour les égalités.
 */
export function videoTier(v: TmdbVideo, pref: VideoLang): number {
  const same = v.iso_639_1 === pref.lang;
  const en = v.iso_639_1 === 'en';
  if (same) return v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : 2;
  if (en) return v.type === 'Trailer' ? 3 : v.type === 'Teaser' ? 4 : 5;
  return 5;
}

/** Même rang : variante régionale correspondante, puis « official », puis la plus récente, puis la taille 1080. */
export function compareVideos(a: TmdbVideo, b: TmdbVideo, pref: VideoLang): number {
  const t = videoTier(a, pref) - videoTier(b, pref);
  if (t) return t;
  const region = (v: TmdbVideo) => (v.iso_639_1 === pref.lang && v.iso_3166_1 === pref.country ? 0 : 1);
  return region(a) - region(b)
    || Number(!!b.official) - Number(!!a.official)
    || (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0)
    || Number(b.size === 1080) - Number(a.size === 1080);
}

const playable = (v: TmdbVideo): boolean => v.site === 'YouTube' && !!v.key;

/** Clé YouTube de la meilleure bande-annonce (ou teaser, à défaut), vide s'il n'y en a pas. */
export function pickTrailerKey(videos: TmdbVideo[] | null | undefined, pref: VideoLang): string {
  const pool = (videos ?? []).filter((v) => playable(v) && (v.type === 'Trailer' || v.type === 'Teaser'));
  pool.sort((a, b) => compareVideos(a, b, pref));
  return pool[0]?.key ?? '';
}

/** Classement des vidéos pour la rangée « Bonus » : type d'abord, puis langue, région, official, date. */
export function sortVideos<T extends TmdbVideo>(videos: T[], typeOrder: (v: T) => number, pref: VideoLang): T[] {
  return videos.slice().sort((a, b) => typeOrder(a) - typeOrder(b) || compareVideos(a, b, pref));
}
