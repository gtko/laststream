import { BANDWIDTH_HEADROOM, matchesLanguage, pickAutoplay, QUALITY_GROUP_ORDER, type QualityGroupKey } from '../data/sources';
import type { Lang } from '../data/stream';
import { fileCodecsOf } from '../party/compat';
import { capLabel, capViews, GROUP_HEIGHT } from './resolutionCap';
import type { SourceView } from './info';

/* Filtres, tri, regroupement et recommandation des sources. Fonctions pures, testées. */

export type SortKey = 'recommended' | 'quality' | 'size' | 'bitrate';
export const SORT_LABELS: Record<SortKey, string> = { recommended: 'Recommandé', quality: 'Qualité', size: 'Taille', bitrate: 'Débit' };
export const SORT_KEYS: readonly SortKey[] = ['recommended', 'quality', 'size', 'bitrate'];

type LangFilter = 'fr' | 'vo' | 'multi';

export interface SourceFilters {
  resolutions: ReadonlySet<QualityGroupKey>;
  langs: ReadonlySet<LangFilter>;
  cachedOnly: boolean;
  hdrOnly: boolean;
  /** Noms d'origine retenus (vide : toutes). */
  origins: ReadonlySet<string>;
}

export const NO_FILTERS: SourceFilters = { resolutions: new Set(), langs: new Set(), cachedOnly: false, hdrOnly: false, origins: new Set() };

export function filtersActive(f: SourceFilters): boolean {
  return f.resolutions.size > 0 || f.langs.size > 0 || f.cachedOnly || f.hdrOnly || f.origins.size > 0;
}

function matchesLangFilter(v: SourceView, l: LangFilter): boolean {
  const langs = v.info?.languages ?? [];
  if (l === 'multi') return langs.includes('multi') || v.langs.some((b) => /multi/i.test(b.label));
  if (l === 'fr') return v.hasFrench && !v.langs.every((b) => /vostfr/i.test(b.label));
  return langs.includes('original') || langs.includes('en') || v.langs.some((b) => /^(vo|vostfr)$/i.test(b.label)) || (!v.hasFrench && langs.length > 0);
}

export function applyFilters(views: readonly SourceView[], f: SourceFilters): SourceView[] {
  return views.filter((v) => {
    if (f.resolutions.size && !f.resolutions.has(v.group)) return false;
    if (f.langs.size && ![...f.langs].some((l) => matchesLangFilter(v, l))) return false;
    if (f.cachedOnly && v.status !== 'cached') return false;
    if (f.hdrOnly && v.hdr.length === 0) return false;
    if (f.origins.size && !v.origins.some((o) => f.origins.has(o.name))) return false;
    return true;
  });
}

const groupRank = (v: SourceView): number => QUALITY_GROUP_ORDER.indexOf(v.group);

