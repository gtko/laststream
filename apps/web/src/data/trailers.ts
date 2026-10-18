import { getLangPrefs } from './langPrefs';
import { getVideoLang, type VideoLang } from './prefs';

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

/** Langue des bandes-annonces : le réglage de l'utilisateur. Point d'entrée unique, à rebrancher plus tard sur la langue audio. */
export function trailerLang(): VideoLang {
  // Langue audio principale des réglages « Audio et sous-titres » ; l'ancien réglage sert de repli (pays, langues non gérées).
  const base = getVideoLang();
  let lang = base.lang;
  try { lang = getLangPrefs().audio || base.lang; } catch { /* réglage illisible : ancien réglage */ }
  if (lang === base.lang) return base;
  const country = ({ fr: base.country === 'CA' ? 'CA' : 'FR', en: 'US', es: 'ES', de: 'DE', it: 'IT', ja: 'JP', ko: 'KR', pt: 'BR' } as Record<string, string>)[lang] ?? lang.toUpperCase();
  return { lang, tag: `${lang}-${country}`, country };
}

/** Valeur du paramètre TMDB `include_video_language` : la langue choisie, l'anglais, puis les vidéos sans langue. */
export const includeVideoLanguages = (pref: VideoLang): string => `${pref.lang},en,null`;

// ---- Marqueurs de titre ----
// TMDB étiquette souvent mal la langue : ce que dit le nom de la vidéo (VF, VOSTFR…) prime sur `iso_639_1`.

/** Doublage ou version parlée dans la langue, d'après le nom. */
const DUB_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fr', /\bvff?\b|version fran[cç]a(?:is|ise)|\bdoubl[é]e?s?\b|bande[- ]annonce/i],
  ['en', /\benglish\b/i],
  ['es', /\bdoblad[oa]s?\b|\bespa[ñn]ol(?:a)?\b|\blatino\b|\bcastellano\b/i],
  ['de', /\bdeutsch(?:e|er)?\b|\bsynchronisiert(?:e)?\b|\bsynchro\b/i],
  ['it', /\bitaliano\b|\bdoppiat[oa]\b/i],
];
/** Sous-titres dans la langue (original sous-titré), par langue choisie. */
const SUB_MARKERS: Partial<Record<string, RegExp>> = {
  fr: /\bvost(?:fr)?\b|sous[- ]titr/i,
  es: /\bvose\b|subtitulad|subt[ií]tulo/i,
  de: /\bomu\b|untertitel/i,
  it: /sottotitol|\bsub ita\b/i,
};
/** Sous-titres annoncés en anglais : valent pour toutes les langues choisies. */
const GENERIC_SUB = /\bsubtitles?\b|\bsubtitled\b/i;
/** Hors choix principal : making-of, featurettes, extraits, bêtisiers, récapitulatifs. */
const EXCLUDED = /behind the scenes|featurette|\bclips?\b|bloopers?|b[eê]tisier|\br[ée]cap\b|making[- ]of|coulisses|\bextraits?\b/i;
const TEASER = /\bteaser\b/i;

/** Vrai si le nom annonce des sous-titres dans la langue choisie (VOSTFR, sous-titré, subtitled…). */
function isSubtitled(v: TmdbVideo, pref: VideoLang): boolean {
  const name = v.name ?? '';
  return (SUB_MARKERS[pref.lang]?.test(name) ?? false) || GENERIC_SUB.test(name);
}

/** Langue parlée : un marqueur de doublage dans le nom prime sur l'étiquette TMDB. */
export function audioLangOf(v: TmdbVideo): string | null {
  const name = v.name ?? '';
  const dub = DUB_MARKERS.find(([, re]) => re.test(name));
  return dub ? dub[0] : v.iso_639_1 || null;
}

/** Groupe de langue : 0 doublé dans la langue choisie, 1 sous-titré dans cette langue, 2 anglais, 3 le reste. */
function langGroup(v: TmdbVideo, pref: VideoLang): number {
  if (isSubtitled(v, pref)) return 1;
  const audio = audioLangOf(v);
  if (audio === pref.lang) return 0;
  return audio === 'en' ? 2 : 3;
}

/** Nature : 0 bande-annonce, 1 teaser (un nom « Teaser » reste un teaser), 2 autre. */
function kindRank(v: TmdbVideo): number {
  if (v.type === 'Teaser' || (v.type === 'Trailer' && TEASER.test(v.name ?? ''))) return 1;
  return v.type === 'Trailer' ? 0 : 2;
}

/**
 * Rang d'une vidéo (plus petit = meilleur) : d'abord le groupe de langue (doublé dans la langue choisie, sous-titré
 * dans cette langue, anglais, reste), puis la nature (bande-annonce, teaser, autre). Voir `compareVideos` pour les égalités.
 */
