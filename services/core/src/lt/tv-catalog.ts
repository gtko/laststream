import { isRecord } from '../sources/http.js';
import { parseSafeUrl } from './guard.js';

/**
 * Catalogue TV : fusion des sources (Free-TV, iptv-org, FAST Pluto TV et Samsung TV Plus) en chaînes uniques,
 * classées par pays, langue et catégorie. Fonctions pures, sans E/S : tv.ts lit les sources et met le résultat en
 * cache.
 */

type Reliability = 'high' | 'low';
export type StreamSource = 'freetv' | 'iptvorg' | 'pluto' | 'samsung';

interface TvLanguage {
  code: string;
  name: string;
}

interface TvCategory {
  id: string;
  label: string;
}

export interface TvAlternative {
  url: string;
  source: string;
  quality: string;
  reliability: Reliability;
  /** Lisible sans relais depuis une page web (https et CORS). Absent : inconnu (catalogue des Workers seulement). */
  direct?: boolean;
}

export interface TvChannel {
  id: string;
  name: string;
  logo: string;
  group: string;
  cat: string;
  source: string;
  fast: boolean;
  url: string;
  epgId: string;
  flaky: boolean;
  country: string;
  countryName: string;
  languages: TvLanguage[];
  categories: TvCategory[];
  quality: string;
  reliability: Reliability;
  /** Flux principal lisible sans relais depuis une page web. Absent : inconnu (le relais HLS existe, ou rien n'a été sondé). */
  direct?: boolean;
  alternatives: TvAlternative[];
}

interface TvFacetItem {
  code: string;
  name: string;
  count: number;
}

export interface TvFacets {
  total: number;
  countries: TvFacetItem[];
  languages: TvFacetItem[];
  categories: TvFacetItem[];
  sources: TvFacetItem[];
}

export interface TvCatalog {
  channels: TvChannel[];
  /** Clé de recherche de chaque chaîne (même index que `channels`). */
  search: string[];
  counts: Record<StreamSource, number>;
  reliability: Record<Reliability, number>;
  facets: TvFacets;
  /** Une source au moins a échoué : le catalogue est gardé moins longtemps. */
  partial: boolean;
}

export interface TvQuery {
  country?: string;
  language?: string;
  category?: string;
  source?: string;
  q?: string;
  /** Écarte les chaînes dont aucun flux n'est lisible sans relais (page web sans proxy HLS). */
  direct?: boolean;
  page?: number;
  limit?: number;
}

/** Entrée d'une playlist M3U (Free-TV) : attributs en minuscules, nom affiché, URL. */
export interface M3uEntry {
  attrs: Record<string, string>;
  name: string;
  url: string;
}

/** Chaîne FAST (Pluto TV, Samsung TV Plus) : une entrée par chaîne et par source. */
export interface FastEntry {
  key: string;
  epgId: string;
  name: string;
  logo: string;
  group: string;
  source: 'pluto' | 'samsung';
  url: string;
  country: string;
  languages: string[];
}

/** Fichiers JSON de l'API iptv-org, déjà parsés. Une liste inexploitable reste vide. */
export interface IptvOrgRaw {
  channels: unknown;
  streams: unknown;
  feeds: unknown;
  logos: unknown;
  countries: unknown;
  languages: unknown;
  blocklist: unknown;
}

export interface CatalogInput {
  freetv: M3uEntry[] | null;
  iptv: IptvOrgRaw | null;
  fast: FastEntry[];
  partial: boolean;
}

/** Nombre de chaînes renvoyées par page quand la pagination est demandée sans `limit`. */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/** Catégories affichées (ids et libellés français). */
const CATEGORIES: readonly TvCategory[] = [
  { id: 'actualites', label: 'Actualités' },
  { id: 'sport', label: 'Sport' },
  { id: 'cinema', label: 'Cinéma' },
  { id: 'series', label: 'Séries' },
  { id: 'jeunesse', label: 'Jeunesse' },
  { id: 'musique', label: 'Musique' },
  { id: 'documentaires', label: 'Documentaires' },
  { id: 'divertissement', label: 'Divertissement' },
  { id: 'culture', label: 'Culture' },
  { id: 'religion', label: 'Religion' },
  { id: 'meteo', label: 'Météo' },
  { id: 'cuisine', label: 'Cuisine' },
  { id: 'voyage', label: 'Voyage' },
  { id: 'business', label: 'Business' },
  { id: 'education', label: 'Éducation' },
  { id: 'comedie', label: 'Comédie' },
  { id: 'classique', label: 'Classique' },
  { id: 'generaliste', label: 'Généraliste' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'autre', label: 'Autre' },
];

