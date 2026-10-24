import { isRecord } from '../sources/http.js';
import { getJson, LtError, type LtContext, recordAt, TTL } from './context.js';
import { type SeriesEpisode, type SeriesServices, seriesEpisodes } from './episodes.js';
import { armEntries } from './skip.js';

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

/** Numéros d'épisodes MAL marqués filler ou récap par Jikan. */
interface MalFillers {
  filler: number[];
  recap: number[];
}

const JIKAN_BASE = 'https://api.jikan.moe/v4';
/** Pages Jikan lues au plus (100 épisodes par page) : couvre les séries les plus longues sans boucle infinie. */
const MAX_PAGES = 20;
const IMDB_PREFIX = /^(tt\d{5,12}):/;

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

/** Épisodes filler et récap d'une fiche MAL (Jikan v4, pages lues à la suite). Cache 7 jours, 6 h si aucun. */
async function malFillers(ctx: LtContext, malId: number): Promise<MalFillers> {
  return ctx.state.cache.get<MalFillers>(
    `jikan:fillers:${malId}`,
    (value) => (value.filler.length + value.recap.length > 0 ? TTL.fillers : TTL.fillersEmpty),
    async () => {
      const result: MalFillers = { filler: [], recap: [] };
      for (let page = 1; page <= MAX_PAGES; page++) {
        const json = await getJson(ctx, `${JIKAN_BASE}/anime/${malId}/episodes?page=${page}`);
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

/**
 * Épisodes filler et récap d'une série, dans la numérotation canonique de /series/:tmdbId/episodes. Correspondance
 * IMDb → MAL par ARM : une fiche MAL par saison TMDB (numéro d'épisode TMDB), ou une fiche unique pour toute la série
 * (numéro absolu, séries longues). Série inconnue de MAL ou panne d'un service : liste vide.
 */
export async function seriesFillers(
  ctx: LtContext,
  svc: SeriesServices,
  tmdbId: string,
  language: string | undefined,
): Promise<FillersResponse> {
  const structure = await seriesEpisodes(ctx, svc, tmdbId, language);
  const imdbId = imdbOf(structure.episodes);
  if (imdbId === undefined) return { fillers: [] };
  try {
    const entries = (await armEntries(ctx, imdbId)).filter((entry) => entry.mal !== undefined);
    const fillers: FillerEpisode[] = [];
    const mark = (marks: MalFillers, find: (n: number) => SeriesEpisode | undefined): void => {
      for (const [kind, list] of [['recap', marks.recap], ['filler', marks.filler]] as const) {
        for (const n of list) {
          const hit = find(n);
          if (hit !== undefined) fillers.push({ season: hit.season, episode: hit.episode, kind });
        }
      }
    };
    const single = entries.length === 1 && entries[0]?.tmdbSeason === undefined ? entries[0] : undefined;
    if (single?.mal !== undefined) {
      const marks = await malFillers(ctx, single.mal);
      mark(marks, (n) => structure.episodes.find((e) => e.absolute === n));
    } else {
      for (const entry of entries) {
        if (entry.mal === undefined || entry.tmdbSeason === undefined) continue;
        const marks = await malFillers(ctx, entry.mal);
        mark(marks, (n) => structure.episodes.find((e) => e.tmdbSeason === entry.tmdbSeason && e.tmdbEpisode === n));
      }
    }
    fillers.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { fillers };
  } catch (err) {
    console.warn(`[lt][fillers] indisponible (statut amont : ${err instanceof LtError ? err.code : 'inconnu'})`);
    return { fillers: [] };
  }
}
