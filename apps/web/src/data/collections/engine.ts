/*
 * Moteur de collections : exécute les sources TMDB d'un dossier (catalogue inspiré de Focale, MIT, voir
 * LICENSE-FOCALE.txt) via le proxy lastAddon (`tmdb()`), fusionne, dédoublonne et applique les filtres de l'accueil.
 *
 * Sources gérées : DISCOVER -> discover/{movie|tv}, COMPANY -> discover avec with_companies, COLLECTION -> collection/{id},
 * LIST -> list/{id}. Les sources Trakt et addon n'existent pas ici (retirées à l'import, ignorées si elles reviennent).
 *
 * Une « page » de la grille d'un dossier = un lot d'au plus CONCURRENCY sources (page de TMDB `round`), fusionné en
 * alternant les sources pour qu'aucune ne domine. Les lots défilent source par source, puis page TMDB par page TMDB.
 */
import { isKidProfile } from '../auth';
import { keepVisible } from '../homeFilters';
import { kidGenreOk } from '../kid';
import { tmdb } from '../lt';
import type { Params } from '../lt';
import { getRegion } from '../prefs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Media = 'movie' | 'tv';
export type SourceKind = 'DISCOVER' | 'LIST' | 'COLLECTION' | 'COMPANY';
export type SortKey = 'default' | 'popularity' | 'rating' | 'recent';

/** Filtres d'une source, avec les noms du catalogue d'origine. */
export interface SourceFilters {
  voteCountGte?: number;
  voteAverageGte?: number;
  withOriginalLanguage?: string;
  withGenres?: string;
  withoutGenres?: string;
  withKeywords?: string;
  withoutKeywords?: string;
  watchRegion?: string;
  withWatchProviders?: string;
  withOriginCountry?: string;
  releaseDateGte?: string;
  releaseDateLte?: string;
  withNetworks?: string;
  withCompanies?: string;
  year?: number | string;
}

export interface Source {
  kind: SourceKind;
  media: Media;
  name?: string;
  sort?: string;
  /** Identifiant TMDB : liste, collection ou société. */
  id?: number;
  filters?: SourceFilters;
}

export interface Folder {
  id: string;
  title: string;
  cover?: string;
  gif?: string;
  logo?: string;
  hero?: string;
  hidden?: boolean;
  sources: Source[];
}

/** Titre TMDB brut, avec son type garanti. */
export type RawTitle = Record<string, any> & { media_type: Media; id: number };

export const CONCURRENCY = 3;
/** Nombre maximal de tours (pages TMDB) par source : 25 pages, soit 500 titres. */
export const MAX_ROUNDS = 25;
const WATCH_TYPES = 'flatrate|free|ads';
const MIN_VOTES_BY_RATING: Record<Media, number> = { movie: 200, tv: 100 };

const pad = (n: number) => String(n).padStart(2, '0');
export const todayIso = (d: Date = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateKey = (media: Media): string => (media === 'tv' ? 'first_air_date' : 'primary_release_date');

/** Filtres d'une source -> paramètres discover de TMDB. Les titres non sortis sont exclus (borne haute = aujourd'hui). */
export function mapFilters(f: SourceFilters = {}, media: Media, region: string, today: string = todayIso()): Record<string, string> {
  const tv = media === 'tv';
  const p: Record<string, string> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') p[key] = String(value);
  };
  set('vote_count.gte', f.voteCountGte);
  set('vote_average.gte', f.voteAverageGte);
  set('with_original_language', f.withOriginalLanguage);
  set('with_genres', f.withGenres);
  set('without_genres', f.withoutGenres);
  set('with_keywords', f.withKeywords);
  set('without_keywords', f.withoutKeywords);
  set('with_origin_country', f.withOriginCountry);
  set('with_companies', f.withCompanies);
  if (tv) set('with_networks', f.withNetworks); // les réseaux n'existent que pour les séries
  set(`${dateKey(media)}.gte`, f.releaseDateGte);
  const lte = f.releaseDateLte && f.releaseDateLte < today ? f.releaseDateLte : today;
  set(`${dateKey(media)}.lte`, lte);
  set(tv ? 'first_air_date_year' : 'primary_release_year', f.year);
  // La région de l'utilisateur remplace celle du catalogue d'origine (le catalogue vise la France ou le Canada).
  if (f.withWatchProviders || f.watchRegion) set('watch_region', region);
  if (f.withWatchProviders) {
    set('with_watch_providers', f.withWatchProviders);
    set('with_watch_monetization_types', WATCH_TYPES);
  }
  return p;
}