export const SOURCE_IDS: readonly StreamSource[] = ['freetv', 'iptvorg', 'pluto', 'samsung'];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

/** Catégories iptv-org vers catégories affichées. `xxx` n'apparaît pas : ces chaînes sont exclues. */
const IPTV_CATEGORY: Record<string, string> = {
  news: 'actualites',
  legislative: 'actualites',
  sports: 'sport',
  movies: 'cinema',
  series: 'series',
  kids: 'jeunesse',
  animation: 'jeunesse',
  family: 'jeunesse',
  music: 'musique',
  documentary: 'documentaires',
  science: 'documentaires',
  entertainment: 'divertissement',
  lifestyle: 'divertissement',
  relax: 'divertissement',
  interactive: 'divertissement',
  auto: 'divertissement',
  culture: 'culture',
  religious: 'religion',
  weather: 'meteo',
  cooking: 'cuisine',
  travel: 'voyage',
  outdoor: 'voyage',
  business: 'business',
  education: 'education',
  comedy: 'comedie',
  classic: 'classique',
  general: 'generaliste',
  public: 'generaliste',
  shop: 'shopping',
};

/** Mots-clés (texte sans accents) pour classer une chaîne sans catégorie iptv-org. Premier motif trouvé gagne. */
const KEYWORDS: [RegExp, string][] = [
  [/sport/, 'sport'],
  [/news|actualit|info/, 'actualites'],
  [/kids|jeunesse|animation|anime|enfant|famil/, 'jeunesse'],
  [/music|musique/, 'musique'],
  [/document|science|nature/, 'documentaires'],
  [/movie|cinema|film|crime|mystere|policier/, 'cinema'],
  [/serie/, 'series'],
  [/business|finance|econom/, 'business'],
  [/religi|church|bible/, 'religion'],
  [/weather|meteo/, 'meteo'],
  [/cook|cuisine|gastronom/, 'cuisine'],
  [/travel|voyage|outdoor/, 'voyage'],
  [/comedy|comedie/, 'comedie'],
  [/classic/, 'classique'],
  [/shop/, 'shopping'],
  [/cultur/, 'culture'],
  [/educat/, 'education'],
];

/** Libellés iptv-org « Geo-blocked » et « Not 24/7 » ; Free-TV : marqueur Ⓖ (GeoIP) et libellés entre crochets. */
const LOW_LABEL = /geo-blocked|not 24\/7/i;
const LOW_MARK = /\[(geo-blocked|not 24\/7)\]|Ⓖ/i;
const XXX = /xxx|adult/i;
const MAX_ALTERNATIVES = 5;
const MAX_STREAMS = MAX_ALTERNATIVES + 1;

const SOURCE_RANK: Record<StreamSource, number> = { freetv: 0, iptvorg: 1, pluto: 2, samsung: 3 };
const RELIABILITY_RANK: Record<Reliability, number> = { high: 0, low: 1 };

const FR_LANGUAGES = new Intl.DisplayNames(['fr'], { type: 'language' });
const FR_REGIONS = new Intl.DisplayNames(['fr'], { type: 'region' });
const COLLATOR = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

const stripAccents = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Clé de dédoublonnage des noms de chaînes (ASCII alphanumérique, marqueurs de qualité retirés). */
export const normName = (name: string): string =>
  stripAccents(name.toLowerCase())
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\bhd\b|\bfhd\b|\buhd\b|\b4k\b/g, ' ')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');

/** Clé de recherche : lettres et chiffres de toutes écritures, sans accents ni espaces. */
const searchKey = (value: string): string => stripAccents(value.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, '');

/** Identifiant EPG d'un attribut `tvg-id` (retire le suffixe « @… »). */
export const tvgEpgId = (id: string | undefined): string => String(id ?? '').replace(/@.*$/, '');

