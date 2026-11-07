/** Ordre de sortie stable des langues. */
const LANG_ORDER = ['fr', 'multi', 'en', 'es', 'de', 'it', 'original'];
/** Drapeaux emoji (paires d'indicateurs régionaux) et langue correspondante. */
const FLAG_LANGS = [
    ['\u{1F1EB}\u{1F1F7}', 'fr'], // FR
    ['\u{1F1EC}\u{1F1E7}', 'en'], // GB
    ['\u{1F1EA}\u{1F1F8}', 'es'], // ES
    ['\u{1F1E9}\u{1F1EA}', 'de'], // DE
    ['\u{1F1EE}\u{1F1F9}', 'it'], // IT
];
// Sous-titres français : détectés puis retirés avant la détection audio,
// pour que "VOST FR" ou "SUB FRENCH" ne créent pas un faux audio français.
// Ces regex sont en flag g (utilisées avec search/replace uniquement).
const VOSTFR_RE = /\b(?:vostfr|vo stfr|vost fr)\b/g;
const SUBFRENCH_RE = /\b(?:subfrench|sub french|stfr)\b/g;
// Variantes audio françaises.
const VFF_RE = /\b(?:vff|vf france)\b/;
const VFQ_RE = /\b(?:vfq|vfqc|vf quebec|vf qc)\b/;
const VF2_RE = /\bvf2\b/;
const TRUEFRENCH_RE = /\b(?:truefrench|true french)\b/;
// Jetons français génériques (texte normalisé, un jeton par mot).
const GENERIC_FRENCH_TOKEN_RE = /^(?:french|francais|vf|fr)$/;
// Fin du titre : première année, SxxEyy, résolution ou 4K.
const TITLE_END_TOKEN_RE = /^(?:(?:19|20)\d{2}|s\d{1,2}e\d{1,2}|\d{3,4}p|2160p|4k)$/;
// Marqueurs de release : résolution, source, codec, saison/épisode.
const RELEASE_MARKER_TOKEN_RE = /^(?:\d{3,4}p|2160p|4k|web|webrip|bluray|blu|bdrip|brrip|hdtv|hdrip|dvdrip|x26[45]|h26[45]|hevc|avc|s\d{1,2}(?:e\d{1,3})?)$/;
// FRENCH en majuscules, jeton autonome dans le texte brut (casse conservée).
const UPPER_FRENCH_RE = /(?<![\p{L}\p{N}])FRENCH(?![\p{L}\p{N}])/u;
// Mentions de sous-titres dans le texte brut, retirées avant la règle FRENCH en majuscules (même motif que VOSTFR_RE / SUBFRENCH_RE).
const SUBTITLE_RAW_RE = /(?<![\p{L}\p{N}])(?:vostfr|vo[\s._-]+stfr|vost[\s._-]+fr|subfrench|sub[\s._-]+french|stfr)(?![\p{L}\p{N}])/giu;
const MULTI_RE = /\bmulti\b/;
const DUAL_RE = /\bdual\b/;
// Autres langues audio. "IT" et "ES" seuls ne sont pas acceptés (faux positifs).
const EN_RE = /\b(?:english|eng|en|vosten|vo anglais|vo anglaise)\b/;
const ES_RE = /\b(?:spanish|esp|latino|castellano)\b/;
const DE_RE = /\b(?:german|deutsch|ger)\b/;
const IT_RE = /\b(?:italian|ita)\b/;
/** Minuscules, sans accents, tout séparateur (. _ - espaces, ponctuation) remplacé par un espace. */
function normalize(text) {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
/**
 * Un jeton français générique est une balise de langue si :
 * (a) il est après le titre (coupe au premier marqueur de fin de titre, en position > 0 ; sinon tout le texte) ;
 * (b) un marqueur de release (résolution, source, codec, saison/épisode) suit dans les 2 jetons suivants ;
 * (c) il s'écrit FRENCH en majuscules, comme jeton autonome du texte brut.
 * "The.French.Dispatch.2021" et "French.Kiss.1995" ne sont donc pas FR.
 */
function hasGenericFrench(s, raw) {
    const tokens = s.split(' ').filter((token) => token !== '');
    const titleEnd = tokens.findIndex((token) => TITLE_END_TOKEN_RE.test(token));
    const cut = titleEnd > 0 ? titleEnd : 0;
    const tagged = tokens.some((token, index) => {
        if (!GENERIC_FRENCH_TOKEN_RE.test(token))
            return false;
        if (index >= cut)
            return true;
        return tokens.slice(index + 1, index + 3).some((next) => RELEASE_MARKER_TOKEN_RE.test(next));
    });
    return tagged || UPPER_FRENCH_RE.test(raw);
}
/**
 * Détecte les langues, la variante française et les mentions MULTI/DUAL/sous-titres FR
 * dans un nom de release, un nom de fichier ou une description.
 *
 * Règles principales :
 * - MULTI : multi, fr et original (frVariant seulement si une variante est présente) ;
 * - DUAL : multi sans fr ;
 * - VOSTFR / SUBFRENCH : subsFr, sans fr (original ajouté si pas d'audio FR) ;
 * - aucune langue détectée : ['original'] (hypothèse VO).
 */
export function parseLanguages(text) {
    const flagLangs = new Set();
    for (const [flag, lang] of FLAG_LANGS) {
        if (text.includes(flag))
            flagLangs.add(lang);
    }
    let s = normalize(text);
    const vostfr = s.search(VOSTFR_RE) !== -1;
    const subFrench = s.search(SUBFRENCH_RE) !== -1;
    s = s.replace(VOSTFR_RE, ' ').replace(SUBFRENCH_RE, ' ');
    const vff = VFF_RE.test(s);
    const vfq = VFQ_RE.test(s);
    const vf2 = VF2_RE.test(s);
    const truefrench = TRUEFRENCH_RE.test(s);
    const french = hasGenericFrench(s, text.replace(SUBTITLE_RAW_RE, ' '));
    const multiTag = MULTI_RE.test(s);
    const dual = DUAL_RE.test(s);
    const subsFr = vostfr || subFrench;
    const frAudio = vff || vfq || vf2 || truefrench || french || multiTag || flagLangs.has('fr');
    const langs = new Set(flagLangs);
    if (frAudio)
        langs.add('fr');
    if (multiTag || dual)
        langs.add('multi');
    if (EN_RE.test(s))
        langs.add('en');
    if (ES_RE.test(s))
        langs.add('es');
    if (DE_RE.test(s))
        langs.add('de');
    if (IT_RE.test(s))
        langs.add('it');
    if (multiTag || dual || (subsFr && !frAudio))
        langs.add('original');
    if (langs.size === 0)
        langs.add('original');
    const frVariant = [
        [vff, 'VFF'],
        [truefrench, 'TRUEFRENCH'],
        [vf2, 'VF2'],
        [vfq, 'VFQ'],
        [french, 'FRENCH'],
        [vostfr, 'VOSTFR'],
        [subFrench, 'SUBFRENCH'],
    ].find(([present]) => present)?.[1];
    const languages = LANG_ORDER.filter((lang) => langs.has(lang));
    const multi = multiTag || dual;
    return frVariant === undefined
        ? { languages, multi, subsFr }
        : { languages, frVariant, multi, subsFr };
}
