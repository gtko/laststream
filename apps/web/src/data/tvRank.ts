/* TV en direct : pertinence des chaînes (TNT gratuite dans l'ordre officiel d'abord), numéro de chaîne, codes de langue.
 * Logique pure, testée. */

/** Minuscules, sans accents ni ponctuation : « L'Équipe » → « lequipe ». */
export const normText = (s: unknown): string =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' et ').replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '');

// ---- Langues : le serveur filtre en ISO 639-3 (« fra »), pas en ISO 639-1 (« fr » → 400). ----
const LANG3: Record<string, string> = {
  fr: 'fra', fre: 'fra', en: 'eng', es: 'spa', de: 'deu', ger: 'deu', it: 'ita', pt: 'por', nl: 'nld', dut: 'nld', ar: 'ara', ru: 'rus', tr: 'tur',
  pl: 'pol', ja: 'jpn', zh: 'zho', chi: 'zho', hi: 'hin', sv: 'swe', da: 'dan', no: 'nor', fi: 'fin', el: 'ell', gre: 'ell', cs: 'ces', cze: 'ces',
  ro: 'ron', rum: 'ron', hu: 'hun', uk: 'ukr', he: 'heb', ko: 'kor', fa: 'fas', per: 'fas', vi: 'vie', th: 'tha', id: 'ind', ca: 'cat', eu: 'eus', gl: 'glg',
};

/** Code de langue au format du serveur (ISO 639-3, minuscules) ; chaîne vide si inconnu. */
export function langCode3(code: unknown): string {
  const c = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (!c) return '';
  return LANG3[c] ?? (c.length === 3 ? c : '');
}

export const sameLang = (a: unknown, b: unknown): boolean => {
  const x = langCode3(a);
  return x !== '' && x === langCode3(b);
};

// ---- Numérotation officielle ----
export interface NationalChannel {
  num: number;
  label: string;
  /** Noms (normalisés) et identifiants EPG (sans le suffixe pays) reconnus. */
  keys: string[];
  /** Identifiant du guide quand la chaîne manque au catalogue. */
  epg: string;
}

const tnt = (num: number, label: string, epg: string, ...keys: string[]): NationalChannel => ({ num, label, epg, keys: [normText(label), ...keys.map(normText)] });

/** TNT gratuite française, numéros officiels. */
export const NATIONAL: Record<string, NationalChannel[]> = {
  FR: [
    tnt(1, 'TF1', 'TF1.fr'),
    tnt(2, 'France 2', 'France2.fr'),
    tnt(3, 'France 3', 'France3.fr'),
    tnt(4, 'Canal+', 'CanalPlus.fr', 'canal'),
    tnt(5, 'France 5', 'France5.fr'),
    tnt(6, 'M6', 'M6.fr'),
    tnt(7, 'Arte', 'arte.fr', 'ARTEFrench'),
    tnt(8, 'C8', 'C8.fr'),
    tnt(9, 'W9', 'W9.fr'),
    tnt(10, 'TMC', 'TMC.fr'),
    tnt(11, 'TFX', 'TFX.fr'),
    tnt(12, 'NRJ12', 'NRJ12.fr', 'NRJ 12'),
    tnt(13, 'LCP', 'LCP.fr', 'LCP Assemblée nationale', 'LCP AN'),
    tnt(14, 'France 4', 'France4.fr'),
    tnt(15, 'BFM TV', 'BFMTV.fr', 'BFMTV'),
    tnt(16, 'CNews', 'CNews.fr'),
    tnt(17, 'CStar', 'CStar.fr', 'C Star'),
    tnt(18, 'Gulli', 'Gulli.fr'),
    tnt(20, 'TF1 Séries Films', 'TF1SeriesFilms.fr', 'TF1 Series Films'),
    tnt(21, 'L’Équipe', 'LEquipe.fr', 'L Equipe', 'LEquipe21'),
    tnt(22, '6ter', '6ter.fr'),
    tnt(23, 'RMC Story', 'RMCStory.fr'),
    tnt(24, 'RMC Découverte', 'RMCDecouverte.fr'),
    tnt(25, 'Chérie 25', 'Cherie25.fr', 'Cherie'),
    tnt(26, 'LCI', 'LCI.fr'),
    tnt(27, 'franceinfo', 'Franceinfo.fr', 'France Info'),
  ],
};

