/* Émissions TV : guide des chaînes principales (EPG), émissions TMDB, rapprochement. Tout est mis en cache (le guide 10 min,
 * les identifiants TMDB des émissions suivies d'office 30 jours) pour garder un débit de requêtes raisonnable. */
import { tmdb, tvChannels, tvEpg, type Json, type TvChannel } from './lt';
import { getRegion, getVideoLang } from './prefs';
import {
  SEED_SHOWS, airingsFor, titleKey, titleMatches, type Airing, type EpgProgram, type GuideChannel, type SeedShow,
} from './shows';
import { NATIONAL, langCode3, rankChannels } from './tvRank';

const GUIDE_TTL_MS = 10 * 60 * 1000;
const SEED_TTL_MS = 30 * 24 * 3600 * 1000;
const SEED_KEY = 'laststream.shows.seeds';
const GUIDE_HOURS = 40;
const SLICE_SEC = 8 * 3600;
const MAIN_FALLBACK = 25;

export interface Guide {
  channels: GuideChannel[];
  programs: EpgProgram[];
  channelOf: (p: EpgProgram) => GuideChannel | undefined;
  /** Chaînes du catalogue par identifiant (lecture en direct). */
  catalog: Map<string, TvChannel>;
  at: number;
}

interface LocalCh extends TvChannel { lowRel?: boolean; num?: number | null }

async function fetchCatalog(country: string, language: string): Promise<LocalCh[]> {
  const q = { country, language, page: 1, limit: 500 };
  let res: Json;
  try {
    res = await tvChannels(q);
  } catch (e) {
    if ((e as { status?: number }).status !== 400) throw e;
    res = await tvChannels({ country, page: 1, limit: 500 }); // filtre de langue refusé : liste du pays
  }
  const raw: LocalCh[] = Array.isArray(res) ? res : res?.channels ?? res?.items ?? [];
  return raw.map((c) => ({ ...c, lowRel: c.reliability === 'low' || (c.reliability == null && !!c.flaky) }));
}

/** Chaînes principales : TNT numérotée (ou, pays sans table, les mieux classées), complétées par les numéros absents du catalogue. */
export function mainChannels(catalog: LocalCh[], country: string): GuideChannel[] {
  const ranked = rankChannels(catalog, country);
  const table = NATIONAL[country.toUpperCase()];
  if (!table) {
    return ranked.filter((c) => !c.fast).slice(0, MAIN_FALLBACK).map((c) => ({ epgId: c.id, playId: c.id, name: c.name, logo: c.logo, num: null }));
  }
  const out: GuideChannel[] = ranked.filter((c) => c.num).map((c) => ({ epgId: c.id, playId: c.id, name: c.name, logo: c.logo, num: c.num ?? null }));
  const have = new Set(out.map((c) => c.num));
  table.forEach((e) => { if (!have.has(e.num)) out.push({ epgId: e.epg, playId: null, name: e.label, logo: '', num: e.num }); });
  return out.sort((a, b) => (a.num ?? 99) - (b.num ?? 99));
}

let guideCache: { at: number; p: Promise<Guide> } | null = null;

/** Guide des chaînes principales pour les prochaines 40 h ; un seul chargement partagé, rafraîchi toutes les 10 minutes. */
export function loadGuide(force = false): Promise<Guide> {
  if (!force && guideCache && Date.now() - guideCache.at < GUIDE_TTL_MS) return guideCache.p;
  const p = (async (): Promise<Guide> => {
    const country = getRegion().code;
    const catalog = await fetchCatalog(country, langCode3(getVideoLang().lang));
    const channels = mainChannels(catalog, country);
    const now = Math.floor(Date.now() / 1000);
    const ids = channels.map((c) => c.epgId);
    // Le serveur limite chaque requête de guide à 8 h : la fenêtre est découpée en tranches, les programmes dédoublonnés.
    const jobs: Array<Promise<unknown>> = [];
    for (let t = now - 3600; t < now + GUIDE_HOURS * 3600; t += SLICE_SEC) {
      for (let i = 0; i < ids.length; i += 40) jobs.push(tvEpg(ids.slice(i, i + 40), t, Math.min(t + SLICE_SEC, now + GUIDE_HOURS * 3600)));
    }
    const settled = await Promise.allSettled(jobs);
    const seenProg = new Set<string>();
    const programs: EpgProgram[] = [];
    settled.forEach((r) => {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
      (r.value as EpgProgram[]).forEach((pr) => {
        const k = pr.channelId + '|' + pr.start;
        if (!seenProg.has(k)) { seenProg.add(k); programs.push(pr); }
      });
    });
    const byId = new Map(channels.map((c) => [c.epgId, c]));
    return { channels, programs, channelOf: (pr) => byId.get(pr.channelId), catalog: new Map(catalog.map((c) => [c.id, c])), at: Date.now() };
  })();
  p.catch(() => { if (guideCache && guideCache.p === p) guideCache = null; });
  guideCache = { at: Date.now(), p };
  return p;
}