export function videoTier(v: TmdbVideo, pref: VideoLang): number {
  return langGroup(v, pref) * 3 + kindRank(v);
}

/**
 * Même rang : variante régionale correspondante (doublage seulement), puis « official », puis la plus récente,
 * puis la taille 1080.
 */
export function compareVideos(a: TmdbVideo, b: TmdbVideo, pref: VideoLang): number {
  const t = videoTier(a, pref) - videoTier(b, pref);
  if (t) return t;
  const region = (v: TmdbVideo) => (langGroup(v, pref) === 0 && v.iso_3166_1 === pref.country ? 0 : 1);
  return region(a) - region(b)
    || Number(!!b.official) - Number(!!a.official)
    || (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0)
    || Number(b.size === 1080) - Number(a.size === 1080);
}

const playable = (v: TmdbVideo): boolean => v.site === 'YouTube' && !!v.key;

/** Vidéo pouvant être le choix principal : YouTube, bande-annonce ou teaser, hors making-of, featurettes et extraits. */
export function isTrailerCandidate(v: TmdbVideo): boolean {
  return playable(v) && (v.type === 'Trailer' || v.type === 'Teaser') && !EXCLUDED.test(v.name ?? '');
}

/** Clé YouTube de la meilleure bande-annonce (ou teaser, à défaut), vide s'il n'y en a pas. */
export function pickTrailerKey(videos: TmdbVideo[] | null | undefined, pref: VideoLang): string {
  const pool = (videos ?? []).filter(isTrailerCandidate);
  pool.sort((a, b) => compareVideos(a, b, pref));
  return pool[0]?.key ?? '';
}

/** Vrai si la liste contient une bande-annonce ou un teaser doublé dans la langue choisie (pas seulement sous-titré). */
export function hasTrailerInLang(videos: TmdbVideo[] | null | undefined, pref: VideoLang): boolean {
  return (videos ?? []).some((v) => isTrailerCandidate(v) && langGroup(v, pref) === 0);
}

/** Classement des vidéos pour la rangée « Bonus » : type d'abord, puis langue, région, official, date. */
export function sortVideos<T extends TmdbVideo>(videos: T[], typeOrder: (v: T) => number, pref: VideoLang): T[] {
  return videos.slice().sort((a, b) => typeOrder(a) - typeOrder(b) || compareVideos(a, b, pref));
}

/** Variantes régionales essayées pour un film sans bande-annonce dans la langue choisie (fr-FR d'abord). */
const REGIONAL_TAGS: Partial<Record<string, readonly string[]>> = { fr: ['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'] };

/** Étiquettes TMDB `language` interrogées explicitement pour un film sans bande-annonce dans la langue choisie. */
export function trailerFallbackTags(pref: VideoLang): string[] {
  return [...(REGIONAL_TAGS[pref.lang] ?? [])];
}

/** Fusionne deux listes de vidéos sans doublon (site + clé). */
export function mergeVideos(a: TmdbVideo[], b: TmdbVideo[]): TmdbVideo[] {
  const seen = new Set(a.map((v) => `${v.site}:${v.key}`));
  const extra = b.filter((v) => {
    const id = `${v.site}:${v.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return a.concat(extra);
}

/** Réponse d'une requête de vidéos TMDB (`results`), ou rien si la requête a échoué. */
export type VideosFetcher = (path: string, params: Record<string, string>) => Promise<{ results?: TmdbVideo[] } | null | undefined>;

/**
 * Complète les vidéos d'un titre quand la langue choisie n'a pas de bande-annonce doublée : pour une série, la saison 1 ;
 * pour un film, les étiquettes régionales françaises. Dernier recours : les vidéos en anglais. Les erreurs sont ignorées.
 */
export async function completeVideos(
  list: TmdbVideo[],
  type: 'movie' | 'tv',
  id: string | number,
  pref: VideoLang,
  fetchVideos: VideosFetcher,
): Promise<TmdbVideo[]> {
  const include = includeVideoLanguages(pref);
  const steps: Array<readonly [string, string]> = type === 'tv'
    ? [[`tv/${id}/season/1/videos`, pref.tag]]
    : trailerFallbackTags(pref).map((tag) => [`movie/${id}/videos`, tag] as const);
  let all = list;
  for (const [path, language] of steps) {
    if (hasTrailerInLang(all, pref)) break;
    try {
      all = mergeVideos(all, (await fetchVideos(path, { language, include_video_language: include }))?.results ?? []);
    } catch {
      // Repli suivant.
    }
  }
  if (all.some(isTrailerCandidate)) return all;
  try {
    return mergeVideos(all, (await fetchVideos(`${type}/${id}/videos`, { language: 'en-US' }))?.results ?? []);
  } catch {
    return all;
  }
}
