import { getBandwidthSetting, getVideoLang } from '../data/prefs';
import { fetchStreams, imdbIdOf, planBandwidth, readStoredBandwidth, sortStreams } from '../data/sources';
import type { Lang } from '../data/stream';
import { browserCaps, inShell } from '../player/caps';
import { toSourceViews, withWebPlayback, type SourceView } from './info';
import { recommend, type Recommendation } from './rank';

/* Chargement des sources d'un titre et recommandation selon le débit et la langue préférée. */

export interface SourceRequest {
  type: 'movie' | 'tv';
  /** Identifiant TMDB. */
  id: string;
  name: string;
  season?: number | null;
  episode?: number | null;
  /** Clé de titre : `movie:550` / `tv:1399`. */
  key: string;
  imdb?: string;
}

export interface LoadedSources {
  imdb: string;
  views: SourceView[];
}

/** Récupère les streams de lastAddon pour la demande, triés par score, en fiches détaillées. */
export async function loadSources(req: SourceRequest): Promise<LoadedSources> {
  const imdb = req.imdb ?? (await imdbIdOf(req.type, req.id));
  if (!imdb) throw new Error('no-imdb');
  const streams = sortStreams(await fetchStreams(req.type, imdb, req.season, req.episode));
  return { imdb, views: withWebPlayback(toSourceViews(streams), inShell() ? null : browserCaps()) };
}

const SUPPORTED: readonly Lang[] = ['fr', 'en', 'es', 'de', 'it'];

/** Langue préférée pour l'audio : celle des réglages (français par défaut). */
export function preferredLang(): Lang {
  const l = getVideoLang().lang as Lang;
  return SUPPORTED.includes(l) ? l : 'fr';
}

export function recommendFor(views: readonly SourceView[], bwKbps: number | null): Recommendation | null {
  return recommend(views, bwKbps, preferredLang(), { preferDirect: !inShell() });
}

/** Débit connu sans mesurer (réglage fixe ou mesure récente), sinon null. */
export function knownBandwidthKbps(): number | null {
  const plan = planBandwidth(getBandwidthSetting(), readStoredBandwidth(), Date.now());
  return plan.kind === 'measure' ? null : plan.kbps;
}