export function resetShowsCache(): void {
  guideCache = null;
  showsCache = null;
}

// ---- TMDB ----
export interface TmdbShow {
  id: number;
  name: string;
  poster: string;
  backdrop: string;
  overview: string;
  popularity: number;
  firstAir: string;
  /** Identifiants de genres TMDB (`genre_ids` des résultats discover/search) ; `[]` si absents. */
  genres: number[];
}

const toShow = (r: Json): TmdbShow => ({
  id: r.id, name: r.name || r.original_name || '', poster: r.poster_path || '', backdrop: r.backdrop_path || '',
  overview: r.overview || '', popularity: Number(r.popularity) || 0, firstAir: String(r.first_air_date || ''),
  genres: Array.isArray(r.genre_ids) ? r.genre_ids.map(Number) : [],
});

/** Types de programme TMDB (`with_type` de discover/tv) : 1 actualités, 3 téléréalité, 5 talk-shows, 0 documentaires. */
const SHOW_TYPES = '1|3|5|0';
/** Genres TMDB des émissions classées autrement (téléréalité, talk-show, actualités) : une requête complémentaire. */
const SHOW_GENRES = '10764|10767|10763';
/** Pages de la source par type au premier chargement (20 titres par page), puis MORE_PAGES pages à chaque « Voir plus ». */
const FIRST_PAGES = 3;
const MORE_PAGES = 2;

/** Pagination de la source par type : page suivante à charger et nombre de pages annoncé par TMDB. */
export interface DiscoverCursor { next: number; totalPages: number }

const typeQuery = (country: string, page: number): Promise<Json> => tmdb('discover/tv', {
  with_type: SHOW_TYPES, with_origin_country: country, sort_by: 'popularity.desc', page: String(page),
});

/** Titres d'une réponse discover, sans affiche (exclus) ni doublon (`seen`, complété au passage). */
function takeNew(results: Json[], seen: Set<number>): TmdbShow[] {
  const out: TmdbShow[] = [];
  results.forEach((x) => {
    if (!x.poster_path || seen.has(x.id)) return;
    seen.add(x.id);
    out.push(toShow(x));
  });
  return out;
}

/**
 * Émissions TMDB du pays (région réglée, France par défaut) : les premières pages de la source par type (actualités,
 * téléréalité, talk-shows, documentaires, par popularité) et une requête par genres. `cursor` indique la page suivante.
 */
export async function discoverShows(): Promise<{ shows: TmdbShow[]; cursor: DiscoverCursor }> {
  const country = getRegion().code;
  const pages = Array.from({ length: FIRST_PAGES }, (_, i) => typeQuery(country, i + 1));
  const genres = tmdb('discover/tv', { with_genres: SHOW_GENRES, with_origin_country: country, sort_by: 'popularity.desc', page: '1' });
  const settled = await Promise.allSettled([...pages, genres]);
  const seen = new Set<number>();
  const shows: TmdbShow[] = [];
  let totalPages = 0;
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    if (i < FIRST_PAGES) totalPages = Math.max(totalPages, Number(r.value?.total_pages) || 0);
    shows.push(...takeNew(r.value?.results ?? [], seen));
  });
  return { shows, cursor: { next: FIRST_PAGES + 1, totalPages } };
}

