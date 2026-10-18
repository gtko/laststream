import { BANDWIDTH_HEADROOM, matchesLanguage, pickAutoplay, QUALITY_GROUP_ORDER, type QualityGroupKey } from '../data/sources';
import type { Lang } from '../data/stream';
import type { SourceView } from './info';

/* Filtres, tri, regroupement et recommandation des sources. Fonctions pures, testées. */

export type SortKey = 'recommended' | 'quality' | 'size' | 'bitrate';
export const SORT_LABELS: Record<SortKey, string> = { recommended: 'Recommandé', quality: 'Qualité', size: 'Taille', bitrate: 'Débit' };
export const SORT_KEYS: readonly SortKey[] = ['recommended', 'quality', 'size', 'bitrate'];

export type LangFilter = 'fr' | 'vo' | 'multi';

export interface SourceFilters {
  resolutions: ReadonlySet<QualityGroupKey>;
  langs: ReadonlySet<LangFilter>;
  cachedOnly: boolean;
  hdrOnly: boolean;
}

export const NO_FILTERS: SourceFilters = { resolutions: new Set(), langs: new Set(), cachedOnly: false, hdrOnly: false };

export function filtersActive(f: SourceFilters): boolean {
  return f.resolutions.size > 0 || f.langs.size > 0 || f.cachedOnly || f.hdrOnly;
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
}

const LANG_NAME: Record<string, string> = { fr: 'VF', en: 'VO anglaise', es: 'VO espagnole', de: 'VO allemande', it: 'VO italienne' };
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
  /** Navigateur : préfère les sources qui se lisent sans conversion (inutile dans la coque Windows, où mpv lit tout). */
  preferDirect?: boolean;
}

const TIER: Record<QualityGroupKey, number> = { '2160p': 3, '1080p': 2, '720p': 1, SD: 0, other: 0 };

/** Rang d'une source dans le navigateur : sa résolution, moins un cran si elle exige une conversion. */
export function webRank(v: SourceView): number {
  return TIER[v.group] - (v.web === 'convert' ? 1 : 0);
}

/**
 * Source recommandée parmi les lisibles : meilleure qui tient dans 80 % du débit, dans la langue préférée si possible.
 * Dans le navigateur (`preferDirect`), à langue égale la lecture directe passe avant la conversion : un 4K HEVC REMUX ne
 * l'emporte pas sur un 1080p lisible directement. Si aucune ne tient, la moins lourde est proposée avec un avertissement.
 */
export function recommend(views: readonly SourceView[], bwKbps: number | null, preferred: Lang = 'fr', opts: RecommendOptions = {}): Recommendation | null {
  const playable = views.filter((v) => v.playable);
  if (!playable.length) return null;
  const budget = bwKbps === null || !Number.isFinite(bwKbps) ? Infinity : Math.max(0, bwKbps) * BANDWIDTH_HEADROOM;
  const fits = (v: SourceView): boolean => v.bitrateKbps === null || v.bitrateKbps <= budget;
  const langOk = (v: SourceView): boolean => !!v.info && matchesLanguage(v.info, preferred);
  if (opts.preferDirect) {
    const fitting = playable.filter((v) => v.info && fits(v));
    if (fitting.length) {
      const webOrder = (a: SourceView, b: SourceView): number =>
        webRank(b) - webRank(a) || (b.web === 'direct' ? 1 : 0) - (a.web === 'direct' ? 1 : 0) || b.score - a.score || a.index - b.index;
      const withLang = fitting.filter(langOk).sort(webOrder);
      const pool = withLang.length ? withLang : [...fitting].sort(webOrder);
      const view = pool[0];
      const fallback = withLang.length ? false : playable.some(langOk) ? 'vf-too-heavy' : 'no-vf';
      return { view, languageFallback: fallback !== false, reason: recommendationReason(view, bwKbps, preferred, fallback) + (view.web === 'direct' ? ' · lecture directe' : view.web === 'convert' ? ' · avec conversion' : '') };
    }
  } else {
    const streams = playable.map((v) => v.stream);
    const pick = pickAutoplay(streams, bwKbps, preferred);
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
  return !!rec && !rec.languageFallback && rec.view.status === 'cached' && (rec.view.group === '2160p' || rec.view.group === '1080p');
}

/** « Recherche encore sur C411, YGG et 2 autres… » */
export function describePending(pending: readonly string[]): string {
  if (!pending.length) return '';
  const shown = pending.slice(0, 2).join(', ');
  const more = pending.length - 2;
  return 'Recherche encore sur ' + shown + (more > 0 ? ' et ' + more + ' autre' + (more > 1 ? 's' : '') : '') + '…';
}
