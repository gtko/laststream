import { getLangPrefs, LANG_NONE, LANG_VO } from './langPrefs';
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

/** Langue des bandes-annonces : la langue audio principale, et la secondaire quand c'est une langue précise. */
export interface TrailerLang extends VideoLang {
  /** Langue audio secondaire (code à deux lettres) ; absente pour la version originale, « aucune » ou la même langue. */
  secondary?: string;
}

const COUNTRY: Record<string, string> = { fr: 'FR', en: 'US', es: 'ES', de: 'DE', it: 'IT', ja: 'JP', ko: 'KR', pt: 'BR' };

/**
 * Langue des bandes-annonces : langue audio principale et secondaire des réglages « Audio et sous-titres ». Sans réglage
 * utilisable (version originale, « aucune »), c'est l'ancien réglage de langue qui sert ; la secondaire est alors absente.
 */
export function trailerLang(): TrailerLang {
  const base = getVideoLang();
  let lang = base.lang;
  let secondary: string | undefined;
  try {
    const lp = getLangPrefs();
    if (lp.audio && lp.audio !== LANG_VO && lp.audio !== LANG_NONE) lang = lp.audio;
    if (lp.audio2 && lp.audio2 !== LANG_VO && lp.audio2 !== LANG_NONE && lp.audio2 !== lang) secondary = lp.audio2;
  } catch { /* réglage illisible : ancien réglage */ }
  const core: VideoLang = lang === base.lang ? base : { lang, tag: `${lang}-${COUNTRY[lang] ?? lang.toUpperCase()}`, country: COUNTRY[lang] ?? lang.toUpperCase() };
  return secondary ? { ...core, secondary } : core;
}

/**
 * Valeur du paramètre TMDB `include_video_language` : langue principale, secondaire (l'anglais à défaut), vidéos sans
 * langue, anglais. Sans doublon.
 */
export function includeVideoLanguages(pref: TrailerLang): string {
  return [pref.lang, pref.secondary ?? 'en', 'null', 'en'].filter((c, i, all) => all.indexOf(c) === i).join(',');
}

// ---- Marqueurs de titre ----
// TMDB étiquette souvent mal la langue : ce que dit le nom de la vidéo (VF, VOSTFR…) prime sur `iso_639_1`.

/** Doublage ou version parlée dans la langue, d'après le nom (mention explicite). */
const DUB_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fr', /\bvff?\b|version fran[cç]a(?:is|ise)|\bdoubl[é]e?s?\b/i],
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
const EXCLUDED = /behind the scenes|featurette|bloopers?|b[eê]tisier|\br[ée]cap\b|making[- ]of|coulisses|\bextraits?\b/i;
/** Un nom « clip » exclut une bande-annonce ou un teaser (un clip typé « Clip » reste admis, en dernier). */
const CLIP_NAME = /\bclips?\b/i;
const TEASER = /\bteaser\b/i;
const CANDIDATE_TYPES: readonly string[] = ['Trailer', 'Teaser', 'Clip'];
/** Promo ou événement (avant-première, festival, « au cinéma le », « beach »…) : passe après toute vraie bande-annonce. */
const PROMO = /deauville|cannes|venise|avant[- ]premi[eè]re|festival|au cin[ée]ma le|en salles? le|\bbeach\b|\binterviews?\b|\bspots? tv\b|\btv spots?\b|r[ée]actions?\b|\bbonus\b/i;
/** « Bande-annonce officielle » ou « official trailer ». */
const OFFICIAL = /bande[- ]annonce officielle|official trailer|tr[aá]iler oficial|offizieller trailer|trailer ufficiale/i;
/** Nouveauté (« nouvelle », « finale », « bande-annonce 2 ») : à score égal, la date publiée départage. */
const NEWER = /\bnouvel{1,2}e?\b|\bnouveau\b|\bfinale?\b|\bfinal trailer\b|\bnew trailer\b|\bbande[- ]annonce 2\b|\btrailer 2\b/i;
/** Plateforme de streaming accolée au titre (« | Disney+ ») : léger malus. */
const PLATFORM = /disney\+|netflix|prime video|canal\+|apple tv/i;

/** Vrai si le nom annonce des sous-titres dans la langue choisie (VOSTFR, sous-titré, subtitled…). */
function isSubtitled(v: TmdbVideo, pref: TrailerLang): boolean {
  const name = v.name ?? '';
  return (SUB_MARKERS[pref.lang]?.test(name) ?? false) || GENERIC_SUB.test(name);
}

/** « Bande-annonce » sans autre mention : titre français, donc doublage français. */
const FR_BANNER = /bande[- ]annonce/i;

/** Langue parlée : un marqueur de doublage dans le nom prime sur l'étiquette TMDB. */
export function audioLangOf(v: TmdbVideo): string | null {
  const name = v.name ?? '';
  const dub = DUB_MARKERS.find(([, re]) => re.test(name));
  if (dub) return dub[0];
  if (FR_BANNER.test(name)) return 'fr';
  return v.iso_639_1 || null;
}

/**
 * Groupe de langue (plus petit = mieux) : 0 doublé dans la langue principale, 1 sous-titré dans cette langue,
 * 2 langue secondaire, 3 sans langue, 4 anglais, 5 autre langue.
 */
export function langGroup(v: TmdbVideo, pref: TrailerLang): number {
  if (isSubtitled(v, pref)) return 1;
  const audio = audioLangOf(v);
  if (audio === pref.lang) return 0;
  if (pref.secondary && audio === pref.secondary) return 2;
  if (!audio) return 3;
  return audio === 'en' ? 4 : 5;
}