type SeedCache = Record<string, { at: number; show: TmdbShow | null }>;
const readSeeds = (): SeedCache => { try { return JSON.parse(globalThis.localStorage?.getItem(SEED_KEY) || '{}') as SeedCache; } catch { return {}; } };
const writeSeeds = (c: SeedCache): void => { try { globalThis.localStorage?.setItem(SEED_KEY, JSON.stringify(c)); } catch { /* stockage indisponible */ } };

/** Émission TMDB d'un titre (recherche), mémorisée 30 jours ; préfère une émission du pays. */
export async function resolveSeed(seed: SeedShow): Promise<TmdbShow | null> {
  const cache = readSeeds();
  const hit = cache[seed.name];
  if (hit && Date.now() - hit.at < SEED_TTL_MS) return hit.show;
  const j = await tmdb('search/tv', { query: seed.name.replace(/\s*[:!?]+\s*$/, '') });
  const key = titleKey(seed.name);
  const region = getRegion().code;
  const results: Json[] = (j?.results ?? []).filter((r: Json) => r.poster_path);
  const named = results.filter((r) => titleMatches(r.name || '', seed.name, seed.aliases) || titleKey(r.name).startsWith(key));
  const pool = named.length ? named : results;
  const best = pool.find((r) => Array.isArray(r.origin_country) && r.origin_country.includes(region)) ?? pool[0];
  const show = best ? toShow(best) : null;
  cache[seed.name] = { at: Date.now(), show };
  writeSeeds(cache);
  return show;
}

export interface ShowEpisode {
  season: number;
  episode: number;
  name: string;
  date: string;
  still: string;
  /** Durée en minutes (0 si inconnue). */
  runtime: number;
  overview: string;
}
/** Membre de la distribution (la première place du casting d'une émission est souvent son présentateur). */
export interface ShowCast { id: number; name: string; role: string; photo: string }
export interface ShowDetail {
  id: number;
  name: string;
  overview: string;
  poster: string;
  backdrop: string;
  status: string;
  networks: string[];
  /** Noms des genres TMDB, dans la langue de la requête. */
  genres: string[];
  /** Huit premiers acteurs au plus (`credits`) ; `photo` est le chemin TMDB, à passer à IMG. */
  cast: ShowCast[];
  next: ShowEpisode | null;
  last: ShowEpisode | null;
  seasons: Array<{ number: number; air: string; count: number }>;
}
const ep = (e: Json, season: number = e?.season_number): ShowEpisode | null => (e
  ? { season, episode: e.episode_number, name: e.name || '', date: String(e.air_date || ''), still: e.still_path || '', runtime: Number(e.runtime) || 0, overview: e.overview || '' }
  : null);

export async function showDetail(id: number | string): Promise<ShowDetail> {
  const d = await tmdb('tv/' + id, { append_to_response: 'credits' });
  return {
    id: Number(id), name: d.name || '', overview: d.overview || '', poster: d.poster_path || '', backdrop: d.backdrop_path || '', status: d.status || '',
    networks: (d.networks ?? []).map((n: Json) => n.name).filter(Boolean),
    genres: (d.genres ?? []).map((g: Json) => g.name).filter(Boolean),
    cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map((p: Json): ShowCast => ({ id: p.id, name: p.name || '', role: p.character || '', photo: p.profile_path || '' })),
    next: ep(d.next_episode_to_air), last: ep(d.last_episode_to_air),
    seasons: (d.seasons ?? []).filter((s: Json) => s.season_number > 0).map((s: Json) => ({ number: s.season_number, air: s.air_date || '', count: s.episode_count || 0 })),
  };
}

/** Derniers épisodes diffusés (du plus récent au plus ancien) d'après la dernière saison commencée. */
export async function pastEpisodes(detail: ShowDetail, today: string, max = 12): Promise<ShowEpisode[]> {
  const started = detail.seasons.filter((s) => s.air && s.air <= today).sort((a, b) => b.number - a.number);
  const out: ShowEpisode[] = [];
  for (const s of started.slice(0, 2)) {
    try {
      const j = await tmdb('tv/' + detail.id + '/season/' + s.number);
      (j?.episodes ?? []).forEach((e: Json) => { const x = ep(e, s.number); if (x && x.date && x.date <= today) out.push(x); });
    } catch { /* saison indisponible */ }
    if (out.length >= max) break;
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.episode - a.episode).slice(0, max);
}