const REGIONAL: Record<string, RegExp> = { FR: /^france3.+/ };

interface RankableChannel {
  id?: string;
  name?: string;
  epgId?: string;
  cat?: string;
  source?: string;
  fast?: boolean;
  flaky?: boolean;
  lowRel?: boolean;
  categories?: Array<{ id?: string; label?: string }>;
  num?: number | null;
}

/** Entrée nationale d'une chaîne (par nom ou identifiant du guide), ou null. */
export function nationalEntry(c: RankableChannel, country: string): NationalChannel | null {
  const table = NATIONAL[String(country).toUpperCase()];
  if (!table) return null;
  const keys = new Set([normText(c.name), normText(String(c.epgId ?? '').replace(/\.[a-z]{2}$/i, '')), normText(String(c.id ?? '').replace(/^[a-z]+:/, '').replace(/\.[a-z]{2}$/i, ''))]);
  keys.delete('');
  return table.find((e) => e.keys.some((k) => keys.has(k))) ?? null;
}

/** Popularité des catégories (plus petit : plus haut dans la liste). */
const CAT_ORDER = ['generaliste', 'actualites', 'divertissement', 'cinema', 'series', 'sport', 'jeunesse', 'documentaires', 'musique', 'cuisine', 'education', 'culture', 'business', 'religion'];
const SOURCE_ORDER = ['freetv', 'iptvorg', 'samsung', 'pluto'];

const catRank = (c: RankableChannel): number => {
  const ids = (c.categories ?? []).map((k) => normText(k.id || k.label)).concat(normText(c.cat));
  let best = CAT_ORDER.length;
  ids.forEach((id) => { const i = CAT_ORDER.indexOf(id); if (i >= 0 && i < best) best = i; });
  return best;
};
const srcRank = (c: RankableChannel): number => {
  const i = SOURCE_ORDER.indexOf(normText(c.source));
  return i < 0 ? SOURCE_ORDER.length : i;
};
const isLow = (c: RankableChannel): boolean => !!(c.lowRel || c.flaky);

/**
 * Classe les chaînes par pertinence : chaînes nationales gratuites dans l'ordre officiel (le meilleur flux de chaque
 * numéro porte `num`), France 3 régionales, puis popularité de la catégorie ; les chaînes instables passent en dernier.
 * Le tri est stable et ne modifie pas la liste d'origine (seul `num` est posé sur les chaînes).
 */
export function rankChannels<T extends RankableChannel>(list: readonly T[], country: string): T[] {
  const cc = String(country || '').toUpperCase();
  const regional = REGIONAL[cc];
  const best = new Map<number, T>();
  const entryOf = new Map<T, NationalChannel | null>();
  list.forEach((c) => {
    const e = nationalEntry(c, cc);
    entryOf.set(c, e);
    if (!e) return;
    const cur = best.get(e.num);
    if (!cur || (isLow(cur) && !isLow(c)) || (isLow(cur) === isLow(c) && srcRank(c) < srcRank(cur))) best.set(e.num, c);
  });
  const scored = list.map((c, i) => {
    const e = entryOf.get(c) ?? null;
    const isBest = !!e && best.get(e.num) === c;
    c.num = isBest && e ? e.num : null;
    let tier = 3;
    if (isBest && e) tier = 0;
    else if (e) tier = 2.5; // doublon d'une chaîne nationale : après les chaînes pertinentes
    else if (regional && regional.test(normText(c.name))) tier = 1;
    const low = isLow(c) ? 1 : 0;
    return { c, i, tier, low, num: e ? e.num : 0, cat: catRank(c), fast: c.fast ? 1 : 0, src: srcRank(c) };
  });
  scored.sort((a, b) => a.low - b.low || a.tier - b.tier || a.num - b.num || a.cat - b.cat || a.fast - b.fast || a.src - b.src || String(a.c.name).localeCompare(String(b.c.name), 'fr') || a.i - b.i);
  // Les chaînes numérotées restent en tête même si leur flux est jugé instable (aucune alternative sinon).
  const head = scored.filter((x) => x.tier === 0);
  const tail = scored.filter((x) => x.tier !== 0);
  head.sort((a, b) => a.num - b.num);
  return head.concat(tail).map((x) => x.c);
}

/** Libellé du numéro (« 6 ») ou chaîne vide. */
export const channelNumber = (c: RankableChannel): string => (c.num ? String(c.num) : '');