/** Nature : 0 bande-annonce, 1 teaser (un nom « Teaser » reste un teaser), 2 clip. */
function kindRank(v: TmdbVideo): number {
  if (v.type === 'Teaser' || (v.type === 'Trailer' && TEASER.test(v.name ?? ''))) return 1;
  return v.type === 'Trailer' ? 0 : 2;
}

/**
 * Rang d'une vidéo (plus petit = meilleur). Les promos (avant-premières, événements) passent après toute bande-annonce ou
 * teaser, et les clips après tout le reste ; pour le reste, la langue prime (une VF teaser bat une bande-annonce
 * anglaise), puis la nature (bande-annonce avant teaser).
 */
export function videoTier(v: TmdbVideo, pref: TrailerLang): number {
  return (v.type === 'Clip' ? 100 : 0) + (PROMO.test(v.name ?? '') ? 50 : 0) + langGroup(v, pref) * 3 + kindRank(v);
}

/**
 * Score du titre (plus haut = meilleur) : mention explicite de la langue principale (+4), « bande-annonce officielle »
 * (+3), nouveauté (+2), moins une plateforme de streaming dans le nom (-1).
 */
export function titleScore(v: TmdbVideo, pref: TrailerLang): number {
  const name = v.name ?? '';
  const explicit = DUB_MARKERS.find(([lang]) => lang === pref.lang)?.[1].test(name) ? 4 : 0;
  return explicit + (OFFICIAL.test(name) ? 3 : 0) + (NEWER.test(name) ? 2 : 0) - (PLATFORM.test(name) ? 1 : 0);
}

/**
 * Même rang : meilleur score du titre, puis variante régionale correspondante (doublage seulement), puis « official »,
 * puis la plus récente, puis la taille 1080.
 */
export function compareVideos(a: TmdbVideo, b: TmdbVideo, pref: TrailerLang): number {
  const t = videoTier(a, pref) - videoTier(b, pref);
  if (t) return t;
  const region = (v: TmdbVideo) => (langGroup(v, pref) === 0 && v.iso_3166_1 === pref.country ? 0 : 1);
  return titleScore(b, pref) - titleScore(a, pref)
    || region(a) - region(b)
    || Number(!!b.official) - Number(!!a.official)
    || (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0)
    || Number(b.size === 1080) - Number(a.size === 1080);
}

const playable = (v: TmdbVideo): boolean => v.site === 'YouTube' && !!v.key;

/** Vidéo pouvant être le choix principal : YouTube, bande-annonce, teaser ou clip, hors making-of, featurettes et extraits. */
export function isTrailerCandidate(v: TmdbVideo): boolean {
  const name = v.name ?? '';
  return playable(v) && CANDIDATE_TYPES.includes(v.type ?? '') && !EXCLUDED.test(name) && (v.type === 'Clip' || !CLIP_NAME.test(name));
}

/**
 * Meilleure bande-annonce : clé YouTube, et vrai si elle n'est pas doublée dans la langue principale (version originale
 * ou sous-titres). Clé vide s'il n'y a aucune vidéo utilisable.
 */
export function pickTrailer(videos: TmdbVideo[] | null | undefined, pref: TrailerLang): { key: string; vo: boolean } {
  const pool = (videos ?? []).filter(isTrailerCandidate).sort((a, b) => compareVideos(a, b, pref));
  const best = pool[0];
  return best ? { key: best.key ?? '', vo: langGroup(best, pref) !== 0 } : { key: '', vo: false };
}

/** Clé YouTube de la meilleure bande-annonce (ou teaser, à défaut), vide s'il n'y en a pas. */
export function pickTrailerKey(videos: TmdbVideo[] | null | undefined, pref: TrailerLang): string {
  return pickTrailer(videos, pref).key;
}

/** Vrai si la vidéo n'est pas doublée dans la langue principale (version originale ou sous-titres). */
export function isVoVideo(v: TmdbVideo, pref: TrailerLang): boolean {
  return langGroup(v, pref) !== 0;
}

/** Vrai si la liste contient une bande-annonce ou un teaser doublé dans la langue choisie (pas seulement sous-titré). */
export function hasTrailerInLang(videos: TmdbVideo[] | null | undefined, pref: TrailerLang): boolean {
  return (videos ?? []).some((v) => isTrailerCandidate(v) && langGroup(v, pref) === 0);
}

/**
 * Paramètres du lecteur YouTube pour les sous-titres : seulement quand la vidéo choisie n'est pas doublée dans la langue
 * principale. Sinon, rien à ajouter (aucun sous-titre imposé).
 */
export function captionParams(vo: boolean, pref: VideoLang = trailerLang()): string {
  return vo ? `hl=${pref.lang}&cc_lang_pref=${pref.lang}&cc_load_policy=1` : '';
}

/** Classement des vidéos pour la rangée « Bonus » : type d'abord, puis langue, région, official, date. */
export function sortVideos<T extends TmdbVideo>(videos: T[], typeOrder: (v: T) => number, pref: TrailerLang): T[] {
  return videos.slice().sort((a, b) => typeOrder(a) - typeOrder(b) || compareVideos(a, b, pref));
}

/** Variantes régionales essayées pour un film sans bande-annonce dans la langue choisie (fr-FR d'abord). */
const REGIONAL_TAGS: Partial<Record<string, readonly string[]>> = { fr: ['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'] };

/** Étiquettes TMDB `language` interrogées explicitement pour un film sans bande-annonce dans la langue choisie. */
export function trailerFallbackTags(pref: TrailerLang): string[] {
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
  pref: TrailerLang,
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