// ---- Liste des émissions du moment ----
export interface ShowEntry extends TmdbShow {
  aliases: string[];
  airings: Airing[];
  /** Plateforme connue pour une émission de streaming. */
  platform: string;
  /** Prochain épisode annoncé par TMDB (émissions sans diffusion au guide). */
  next: ShowEpisode | null;
}

/** Liste des émissions du moment, avec le guide et la pagination de la source par type (« Voir plus »). */
export interface ShowsData {
  shows: ShowEntry[];
  guide: Guide;
  cursor: DiscoverCursor;
  /** Une page suivante de la source par type peut-elle être chargée ? */
  hasMore: boolean;
}

/** Rang d'affichage : en direct, puis diffusions à venir, puis prochain épisode TMDB, puis le reste par popularité. */
const rankShow = (s: ShowEntry, now: number, today: string): number => {
  const live = s.airings.find((a) => a.start <= now && now < a.stop);
  if (live) return 0;
  if (s.airings.length) return s.airings[0].start - now + 1;
  if (s.next && s.next.date >= today) return 1e9 + Date.parse(s.next.date) / 1000;
  return 2e9 - s.popularity;
};
const sortShows = (shows: ShowEntry[], now: number): void => {
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  shows.sort((a, b) => rankShow(a, now, today) - rankShow(b, now, today) || b.popularity - a.popularity);
};

let showsCache: { at: number; p: Promise<ShowsData> } | null = null;

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const k = i; i += 1;
      try { out[k] = { status: 'fulfilled', value: await fn(items[k]) }; } catch (reason) { out[k] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Émissions du moment : émissions TMDB populaires + liste d'émissions suivies d'office, chacune avec ses prochaines
 * diffusions trouvées au guide ; les émissions de streaming reçoivent leur prochain épisode TMDB.
 */
export function loadShows(force = false): Promise<ShowsData> {
  if (!force && showsCache && Date.now() - showsCache.at < GUIDE_TTL_MS) return showsCache.p;
  const p = (async (): Promise<ShowsData> => {
    const [guideR, discR] = await Promise.allSettled([loadGuide(force), discoverShows()]);
    const guide: Guide = guideR.status === 'fulfilled' ? guideR.value : { channels: [], programs: [], channelOf: () => undefined, catalog: new Map(), at: Date.now() };
    const disc = discR.status === 'fulfilled' ? discR.value : { shows: [] as TmdbShow[], cursor: { next: 1, totalPages: 0 } };
    const discovered = disc.shows;
    const now = Math.floor(Date.now() / 1000);
    const byId = new Map<number, ShowEntry>();
    const add = (s: TmdbShow, aliases: string[], platform = ''): ShowEntry => {
      const cur = byId.get(s.id);
      if (cur) { cur.aliases = [...new Set([...cur.aliases, ...aliases])]; cur.platform = cur.platform || platform; return cur; }
      const e: ShowEntry = { ...s, aliases, airings: [], platform, next: null };
      byId.set(s.id, e);
      return e;
    };
    discovered.forEach((s) => add(s, []));
    // Émissions suivies d'office : rapprochées d'une émission déjà connue, sinon cherchées sur TMDB (toujours ; résultat mis en cache 30 jours).
    const pending: SeedShow[] = [];
    SEED_SHOWS.forEach((seed) => {
      const known = [...byId.values()].find((e) => titleMatches(e.name, seed.name, seed.aliases));
      if (known) { add(known, [seed.name, ...(seed.aliases ?? [])], seed.streaming ?? ''); return; }
      pending.push(seed);
    });
    const resolved = await mapLimit(pending, 4, resolveSeed);
    resolved.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) add(r.value, [pending[i].name, ...(pending[i].aliases ?? [])], pending[i].streaming ?? '');
    });
    const shows = [...byId.values()];
    shows.forEach((s) => { s.airings = airingsFor({ name: s.name, aliases: s.aliases }, guide.programs, guide.channelOf, now); });
    // Sans diffusion au guide : prochain épisode TMDB (émissions de streaming), pour les plus populaires seulement.
    const streaming = shows.filter((s) => !s.airings.length).sort((a, b) => Number(!!b.platform) - Number(!!a.platform) || b.popularity - a.popularity).slice(0, 8);
    const details = await mapLimit(streaming, 4, (s) => showDetail(s.id));
    details.forEach((r, i) => { if (r.status === 'fulfilled') streaming[i].next = r.value.next; });
    sortShows(shows, now);
    return { shows, guide, cursor: disc.cursor, hasMore: disc.cursor.next <= disc.cursor.totalPages };
  })();
  p.catch(() => { if (showsCache && showsCache.p === p) showsCache = null; });
  showsCache = { at: Date.now(), p };
  return p;
}