/** Tri TMDB d'une source ; les valeurs propres au catalogue (original, rank…) donnent la popularité. */
export function sourceSort(sort: string | undefined, media: Media): string {
  const m = /^(popularity|vote_average|vote_count|revenue|primary_release_date|first_air_date)\.(asc|desc)$/.exec(sort ?? '');
  if (m) return /date$/.test(m[1]) ? `${dateKey(media)}.${m[2]}` : sort!;
  if (sort === 'released') return `${dateKey(media)}.desc`;
  return 'popularity.desc';
}

const sortOverride = (sort: SortKey, media: Media): string | null =>
  sort === 'popularity' ? 'popularity.desc' : sort === 'rating' ? 'vote_average.desc' : sort === 'recent' ? `${dateKey(media)}.desc` : null;

export interface TmdbRequest {
  path: string;
  params: Params;
  kind: SourceKind;
}

export interface RequestOpts {
  region?: string;
  today?: string;
  sort?: SortKey;
}

/** Requête TMDB d'une source pour une page ; null si la source est inutilisable ou n'a pas de page à ce rang. */
export function buildRequest(src: Source, page: number, o: RequestOpts = {}): TmdbRequest | null {
  const region = o.region ?? getRegion().code;
  const today = o.today ?? todayIso();
  const sort = o.sort ?? 'default';
  if (src.kind === 'COLLECTION') {
    return src.id && page === 1 ? { path: `collection/${src.id}`, params: {}, kind: 'COLLECTION' } : null;
  }
  if (src.kind === 'LIST') return src.id ? { path: `list/${src.id}`, params: { page: String(page) }, kind: 'LIST' } : null;
  if (src.kind !== 'DISCOVER' && src.kind !== 'COMPANY') return null; // sources Trakt / addon : ignorées
  if (src.kind === 'COMPANY' && !src.id) return null;
  const filters: SourceFilters = src.kind === 'COMPANY' ? { ...src.filters, withCompanies: String(src.id) } : { ...src.filters };
  const params: Record<string, string> = { ...mapFilters(filters, src.media, region, today) };
  const over = sortOverride(sort, src.media);
  params.sort_by = over ?? sourceSort(src.sort, src.media);
  if (params.sort_by.startsWith('vote_average') && !params['vote_count.gte']) params['vote_count.gte'] = String(MIN_VOTES_BY_RATING[src.media]);
  params.include_adult = 'false';
  params.page = String(page);
  return { path: `discover/${src.media}`, params, kind: src.kind };
}

// ---- Résolution ----

/** Contexte d'une grille : titres déjà montrés, sources épuisées, tri et type demandés. */
export interface ResolveCtx {
  sort: SortKey;
  media: Media | 'all';
  seen: Set<string>;
  exhausted: Set<string>;
  /** Estimation du nombre de titres (somme des totaux TMDB de la première page de chaque source). */
  total: number;
  counted: Set<string>;
}

export function newCtx(o: { sort?: SortKey; media?: Media | 'all' } = {}): ResolveCtx {
  return { sort: o.sort ?? 'default', media: o.media ?? 'all', seen: new Set(), exhausted: new Set(), total: 0, counted: new Set() };
}

/** Titre réduit à ce que lisent les filtres de l'accueil. */
export interface LightTitle {
  r: RawTitle;
  type: Media;
  id: number;
  key: string;
  genreIds: number[];
}

export interface ResolveOpts {
  region?: string;
  today?: string;
  /** Filtre « accueil » (vus, masqués, genres bannis). Par défaut keepVisible. */
  visible?: (items: LightTitle[]) => LightTitle[];
  kid?: boolean;
  concurrency?: number;
}

export interface Resolved {
  items: RawTitle[];
  /** Plus rien à charger après cette page. */
  done: boolean;
}

/** Les listes TMDB (route list/{id}) ne sont pas ouvertes sur certains serveurs : on le retient pour la session. */
let listBroken = false;
export const resetListSupport = (): void => { listBroken = false; };
export const listUnsupported = (): boolean => listBroken;

