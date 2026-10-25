import { isRecord } from '../sources/http.js';
import { LtError, type LtContext, ltRequest, recordAt, TTL } from './context.js';
import { type SeriesEpisode, type SeriesServices, seriesEpisodes } from './episodes.js';
import { armEntries, type ArmEntry } from './skip.js';

/** Nature d'un épisode hors trame principale : filler (épisode bouche-trou) ou récap (résumé des épisodes précédents). */
type FillerKind = 'filler' | 'recap';

export interface FillerEpisode {
  season: number;
  episode: number;
  kind: FillerKind;
}

export interface FillersResponse {
  fillers: FillerEpisode[];
}

/** Résultat interne : `degraded` (un service en panne, liste peut-être incomplète) n'est jamais renvoyé au client. */
export interface FillersResult extends FillersResponse {
  degraded: boolean;
}

/** Numéros d'épisodes MAL marqués filler ou récap par Jikan. */
interface MalFillers {
  filler: number[];
  recap: number[];
}

const JIKAN_BASE = 'https://api.jikan.moe/v4';
/** Pages Jikan lues au plus (100 épisodes par page) : couvre les séries les plus longues sans boucle infinie. */
const MAX_PAGES = 20;
const IMDB_PREFIX = /^(tt\d{5,12}):/;

/**
 * Débit Jikan (3 requêtes/s, 60/min) : pause entre deux pages, puis un seul nouvel essai sur 429 après Retry-After
 * (1 s sans en-tête, 3 s au plus). Modifiable par les tests pour ne pas attendre en temps réel.
 */
export const jikanTiming = { pageGapMs: 400, retryDefaultMs: 1000, retryMaxMs: 3000 };

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Attente avant le nouvel essai d'un 429 : Retry-After en secondes, sinon le délai par défaut, plafonnée. */
function retryDelay(headers: Headers): number {
  const seconds = Number(headers.get('retry-after'));
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : jikanTiming.retryDefaultMs;
  return Math.min(ms, jikanTiming.retryMaxMs);
}

/** Page Jikan en JSON ; un 429 est retenté une fois. Autre statut non 2xx ou JSON invalide : LtError. */
async function jikanPage(ctx: LtContext, url: string): Promise<unknown> {
  let res = await ltRequest(ctx, url);
  if (res.status === 429) {
    await pause(retryDelay(res.headers));
    res = await ltRequest(ctx, url);
  }
  if (!res.ok) throw new LtError(502, `upstream_${res.status}`);
  try {
    return JSON.parse(Buffer.from(res.bytes).toString('utf8')) as unknown;
  } catch {
    throw new LtError(502, 'upstream_bad_json');
  }
}

/** Épisodes filler et récap d'une fiche MAL (Jikan v4, pages lues à la suite). Cache KV 7 jours, 6 h si aucun. */
async function malFillers(ctx: LtContext, malId: number): Promise<MalFillers> {
  return ctx.state.cache.get<MalFillers>(
    `jikan:fillers:${malId}`,
    (value) => (value.filler.length + value.recap.length > 0 ? TTL.fillers : TTL.fillersEmpty),
    async () => {
      const result: MalFillers = { filler: [], recap: [] };
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) await pause(jikanTiming.pageGapMs);
        const json = await jikanPage(ctx, `${JIKAN_BASE}/anime/${malId}/episodes?page=${page}`);
        const data = isRecord(json) && Array.isArray(json.data) ? json.data.filter(isRecord) : [];
        for (const entry of data) {
          const n = num(entry.mal_id);
          if (n === undefined) continue;
          // Un épisode à la fois récap et filler compte comme récap.
          if (entry.recap === true) result.recap.push(n);
          else if (entry.filler === true) result.filler.push(n);
        }
        if (recordAt(json, 'pagination').has_next_page !== true) break;
      }
      return result;
    },
    { provider: 'jikan' },
  );
}

/** Identifiant IMDb de la série, déduit du préfixe de l'identifiant de flux d'un épisode. */
function imdbOf(episodes: readonly SeriesEpisode[]): string | undefined {
  for (const e of episodes) {
    const match = e.streamId === undefined ? null : IMDB_PREFIX.exec(e.streamId);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Fiche MAL et recherche de l'épisode canonique correspondant à un numéro d'épisode MAL. */
interface MalTarget {
  mal: number;
  find: (n: number) => SeriesEpisode | undefined;
}

/**
 * Fiches MAL à lire : une fiche unique sans saison (séries longues, numéro absolu), sinon une par saison TMDB (numéro
 * d'épisode TMDB). Une saison TMDB couverte par plusieurs fiches (anime en deux cours) est ignorée : la numérotation
 * MAL de chaque cours repart de 1 et ne se rattache pas sans ambiguïté aux épisodes TMDB.
 */
function malTargets(entries: readonly ArmEntry[], episodes: readonly SeriesEpisode[]): MalTarget[] {
  const withMal = entries.filter((entry) => entry.mal !== undefined);
  const single = withMal.length === 1 && withMal[0]?.tmdbSeason === undefined ? withMal[0] : undefined;
  if (single?.mal !== undefined) return [{ mal: single.mal, find: (n) => episodes.find((e) => e.absolute === n) }];
  const perSeason = new Map<number, number>();
  for (const entry of withMal) {
    if (entry.tmdbSeason !== undefined) perSeason.set(entry.tmdbSeason, (perSeason.get(entry.tmdbSeason) ?? 0) + 1);
  }
  return withMal.flatMap((entry): MalTarget[] => {
    const season = entry.tmdbSeason;
    if (entry.mal === undefined || season === undefined || perSeason.get(season) !== 1) return [];
    return [{ mal: entry.mal, find: (n) => episodes.find((e) => e.tmdbSeason === season && e.tmdbEpisode === n) }];
  });
}

/**
 * Épisodes filler et récap d'une série, dans la numérotation canonique de /series/:tmdbId/episodes. Correspondance
 * IMDb → MAL par ARM. Série inconnue de MAL : liste vide. Panne d'ARM ou d'une fiche Jikan : les autres fiches sont
 * gardées et le résultat est marqué `degraded`.
 */
export async function seriesFillers(
  ctx: LtContext,
  svc: SeriesServices,
  tmdbId: string,
  language: string | undefined,
): Promise<FillersResult> {
  const structure = await seriesEpisodes(ctx, svc, tmdbId, language);
  const imdbId = imdbOf(structure.episodes);
  if (imdbId === undefined) return { fillers: [], degraded: false };
  let entries: ArmEntry[];
  try {
    entries = await armEntries(ctx, imdbId);
  } catch (err) {
    console.warn(`[lt][fillers] ARM indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
    return { fillers: [], degraded: true };
  }
  const fillers: FillerEpisode[] = [];
  let degraded = false;
  for (const target of malTargets(entries, structure.episodes)) {
    let marks: MalFillers;
    try {
      marks = await malFillers(ctx, target.mal);
    } catch (err) {
      console.warn(`[lt][fillers] Jikan indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
      degraded = true;
      continue;
    }
    for (const [kind, list] of [['recap', marks.recap], ['filler', marks.filler]] as const) {
      for (const n of list) {
        const hit = target.find(n);
        if (hit !== undefined) fillers.push({ season: hit.season, episode: hit.episode, kind });
      }
    }
  }
  fillers.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { fillers, degraded };
}