/** Tri stable. `recommended` : score lastAddon décroissant ; le recommandé (s'il y en a un) passe en tête. */
export function sortViews(views: readonly SourceView[], key: SortKey, recommendedIndex: number | null = null): SourceView[] {
  const list = [...views];
  const by = (cmp: (a: SourceView, b: SourceView) => number) => list.sort((a, b) => cmp(a, b) || a.index - b.index);
  switch (key) {
    case 'quality': by((a, b) => groupRank(a) - groupRank(b) || b.score - a.score); break;
    case 'size': by((a, b) => b.sizeBytes - a.sizeBytes); break;
    case 'bitrate': by((a, b) => (b.bitrateKbps ?? -1) - (a.bitrateKbps ?? -1)); break;
    default: by((a, b) => b.score - a.score);
  }
  if (key === 'recommended' && recommendedIndex !== null) {
    const i = list.findIndex((v) => v.index === recommendedIndex);
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  return list;
}

export interface ViewGroup {
  key: QualityGroupKey;
  views: SourceView[];
}

/** Regroupe par résolution (ordre 4K → SD), groupes vides omis ; l'ordre interne est conservé. */
export function groupViews(views: readonly SourceView[]): ViewGroup[] {
  return QUALITY_GROUP_ORDER.map((key) => ({ key, views: views.filter((v) => v.group === key) })).filter((g) => g.views.length > 0);
}

/** Compteurs par résolution sur la liste complète (avant filtres), pour les puces de filtre. */
export function countByGroup(views: readonly SourceView[]): Partial<Record<QualityGroupKey, number>> {
  const out: Partial<Record<QualityGroupKey, number>> = {};
  views.forEach((v) => { out[v.group] = (out[v.group] ?? 0) + 1; });
  return out;
}

export interface Recommendation {
  view: SourceView;
  languageFallback: boolean;
  reason: string;
  /** Le plafond de résolution a écarté de meilleures sources : celle-ci est la meilleure permise (inutile d'attendre mieux). */
  atCap?: boolean;
}

const LANG_NAME: Record<string, string> = { original: 'VO', multi: 'multi-audio', fr: 'VF', en: 'VO anglaise', es: 'VO espagnole', de: 'VO allemande', it: 'VO italienne' };
const mbps = (kbps: number): string => String(Math.round(kbps / 1000));

/** Phrase « Pourquoi ce choix » pour la source recommandée. */
export function recommendationReason(v: SourceView, bwKbps: number | null, preferred: Lang, fallback: false | 'no-vf' | 'vf-too-heavy'): string {
  const lang = LANG_NAME[preferred] ?? preferred.toUpperCase();
  const fit = bwKbps && bwKbps > 0 ? ' qui tient dans ta connexion (' + mbps(bwKbps) + ' Mb/s)' : '';
  const extras = [v.status === 'cached' ? 'déjà en cache' : ''].filter(Boolean).join(', ');
  const tail = extras ? ', ' + extras : '';
  if (fallback === 'no-vf') return 'Pas de ' + lang + ' disponible : meilleure VO' + fit + tail;
  if (fallback === 'vf-too-heavy') return 'Les ' + lang + ' sont trop lourdes pour ta connexion' + (bwKbps ? ' (' + mbps(bwKbps) + ' Mb/s)' : '') + ' : meilleure VO' + tail;
  return 'Meilleure ' + lang + (fit || ' disponible') + tail;
}

export interface RecommendOptions {
  /** Langues de source acceptées en plus de la langue préférée (mode apprentissage : VO, multi). */
  alsoAccept?: readonly Lang[];
  /** Navigateur : préfère les sources qui se lisent sans conversion (inutile dans la coque Windows, où mpv lit tout). */
  preferDirect?: boolean;
  /**
   * Navigateur sans Dolby natif (`preferDirect` aussi) : une source AC-3 / E-AC-3, décodée par l'app, cède la place à une source
   * AAC / Opus de résolution proche (un cran plus bas au plus, 720p au moins). La langue et la VF restent prioritaires.
   */
  preferAac?: boolean;
  /** Plafond de résolution en pixels (ODY-236) : une source plus haute n'est choisie qu'à défaut de toute autre ; null ou absent : aucun. */
  maxHeight?: number | null;
}

// 1440p entre le 4K et le 1080p sans changer l'écart d'un cran entre 4K et 1080p (conversion, son AAC de remplacement).
const TIER: Record<QualityGroupKey, number> = { '2160p': 3, '1440p': 2.5, '1080p': 2, '720p': 1, SD: 0, other: 0 };

/** Codec audio connu d'après le nom de la source (parseur de `party/compat`), ou null. */
const soundOf = (v: SourceView): string | null => fileCodecsOf(v).audio;
const isDolbySound = (v: SourceView): boolean => { const s = soundOf(v); return s === 'ac3' || s === 'eac3'; };
const isAacOpusSound = (v: SourceView): boolean => { const s = soundOf(v); return s === 'aac' || s === 'opus'; };

/**
 * Son Dolby en tête : la meilleure source AAC / Opus de résolution proche (un cran plus bas au plus, 720p au moins) la remplace.
 * `ordered` est trié (langue puis classement web) : la première AAC / Opus retenue est la mieux classée des proches. Null sinon.
 */
function aacInstead(ordered: readonly SourceView[]): SourceView | null {
  const top = ordered[0];
  if (!top || !isDolbySound(top)) return null;
  const floor = Math.max(TIER['720p'], TIER[top.group] - 1);
  return ordered.find((v) => TIER[v.group] >= floor && isAacOpusSound(v)) ?? null;
}

/**
 * Rang d'une source dans le navigateur : sa résolution, moins un cran pour une conversion audio seule (la vidéo est copiée),
 * et trois crans pour un réencodage vidéo (lent, gourmand : un 4K HEVC ne passe pas devant un 1080p lisible).
 */
export function webRank(v: SourceView): number {
  return TIER[v.group] - (v.web !== 'convert' ? 0 : v.convert === 'video' ? 3 : 1);
}

/**
 * Source recommandée parmi les lisibles : meilleure qui tient dans 80 % du débit, dans la langue préférée si possible.
 * Dans le navigateur (`preferDirect`), à langue égale la lecture directe passe avant la conversion : un 4K HEVC REMUX ne
 * l'emporte pas sur un 1080p lisible directement. Si aucune ne tient, la moins lourde est proposée avec un avertissement.
 */
export function recommend(views: readonly SourceView[], bwKbps: number | null, preferred: Lang = 'fr', opts: RecommendOptions = {}): Recommendation | null {
  const maxHeight = opts.maxHeight ?? null;
  const playable = views.filter((v) => v.playable);
  if (maxHeight === null) return recommendPool(playable, bwKbps, preferred, opts);
  // Plafond de résolution. Dans la langue préférée d'abord : si seule une source au-dessus du plafond la parle, le plafond cède
  // (mieux vaut une VF un peu plus lourde qu'une VO) plutôt que d'annoncer à tort « pas de VF ».
  const langOk = (v: SourceView): boolean => !!v.info && matchesLanguage(v.info, preferred, opts.alsoAccept);
  let capped = capViews(playable, maxHeight);
  if (!capped.pool.some(langOk) && playable.some(langOk)) capped = capViews(playable.filter(langOk), maxHeight);
  const rec = recommendPool(capped.pool, bwKbps, preferred, opts);
  if (!rec) return null;
  const label = capLabel(maxHeight);
  if (capped.above) return { ...rec, reason: rec.reason + ' · aucune source en ' + label + ' ou moins, la plus proche est proposée' };
  // `atCap` : la source atteint le plafond lui-même (aucune source à venir ne peut mieux faire), jamais selon les sources déjà reçues.
  const atCap = GROUP_HEIGHT[rec.view.group] >= maxHeight;
  return { ...rec, ...(atCap ? { atCap } : {}), ...(capped.hidden === 0 ? {} : { reason: rec.reason + ' · plafond ' + label }) };
}

/** Choix parmi des sources lisibles déjà filtrées par le plafond de résolution. */
function recommendPool(playable: readonly SourceView[], bwKbps: number | null, preferred: Lang, opts: RecommendOptions): Recommendation | null {
  if (!playable.length) return null;
  const budget = bwKbps === null || !Number.isFinite(bwKbps) ? Infinity : Math.max(0, bwKbps) * BANDWIDTH_HEADROOM;
  const fits = (v: SourceView): boolean => v.bitrateKbps === null || v.bitrateKbps <= budget;
  const langOk = (v: SourceView): boolean => !!v.info && matchesLanguage(v.info, preferred, opts.alsoAccept);
  if (opts.preferDirect) {
    const fits0 = playable.filter((v) => v.info && fits(v));
    // Web sans serveur : une source dont le son ne peut pas être joué (DTS, TrueHD) ne passe qu'à défaut de toute alternative,
    // même dans une autre langue (une image sans son ne sert à personne).
    const fitting = fits0.some((v) => v.appAudio !== 'unsupported') ? fits0.filter((v) => v.appAudio !== 'unsupported') : fits0;
    if (fitting.length) {
      const webOrder = (a: SourceView, b: SourceView): number =>
        webRank(b) - webRank(a) || (b.web === 'direct' ? 1 : 0) - (a.web === 'direct' ? 1 : 0) || b.score - a.score || a.index - b.index;
      const withLang = fitting.filter(langOk).sort(webOrder);
      const pool = withLang.length ? withLang : [...fitting].sort(webOrder);
      const aac = opts.preferAac ? aacInstead(pool) : null;
      const view = aac ?? pool[0];
      const fallback = withLang.length ? false : playable.some(langOk) ? 'vf-too-heavy' : 'no-vf';
      const soundNote = aac ? ' · son AAC plutôt que Dolby' : '';
      return { view, languageFallback: fallback !== false, reason: recommendationReason(view, bwKbps, preferred, fallback) + (view.web === 'direct' ? ' · lecture directe' : view.appAudio === 'app' ? ' · son décodé par l’app' : view.appAudio === 'unsupported' ? ' · sans son (DTS)' : view.convert === 'video' ? ' · avec réencodage vidéo' : view.web === 'convert' ? ' · avec conversion audio' : '') + soundNote };
    }
  } else {
    const streams = playable.map((v) => v.stream);
    const pick = pickAutoplay(streams, bwKbps, preferred, opts.alsoAccept);
    if (pick) {
      const view = playable[streams.indexOf(pick.stream)];
      return { view, languageFallback: pick.languageFallback, reason: recommendationReason(view, bwKbps, preferred, pick.languageFallback ? pick.fallbackReason ?? 'no-vf' : false) };
    }
  }
  const lightest = [...playable].sort((a, b) => (a.bitrateKbps ?? Infinity) - (b.bitrateKbps ?? Infinity) || b.score - a.score)[0];
  const usable = budget === Infinity ? 0 : Math.round(budget / 1000);
  return { view: lightest, languageFallback: !lightest.hasFrench, reason: 'Aucune source ne tient dans ta connexion' + (usable ? ' (' + usable + ' Mb/s utiles)' : '') + ' : la moins lourde est proposée' };
}

/**
 * Une liste partielle suffit pour lancer la lecture : source en cache, dans la langue préférée (pas un repli), en 1080p ou mieux.
 * Sinon on attend le reste de la recherche.
 */
export function isGoodMatch(rec: Recommendation | null): boolean {
  return !!rec && !rec.languageFallback && rec.view.status === 'cached' && (rec.atCap === true || rec.view.group === '2160p' || rec.view.group === '1440p' || rec.view.group === '1080p');
}

/** « C411, YGG et 2 autres » */
function pendingNames(pending: readonly string[]): string {
  const shown = pending.slice(0, 2).join(', ');
  const more = pending.length - 2;
  return shown + (more > 0 ? ' et ' + more + ' autre' + (more > 1 ? 's' : '') : '');
}

/** « Recherche encore sur C411, YGG et 2 autres… » */
export function describePending(pending: readonly string[]): string {
  if (!pending.length) return '';
  return 'Recherche encore sur ' + pendingNames(pending) + '…';
}

/** « Lancement avec 10 sources (loostream encore en recherche) » : lecture lancée pendant que des addons répondent encore. */
export function describeLaunch(count: number, pending: readonly string[]): string {
  return 'Lancement avec ' + count + ' source' + (count > 1 ? 's' : '') + ' (' + pendingNames(pending) + ' encore en recherche)';
}

/** Nombre de sources par origine, de la plus fournie à la moins fournie. */
export function countOrigins(views: readonly SourceView[]): Array<{ name: string; count: number; logo?: string }> {
  const map = new Map<string, { name: string; count: number; logo?: string }>();
  for (const v of views) {
    for (const o of v.origins) {
      const e = map.get(o.name) ?? { name: o.name, count: 0, logo: o.logo };
      e.count += 1;
      if (!e.logo && o.logo) e.logo = o.logo;
      map.set(o.name, e);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