const sourceKey = (folderId: string, i: number) => `${folderId}#${i}`;

/** Sources utilisables d'un dossier. Sans route list/, les listes sont ignorées, ou remplacées par un discover si le dossier n'a rien d'autre. */
export function usableSources(folder: Folder, media: Media | 'all' = 'all', brokenLists: boolean = listBroken): Source[] {
  let src = folder.sources.filter((s) => (s.kind === 'DISCOVER' || s.kind === 'LIST' || s.kind === 'COLLECTION' || s.kind === 'COMPANY') && (media === 'all' || s.media === media));
  if (brokenLists) {
    const rest = src.filter((s) => s.kind !== 'LIST');
    if (rest.length) src = rest;
    else {
      const seenMedia = new Set<Media>();
      src = src.filter((s) => (seenMedia.has(s.media) ? false : (seenMedia.add(s.media), true)))
        .map((s) => ({ kind: 'DISCOVER' as const, media: s.media, name: s.name, sort: s.sort, filters: { voteCountGte: s.media === 'tv' ? 200 : 500 } }));
    }
  }
  return src;
}

const isoDate = (r: Record<string, any>) => String(r.release_date || r.first_air_date || '').slice(0, 10);

function asTitles(json: any, src: Source): RawTitle[] {
  const list: any[] = Array.isArray(json?.results) ? json.results : Array.isArray(json?.items) ? json.items : Array.isArray(json?.parts) ? json.parts : [];
  const out: RawTitle[] = [];
  for (const r of list) {
    if (!r || typeof r.id !== 'number') continue;
    const mt = r.media_type === 'tv' || r.media_type === 'movie' ? r.media_type : src.media;
    if (src.kind === 'LIST' && r.media_type && r.media_type !== src.media) continue; // une liste mêle films et séries : on garde le type demandé
    out.push({ ...r, media_type: mt } as RawTitle);
  }
  return out;
}

const keyOf = (r: RawTitle) => `${r.media_type}:${r.id}`;

/** Alterne les listes : 1er de chacune, puis 2e de chacune… */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i += 1) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

export function sortTitles(items: RawTitle[], sort: SortKey): RawTitle[] {
  if (sort === 'default') return items;
  const by: Record<Exclude<SortKey, 'default'>, (r: RawTitle) => number | string> = {
    popularity: (r) => r.popularity ?? 0,
    rating: (r) => r.vote_average ?? 0,
    recent: (r) => isoDate(r),
  };
  const f = by[sort];
  return items.slice().sort((a, b) => (f(a) < f(b) ? 1 : f(a) > f(b) ? -1 : 0));
}

/** Une page de la grille d'un dossier (voir l'en-tête). `page` commence à 1. */
export async function resolveFolder(folder: Folder, page: number, ctx: ResolveCtx = newCtx(), opts: ResolveOpts = {}): Promise<Resolved> {
  const region = opts.region ?? getRegion().code;
  const today = opts.today ?? todayIso();
  const visible = opts.visible ?? keepVisible;
  const kid = opts.kid ?? isKidProfile();
  const k = opts.concurrency ?? CONCURRENCY;
  const wasBroken = listBroken;
  const sources = usableSources(folder, ctx.media);
  const n = sources.length;
  if (!n) return { items: [], done: true };
  const perRound = Math.ceil(n / k);
  const round = Math.floor((page - 1) / perRound) + 1;
  const chunk = (page - 1) % perRound;
  if (round > MAX_ROUNDS) return { items: [], done: true };

  const picked = sources.map((s, i) => ({ s, i })).slice(chunk * k, chunk * k + k);
  const lists = await Promise.all(picked.map(async ({ s, i }) => {
    const key = sourceKey(folder.id, i);
    if (ctx.exhausted.has(key)) return [] as RawTitle[];
    const req = buildRequest(s, round, { region, today, sort: ctx.sort });
    if (!req) { ctx.exhausted.add(key); return []; }
    try {
      const json: any = await tmdb(req.path, req.params);
      const totalPages = Number(json?.total_pages);
      const found = asTitles(json, s);
      if (req.kind === 'COLLECTION' || (Number.isFinite(totalPages) && round >= totalPages) || !found.length) ctx.exhausted.add(key);
      if (!ctx.counted.has(key)) {
        ctx.counted.add(key);
        const t = Number(json?.total_results ?? json?.item_count ?? found.length);
        ctx.total += Number.isFinite(t) ? t : found.length;
      }
      return found;
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (req.kind === 'LIST' && (status === 404 || status === 403 || status === 400)) listBroken = true; // route list/ fermée : repli
      return [];
    }
  }));

  if (listBroken && !wasBroken) return resolveFolder(folder, page, ctx, opts); // repli : on relance avec les sources de remplacement

  const merged = interleave(lists).filter((r) => {
    const key = keyOf(r);
    if (ctx.seen.has(key) || !r.poster_path || r.adult) return false;
    const d = isoDate(r);
    if (!d || d > today) return false; // titre non sorti ou sans date
    return true;
  });
  const light = merged.map((r) => ({ r, type: r.media_type, id: r.id, key: keyOf(r), genreIds: (r.genre_ids ?? []) as number[] }));
  let kept = visible(light);
  if (kid) kept = kept.filter((x) => kidGenreOk(x.genreIds));
  const items: RawTitle[] = [];
  for (const x of kept) {
    if (ctx.seen.has(x.key)) continue;
    ctx.seen.add(x.key);
    items.push(x.r);
  }
  const allDone = sources.every((_, i) => ctx.exhausted.has(sourceKey(folder.id, i))) || page >= perRound * MAX_ROUNDS;
  return { items: sortTitles(items, ctx.sort), done: allDone };
}

