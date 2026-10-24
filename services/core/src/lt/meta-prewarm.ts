import { isRecord } from '../sources/http.js';
import { CATALOGS } from './catalog.js';
import type { LtContext } from './context.js';
import { type MetaRuntime, type MetaServices, type MetaType, type PrewarmBudget, prewarmFiche } from './meta.js';
import { tmdbGet } from './providers.js';
import { top10Page } from './top10.js';

/**
 * Préchauffage des fiches partagées (ODY-297, lot E) : au cron, les fiches des rangées d'accueil et du Top 10 sont
 * reconstruites dans R2 avant que les comptes les demandent. Une fiche n'est reconstruite que si une de ses couches est
 * absente ou expire dans moins de `PREWARM_HORIZON_MS` ; une couche fraîche n'est jamais touchée. Chaque passage est
 * borné : `PREWARM_MAX_TMDB` reconstructions TMDB et `PREWARM_MAX_MDBLIST` appels MDBList ; le reste attend le passage suivant.
 */

/** Une couche qui expire dans moins de ce délai est reconstruite par le passage (une heure de marge sur le cron de 6 h). */
export const PREWARM_HORIZON_MS = 24 * 3600e3;
/** Reconstructions TMDB (une par fiche engagée) au plus par passage. */
export const PREWARM_MAX_TMDB = 300;
/**
 * Appels MDBList au plus par passage. Le budget quotidien global (quota.ts), le limiteur et le disjoncteur s'appliquent à
 * chaque appel, préchauffage compris (garde commune de mdblist-guard.ts).
 */
export const PREWARM_MAX_MDBLIST = 100;
/** Région du Top 10 préchauffé (valeur par défaut de la route /top10). */
const PREWARM_REGION = 'FR';

/** Fiche à préchauffer : type et identifiant TMDB. */
export interface PrewarmTarget {
  type: MetaType;
  tmdbId: number;
}

/** Bilan d'un passage (aucun identifiant ni contenu). */
export interface PrewarmReport {
  targets: number;
  core: number;
  ratings: number;
  failed: number;
}

/**
 * Fiches d'une liste TMDB : `kind` fixe le type (film ou série), `mixed` prend le `media_type` de chaque élément. Les
 * personnes, les identifiants absents ou non entiers sont écartés.
 */
export function targetsOf(results: readonly unknown[], kind: 'movie' | 'tv' | 'mixed'): PrewarmTarget[] {
  const targets: PrewarmTarget[] = [];
  for (const raw of results) {
    if (!isRecord(raw) || typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id < 1) continue;
    const media = kind === 'mixed' ? raw.media_type : kind;
    if (media === 'movie') targets.push({ type: 'movie', tmdbId: raw.id });
    else if (media === 'tv') targets.push({ type: 'series', tmdbId: raw.id });
  }
  return targets;
}

/** Première page d'une liste TMDB, lue chez TMDB (cache de l'instance). Une erreur n'écarte que cette liste. */
async function listTargets(ctx: LtContext, token: string, path: string, kind: 'movie' | 'tv' | 'mixed'): Promise<PrewarmTarget[]> {
  try {
    const json = await tmdbGet(ctx, token, path, { page: '1' });
    return targetsOf(isRecord(json) && Array.isArray(json.results) ? json.results : [], kind);
  } catch (err) {
    console.warn(`[lt][meta-prewarm] liste ${path} indisponible (${err instanceof Error ? err.name : 'inconnue'})`);
    return [];
  }
}

/**
 * Fiches à préchauffer : première page des rangées d'accueil (catalogues de catalog.ts) et du Top 10 (films, séries, puis
 * mêlés). Les rangées ne stockent que des ids IMDb : les ids TMDB sont relus dans les listes. Doublons retirés, ordre de
 * lecture conservé.
 */
export async function collectPrewarmTargets(ctx: LtContext, token: string, now: number): Promise<PrewarmTarget[]> {
  const found: PrewarmTarget[][] = [];
  for (const def of CATALOGS) found.push(await listTargets(ctx, token, def.path, def.kind));
  for (const type of ['movie', 'tv', 'all'] as const) {
    try {
      const page = await top10Page(ctx, token, type, PREWARM_REGION, 1, now);
      found.push(targetsOf(page.results, type === 'all' ? 'mixed' : type));
    } catch (err) {
      console.warn(`[lt][meta-prewarm] top 10 ${type} indisponible (${err instanceof Error ? err.name : 'inconnue'})`);
    }
  }
  const seen = new Set<string>();
  const targets: PrewarmTarget[] = [];
  for (const target of found.flat()) {
    const key = `${target.type}:${target.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/** Ressources d'un passage : contexte et stockage (dans `meta`), clés de service, horizon (ms). */
export interface PrewarmRuntime {
  meta: MetaRuntime;
  svc: MetaServices;
  horizonMs?: number;
}

/**
 * Passage de préchauffage : une fiche après l'autre, dans l'ordre des cibles. Une fiche en échec est comptée et n'arrête pas
 * le passage ; le passage s'arrête quand plus aucun budget ne permet de reconstruire. `budget` est décrémenté en place.
 */
export async function prewarmMetaFiches(
  rt: PrewarmRuntime,
  targets: readonly PrewarmTarget[],
  budget: PrewarmBudget = { tmdb: PREWARM_MAX_TMDB, mdblist: PREWARM_MAX_MDBLIST },
): Promise<PrewarmReport> {
  const report: PrewarmReport = { targets: targets.length, core: 0, ratings: 0, failed: 0 };
  for (const target of targets) {
    if (budget.tmdb <= 0 && budget.mdblist <= 0) break;
    try {
      const outcome = await prewarmFiche(rt.meta, rt.svc, target.type, target.tmdbId, rt.horizonMs ?? PREWARM_HORIZON_MS, budget);
      if (outcome.core) report.core += 1;
      if (outcome.ratings) report.ratings += 1;
    } catch (err) {
      report.failed += 1;
      console.warn(`[lt][meta-prewarm] fiche non préchauffée (${err instanceof Error ? err.name : 'inconnue'})`);
    }
  }
  return report;
}