/** Résultat de « Voir plus » : émissions ajoutées à la liste (ordre de popularité TMDB) et page suivante disponible. */
export interface MoreShows { added: ShowEntry[]; hasMore: boolean }

let moreP: Promise<MoreShows> | null = null;

/**
 * « Voir plus » : charge les deux pages suivantes de la source par type, les ajoute à la liste en cours (sans doublon,
 * puis triée comme le reste) et renvoie les nouvelles entrées. Un seul chargement à la fois. `hasMore` est faux quand TMDB
 * n'annonce plus de page. En cas d'échec, rien n'est ajouté et la même page sera retentée au prochain appel.
 */
export function loadMoreShows(): Promise<MoreShows> {
  if (moreP) return moreP;
  const p = (async (): Promise<MoreShows> => {
    // Liste en cours, même si son cache a expiré pendant l'affichage : la pagination reprend là où elle s'est arrêtée.
    const data = await (showsCache ? showsCache.p : loadShows());
    const { cursor, guide } = data;
    const count = Math.min(MORE_PAGES, cursor.totalPages - cursor.next + 1);
    if (count <= 0) { data.hasMore = false; return { added: [], hasMore: false }; }
    const country = getRegion().code;
    const settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => typeQuery(country, cursor.next + i)));
    // Pages prises dans l'ordre, jusqu'à la première en échec.
    const seen = new Set(data.shows.map((s) => s.id));
    const fresh: TmdbShow[] = [];
    let done = 0;
    for (const r of settled) {
      if (r.status !== 'fulfilled') break;
      done += 1;
      fresh.push(...takeNew(r.value?.results ?? [], seen));
    }
    if (!done) throw (settled[0] as PromiseRejectedResult).reason;
    const now = Math.floor(Date.now() / 1000);
    const added: ShowEntry[] = fresh.map((s) => ({
      ...s, aliases: [], airings: airingsFor({ name: s.name }, guide.programs, guide.channelOf, now), platform: '', next: null,
    }));
    cursor.next += done;
    data.shows.push(...added);
    sortShows(data.shows, now);
    data.hasMore = cursor.next <= cursor.totalPages;
    return { added, hasMore: data.hasMore };
  })();
  moreP = p;
  const clear = (): void => { if (moreP === p) moreP = null; };
  p.then(clear, clear);
  return p;
}

// ---- Calendrier ----
export interface AiringEvent {
  date: string;
  kind: 'airing';
  key: string;
  title: string;
  poster: string;
  /** « 20:10 · TF1 ». */
  label: string;
  start: number;
  channelId: string | null;
  showId: number;
}

export function followedAirings(
  follows: ReadonlyArray<{ type: string; id: number; title: string; poster?: string }>,
  guide: Guide,
  localDate: (s: number) => string,
  hhmm: (s: number) => string,
  now: number,
): AiringEvent[] {
  const out: AiringEvent[] = [];
  follows.filter((f) => f.type === 'tv' && f.title).forEach((f) => {
    airingsFor({ name: f.title }, guide.programs, guide.channelOf, now).forEach((a) => {
      out.push({
        date: localDate(a.start), kind: 'airing', key: 'tv:' + f.id, title: f.title, poster: f.poster ?? '', start: a.start, showId: f.id, channelId: a.channel.playId,
        label: hhmm(a.start) + ' · ' + a.channel.name,
      });
    });
  });
  return out;
}