/**
 * Comme resolveFolder, mais enchaîne les pages tant que celle-ci est vide (titres déjà vus ou filtrés), jusqu'à 6 essais.
 * `advance` = nombre de pages consommées (pour infiniteList).
 */
export async function resolveUntil(folder: Folder, page: number, ctx: ResolveCtx, opts: ResolveOpts = {}, min = 6): Promise<Resolved & { advance: number }> {
  const items: RawTitle[] = [];
  let advance = 0;
  let done = false;
  for (let tries = 0; tries < 6 && items.length < min && !done; tries += 1) {
    const r = await resolveFolder(folder, page + advance, ctx, opts);
    advance += 1;
    items.push(...r.items);
    done = r.done;
  }
  return { items, done, advance };
}

/** Fond TMDB d'un titre du dossier : repli quand l'image du catalogue est cassée. '' si rien n'est trouvé. */
export async function folderBackdrop(folder: Folder, opts: ResolveOpts = {}): Promise<string> {
  try {
    const ctx = newCtx();
    const r = await resolveFolder(folder, 1, ctx, { ...opts, visible: (x) => x });
    const hit = r.items.find((t) => t.backdrop_path);
    return hit ? `https://image.tmdb.org/t/p/w780${hit.backdrop_path}` : '';
  } catch {
    return '';
  }
}

// ---- Découvrir : filtres libres ----

export interface DiscoverSel {
  media: Media;
  /** Identifiant de genre TMDB (propre au type). */
  genre?: number | string;
  /** Début de décennie : « 1990 ». « before » : avant 1970. */
  decade?: string;
  /** Code ISO du pays d'origine. */
  country?: string;
  minRating?: number;
  /** Identifiants de fournisseurs, séparés par « | ». */
  providers?: string;
}

/** Dossier à une seule source discover construit à partir des filtres libres de la page Découvrir. */
export function buildDiscoverFolder(sel: DiscoverSel): Folder {
  const filters: SourceFilters = { voteCountGte: sel.media === 'tv' ? 50 : 100 };
  if (sel.genre) filters.withGenres = String(sel.genre);
  if (sel.decade === 'before') filters.releaseDateLte = '1969-12-31';
  else if (sel.decade && /^\d{4}$/.test(sel.decade)) {
    filters.releaseDateGte = `${sel.decade}-01-01`;
    filters.releaseDateLte = `${Number(sel.decade) + 9}-12-31`;
  }
  if (sel.country) filters.withOriginCountry = sel.country;
  if (sel.minRating) filters.voteAverageGte = sel.minRating;
  if (sel.providers) filters.withWatchProviders = sel.providers;
  return { id: 'discover', title: 'Découvrir', sources: [{ kind: 'DISCOVER', media: sel.media, sort: 'popularity.desc', filters }] };
}