/** Nom affiché d'une entrée Free-TV : marqueurs Ⓢ/Ⓖ/Ⓨ et libellés entre crochets retirés. */
const cleanName = (raw: string): string =>
  raw
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[Ⓐ-ⓩ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Qualité indiquée par Ⓢ (non HD) ou par une résolution dans le nom ; vide sinon. */
const qualityOf = (raw: string): string => {
  if (raw.includes('Ⓢ')) return 'SD';
  return /\b(\d{3,4}[pi])\b/.exec(raw)?.[1] ?? '';
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const qualityValue = (quality: string): number => Number.parseInt(quality, 10) || 0;

function displayName(names: Intl.DisplayNames, code: string): string | undefined {
  try {
    const value: string | undefined = names.of(code);
    return value === undefined || value === code ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Noms français (Intl) avec repli sur les noms anglais de iptv-org, puis sur le code. */
interface Names {
  language(code: string): TvLanguage;
  country(code: string): string;
  countryLanguage(code: string): string | undefined;
}

function namesFrom(raw: IptvOrgRaw | null): Names {
  const english = new Map<string, string>();
  const countryNames = new Map<string, string>();
  const countryLanguages = new Map<string, string>();
  for (const language of records(raw?.languages)) {
    const code = str(language.code);
    if (code !== '') english.set(code, str(language.name));
  }
  for (const country of records(raw?.countries)) {
    const code = str(country.code).toUpperCase();
    if (code === '') continue;
    countryNames.set(code, str(country.name));
    const first = strings(country.languages)[0];
    if (first !== undefined) countryLanguages.set(code, first);
  }
  return {
    language: (code) => ({ code, name: displayName(FR_LANGUAGES, code) ?? english.get(code) ?? code }),
    country: (code) => displayName(FR_REGIONS, code) ?? countryNames.get(code) ?? code,
    countryLanguage: (code) => countryLanguages.get(code),
  };
}

/** Catégories affichées pour des identifiants (sans doublon ni identifiant inconnu). */
function categoryObjects(ids: string[]): TvCategory[] {
  return unique(ids)
    .map((id) => CATEGORY_BY_ID.get(id))
    .filter((category): category is TvCategory => category !== undefined);
}

function categoriesFromKeywords(text: string, fallback: string): TvCategory[] {
  const folded = stripAccents(text.toLowerCase());
  const hit = KEYWORDS.find(([pattern]) => pattern.test(folded));
  return categoryObjects([hit?.[1] ?? fallback]);
}

/** Flux candidat d'une chaîne. `order` départage les égalités (ordre d'arrivée). */
interface Stream {
  url: string;
  source: StreamSource;
  quality: string;
  reliability: Reliability;
  order: number;
}

/** Chaîne en cours d'assemblage : métadonnées retenues et flux candidats. */
interface Draft {
  id: string;
  name: string;
  logo: string;
  group: string;
  country: string;
  countryName: string;
  languages: TvLanguage[];
  categories: TvCategory[];
  epgId: string;
  search: string;
  streams: Stream[];
}

interface Sequence {
  value: number;
}

/** Ordre des flux : fiables d'abord, puis Free-TV, iptv-org, FAST ; à source égale, meilleure qualité d'abord. */
function compareStreams(a: Stream, b: Stream): number {
  return (
    RELIABILITY_RANK[a.reliability] - RELIABILITY_RANK[b.reliability] ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    qualityValue(b.quality) - qualityValue(a.quality) ||
    a.order - b.order
  );
}

/** Flux triés, sans URL en double, limités au flux principal et aux solutions de repli. */
function rankedStreams(streams: Stream[]): Stream[] {
  const seen = new Set<string>();
  const out: Stream[] = [];
  for (const stream of [...streams].sort(compareStreams)) {
    if (seen.has(stream.url)) continue;
    seen.add(stream.url);
    out.push(stream);
    if (out.length === MAX_STREAMS) break;
  }
  return out;
}

/** iptv-org : chaînes ouvertes et licites (ni fermées, ni adultes, ni sur la liste de blocage), avec un flux. */
function addIptvOrg(raw: IptvOrgRaw, names: Names, drafts: Map<string, Draft>, excluded: Set<string>, seq: Sequence): void {
  const blocked = new Set(records(raw.blocklist).map((entry) => str(entry.channel)));
  const candidates = new Map<string, Record<string, unknown>>();
  for (const channel of records(raw.channels)) {
    const id = str(channel.id);
    if (id === '') continue;
    if (channel.closed || channel.is_nsfw === true || blocked.has(id) || strings(channel.categories).includes('xxx')) {
      excluded.add(id);
      continue;
    }
    candidates.set(id, channel);
  }

  const streamed = new Map<string, { url: string; feed: string; quality: string; reliability: Reliability; order: number }[]>();
  for (const stream of records(raw.streams)) {
    const channel = str(stream.channel);
    const url = str(stream.url);
    if (!candidates.has(channel) || parseSafeUrl(url) === null) continue;
    const reliability: Reliability = strings(stream.labels).some((label) => LOW_LABEL.test(label)) ? 'low' : 'high';
    const list = streamed.get(channel) ?? [];
    list.push({ url, feed: str(stream.feed), quality: str(stream.quality), reliability, order: seq.value++ });
    streamed.set(channel, list);
  }

  // Langues : feeds (jointure streams → feeds) ; à défaut, tous les feeds ; à défaut, langue du pays.
  const feedLanguages = new Map<string, Map<string, string[]>>();
  for (const feed of records(raw.feeds)) {
    const channel = str(feed.channel);
    if (!streamed.has(channel)) continue;
    const byFeed = feedLanguages.get(channel) ?? new Map<string, string[]>();
    byFeed.set(str(feed.id), strings(feed.languages));
    feedLanguages.set(channel, byFeed);
  }

  const logos = new Map<string, string>();
  const anyLogos = new Map<string, string>();
  for (const logo of records(raw.logos)) {
    const channel = str(logo.channel);
    if (!streamed.has(channel) || logo.in_use !== true) continue;
    if (logo.feed === null && !logos.has(channel)) logos.set(channel, str(logo.url));
    if (!anyLogos.has(channel)) anyLogos.set(channel, str(logo.url));
  }

  for (const [channelId, list] of streamed) {
    const channel = candidates.get(channelId);
    if (channel === undefined) continue;
    const country = str(channel.country).toUpperCase();
    const feeds = feedLanguages.get(channelId) ?? new Map<string, string[]>();
    const used = new Set(list.map((stream) => stream.feed));
    const fromStreams = unique([...feeds].filter(([feed]) => used.has(feed)).flatMap(([, codes]) => codes));
    const fromAll = unique([...feeds.values()].flat());
    const fallback = names.countryLanguage(country);
    const codes = fromStreams.length > 0 ? fromStreams : fromAll.length > 0 ? fromAll : fallback ? [fallback] : [];
    const name = str(channel.name) || channelId;
    const categories = categoryObjects(strings(channel.categories).map((cat) => IPTV_CATEGORY[cat] ?? ''));
    drafts.set('i:' + channelId, {
      id: `${country.toLowerCase() || 'xx'}:${channelId}`,
      name,
      logo: logos.get(channelId) ?? anyLogos.get(channelId) ?? '',
      group: country ? names.country(country) : 'Général',
      country,
      countryName: country ? names.country(country) : '',
      languages: unique(codes).map((code) => names.language(code)),
      categories: categories.length > 0 ? categories : categoryObjects(['autre']),
      epgId: channelId,
      search: searchKey([name, ...strings(channel.alt_names)].join(' ')),
      streams: list.map((stream) => ({
        url: stream.url,
        source: 'iptvorg',
        quality: stream.quality,
        reliability: stream.reliability,
        order: stream.order,
      })),
    });
  }
}

/** Free-TV : une chaîne iptv-org de même identifiant EPG reçoit ce flux ; sinon, une chaîne propre à Free-TV. */
function addFreeTv(entries: M3uEntry[], names: Names, drafts: Map<string, Draft>, excluded: Set<string>, seq: Sequence): void {
  for (const entry of entries) {
    const group = entry.attrs['group-title'] ?? '';
    if (XXX.test(group) || XXX.test(entry.name) || parseSafeUrl(entry.url) === null) continue;
    const tvgId = tvgEpgId(entry.attrs['tvg-id']);
    if (tvgId !== '' && excluded.has(tvgId)) continue;
    const name = cleanName(entry.name);
    if (name === '') continue;
    const stream: Stream = {
      url: entry.url,
      source: 'freetv',
      quality: qualityOf(entry.name),
      reliability: LOW_MARK.test(entry.name) ? 'low' : 'high',
      order: seq.value++,
    };
    const matched = tvgId !== '' ? drafts.get('i:' + tvgId) : undefined;
    if (matched !== undefined) {
      matched.streams.push(stream);
      continue;
    }
    const country = /^[A-Za-z]{2}$/.test(entry.attrs['tvg-country'] ?? '') ? (entry.attrs['tvg-country'] ?? '').toUpperCase() : '';
    const ownId = tvgId !== '' ? tvgId : searchKey(name);
    const key = `f:${country}:${ownId}`;
    let draft = drafts.get(key);
    if (draft === undefined) {
      const countryName = country ? names.country(country) : '';
      const code = country ? names.countryLanguage(country) : undefined;
      draft = {
        id: `${country.toLowerCase() || 'xx'}:${ownId}`,
        name,
        logo: entry.attrs['tvg-logo'] ?? '',
        group: group.split(';')[0] || countryName || 'Général',
        country,
        countryName,
        languages: code === undefined ? [] : [names.language(code)],
        categories: categoriesFromKeywords(`${group} ${name}`, 'generaliste'),
        epgId: tvgId,
        search: searchKey(name),
        streams: [],
      };
      drafts.set(key, draft);
    }
    draft.streams.push(stream);
  }
}

/**
 * Pluto TV et Samsung TV Plus (FAST) : une chaîne au même nom normalisé qu'une chaîne française existante devient un
 * flux de repli de celle-ci ; les doublons entre les deux FAST se fondent de la même façon.
 */
function addFast(entries: FastEntry[], names: Names, drafts: Map<string, Draft>, frIndex: Map<string, Draft>, seq: Sequence): void {
  for (const entry of entries) {
    const stream: Stream = { url: entry.url, source: entry.source, quality: '', reliability: 'high', order: seq.value++ };
    const key = normName(entry.name);
    const target = key === '' ? undefined : frIndex.get(key);
    if (target !== undefined) {
      target.streams.push(stream);
      continue;
    }
    const draftKey = 'p:' + entry.key;
    const existing = drafts.get(draftKey);
    if (existing !== undefined) {
      existing.streams.push(stream);
      continue;
    }
    const draft: Draft = {
      id: entry.key,
      name: entry.name,
      logo: entry.logo,
      group: entry.group,
      country: entry.country,
      countryName: names.country(entry.country),
      languages: entry.languages.map((code) => names.language(code)),
      categories: categoriesFromKeywords(`${entry.group} ${entry.name}`, 'divertissement'),
      epgId: entry.epgId,
      search: searchKey(entry.name),
      streams: [stream],
    };
    drafts.set(draftKey, draft);
    if (key !== '') frIndex.set(key, draft);
  }
}

function facetsOf(channels: TvChannel[]): TvFacets {
  const countries = new Map<string, TvFacetItem>();
  const languages = new Map<string, TvFacetItem>();
  const categories = new Map<string, TvFacetItem>();
  const sources = new Map<string, TvFacetItem>();
  const bump = (map: Map<string, TvFacetItem>, code: string, name: string): void => {
    const current = map.get(code);
    if (current === undefined) map.set(code, { code, name, count: 1 });
    else current.count += 1;
  };
  for (const channel of channels) {
    if (channel.country !== '') bump(countries, channel.country, channel.countryName);
    for (const language of channel.languages) bump(languages, language.code, language.name);
    for (const category of channel.categories) bump(categories, category.id, category.label);
    bump(sources, channel.source, channel.source);
  }
  const sorted = (map: Map<string, TvFacetItem>): TvFacetItem[] =>
    [...map.values()].sort((a, b) => b.count - a.count || COLLATOR.compare(a.name, b.name));
  return {
    total: channels.length,
    countries: sorted(countries),
    languages: sorted(languages),
    categories: sorted(categories),
    sources: sorted(sources),
  };
}

/** Assemble le catalogue : une chaîne par identifiant, flux classés, tri (France d'abord, puis nom), facettes. */
export function buildCatalog(input: CatalogInput): TvCatalog {
  const names = namesFrom(input.iptv);
  const drafts = new Map<string, Draft>();
  const excluded = new Set<string>();
  const seq: Sequence = { value: 0 };
  if (input.iptv !== null) addIptvOrg(input.iptv, names, drafts, excluded, seq);
  if (input.freetv !== null) addFreeTv(input.freetv, names, drafts, excluded, seq);
  const frIndex = new Map<string, Draft>();
  for (const draft of drafts.values()) {
    const key = normName(draft.name);
    if (draft.country === 'FR' && key !== '' && !frIndex.has(key)) frIndex.set(key, draft);
  }
  addFast(input.fast, names, drafts, frIndex, seq);

  const counts: Record<StreamSource, number> = { freetv: 0, iptvorg: 0, pluto: 0, samsung: 0 };
  const reliability: Record<Reliability, number> = { high: 0, low: 0 };
  const rows: { channel: TvChannel; search: string }[] = [];
  for (const draft of drafts.values()) {
    const streams = rankedStreams(draft.streams);
    const primary = streams[0];
    if (primary === undefined) continue;
    counts[primary.source] += 1;
    reliability[primary.reliability] += 1;
    const categories = draft.categories.length > 0 ? draft.categories : categoryObjects(['autre']);
    rows.push({
      search: draft.search,
      channel: {
        id: draft.id,
        name: draft.name,
        logo: draft.logo,
        group: draft.group,
        cat: categories[0]?.label ?? 'Autre',
        source: primary.source,
        fast: primary.source === 'pluto' || primary.source === 'samsung',
        url: primary.url,
        epgId: draft.epgId,
        flaky: primary.reliability === 'low',
        country: draft.country,
        countryName: draft.countryName,
        languages: draft.languages,
        categories,
        quality: primary.quality,
        reliability: primary.reliability,
        alternatives: streams.slice(1).map((stream) => ({
          url: stream.url,
          source: stream.source,
          quality: stream.quality,
          reliability: stream.reliability,
        })),
      },
    });
  }
  rows.sort(
    (a, b) =>
      (a.channel.country === 'FR' ? 0 : 1) - (b.channel.country === 'FR' ? 0 : 1) ||
      COLLATOR.compare(a.channel.name, b.channel.name) ||
      a.channel.id.localeCompare(b.channel.id),
  );
  const channels = rows.map((row) => row.channel);
  return {
    channels,
    search: rows.map((row) => row.search),
    counts,
    reliability,
    facets: facetsOf(channels),
    partial: input.partial,
  };
}

/**
 * Retire du catalogue les flux dont l'URL est dans `dead` (test de santé, tv-health.ts) : un flux principal mort cède
 * la place au premier repli vivant ; une chaîne sans flux vivant disparaît. Compteurs et facettes sont recalculés.
 * Modifie `catalog` en place ; rend le nombre de chaînes retirées.
 */
export function pruneStreams(catalog: TvCatalog, dead: ReadonlySet<string>): number {
  if (dead.size === 0) return 0;
  const channels: TvChannel[] = [];
  const search: string[] = [];
  const counts: Record<StreamSource, number> = { freetv: 0, iptvorg: 0, pluto: 0, samsung: 0 };
  const reliability: Record<Reliability, number> = { high: 0, low: 0 };
  catalog.channels.forEach((channel, index) => {
    const alternatives = channel.alternatives.filter((alt) => !dead.has(alt.url));
    let kept = channel;
    if (dead.has(channel.url)) {
      const [next, ...rest] = alternatives;
      if (next === undefined) return;
      kept = {
        ...channel,
        url: next.url,
        source: next.source,
        fast: next.source === 'pluto' || next.source === 'samsung',
        quality: next.quality,
        reliability: next.reliability,
        flaky: next.reliability === 'low',
        alternatives: rest,
      };
      if (next.direct === undefined) delete kept.direct;
      else kept.direct = next.direct;
    } else {
      kept.alternatives = alternatives;
    }
    channels.push(kept);
    search.push(catalog.search[index] ?? '');
    counts[kept.source as StreamSource] += 1;
    reliability[kept.reliability] += 1;
  });
  const removed = catalog.channels.length - channels.length;
  catalog.channels = channels;
  catalog.search = search;
  catalog.counts = counts;
  catalog.reliability = reliability;
  catalog.facets = facetsOf(channels);
  return removed;
}

/**
 * Chaînes filtrées (pays ISO2, langue ISO 639-3, catégorie, source, recherche). Sans `page` ni `limit` : tout le
 * catalogue. Sinon : la page demandée (100 par défaut).
 */
export function selectChannels(catalog: TvCatalog, query: TvQuery): { total: number; items: TvChannel[] } {
  const needle = query.q !== undefined && query.q !== '' ? searchKey(query.q) : '';
  const matches: TvChannel[] = [];
  catalog.channels.forEach((channel, index) => {
    if (query.country !== undefined && channel.country !== query.country) return;
    if (query.language !== undefined && !channel.languages.some((language) => language.code === query.language)) return;
    if (query.category !== undefined && !channel.categories.some((category) => category.id === query.category)) return;
    if (query.source !== undefined && channel.source !== query.source) return;
    if (query.direct === true && channel.direct === false && !channel.alternatives.some((alt) => alt.direct !== false)) return;
    if (needle !== '' && !(catalog.search[index] ?? '').includes(needle)) return;
    matches.push(channel);
  });
  if (query.page === undefined && query.limit === undefined) return { total: matches.length, items: matches };
  const limit = query.limit ?? DEFAULT_LIMIT;
  const page = query.page ?? 1;
  return { total: matches.length, items: matches.slice((page - 1) * limit, page * limit) };
}
