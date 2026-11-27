import { isRecord } from '../sources/http.js';
import type { StremioStream } from '../types.js';
import type { RowBlobStore } from './rows.js';
import { etagOf } from './meta.js';
import { platform } from '../platform/index.js';

/**
 * Classiques libres (LAST-1656) : films libres de droits partout, proposés sans extension ni compte tiers.
 *
 * Registre : Wikidata (données CC0). Un film entre dans l'index s'il a un identifiant IMDb, une vidéo du film entier sur
 * Wikimedia Commons (P10, hors bande-annonce) ou un identifiant Internet Archive (P724), et s'il passe la règle stricte
 * « libre partout » :
 * - libre aux États-Unis : publié il y a plus de 95 ans (année ≤ année courante − 96) ;
 * - libre en France et en Suisse : chaque auteur connu (réalisation P57, scénario P58, musique P86) est mort il y a plus
 *   de 70 ans (année de décès ≤ année courante − 71). Un film sans auteur connu, ou dont un auteur n'a pas de date de
 *   décès lisible, est écarté.
 *
 * L'index est construit hors requête (Cron dédié sous Workers, à la demande sous Node), gardé dans le stockage des
 * rangées (`libres/index.json`) et relu en mémoire. Les vidéos restent chez Commons et Archive : l'appareil les lit en
 * direct, le serveur ne relaie aucun octet.
 */

export const LIBRES_KEY = 'libres/index.json';
/** Index reconstruit au plus une fois par semaine. */
const LIBRES_MAX_AGE_MS = 7 * 24 * 3600e3;
/** Index relu dans le stockage au plus une fois par heure et par instance. */
const MEMORY_TTL_MS = 3600e3;
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const ARCHIVE_METADATA = 'https://archive.org/metadata/';
const ARCHIVE_DOWNLOAD = 'https://archive.org/download/';
/** Identification exigée par Wikimedia pour les clients automatiques. */
const USER_AGENT = 'Laststream/1.0 (https://laststream.app; classiques libres)';
const IMDB_ID = /^tt\d{5,10}$/;
const ARCHIVE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const VIDEO_EXT = /\.(webm|ogv|mp4)$/i;
/** Fiches Archive lues en parallèle, et au plus par reconstruction (les fichiers déjà connus sont repris de l'index précédent). */
const ARCHIVE_CONCURRENCY = 6;
const ARCHIVE_MAX_LOOKUPS = 2000;
/** En dessous, un MP4 est un extrait ; au-dessus, un fichier anormal. */
const ARCHIVE_MIN_BYTES = 5e6;
const ARCHIVE_MAX_BYTES = 8e9;
const PAGE_SIZE = 20;

export interface LibreFilm {
  imdb: string;
  tmdb?: number;
  year: number;
  /** Nombre de wikis qui parlent du film : sert d'ordre de popularité. */
  links: number;
  /** Vidéo Commons (URL Special:FilePath, en https). */
  commons?: string;
  /** Identifiant de l'élément Internet Archive. */
  archive?: string;
  /** Fichier MP4 retenu dans cet élément, et sa taille. */
  archiveFile?: string;
  archiveSize?: number;
}

export interface LibresIndex {
  version: 1;
  generatedAt: number;
  /** Dernière année de publication admise (règle américaine). */
  publishedUpTo: number;
  /** Dernière année de décès admise pour un auteur (règle européenne). */
  deathUpTo: number;
  films: LibreFilm[];
}

/** Bornes de la règle « libre partout » pour l'année en cours. */
export function libreBounds(now: number): { publishedUpTo: number; deathUpTo: number } {
  const year = new Date(now).getUTCFullYear();
  return { publishedUpTo: year - 96, deathUpTo: year - 71 };
}

/** Requête SPARQL : une ligne par (film, vidéo ou élément Archive, date, auteur). Le filtre des auteurs se fait ici, en code. */
function libresQuery(publishedUpTo: number): string {
  return `SELECT ?film ?imdb ?tmdb ?video ?ia ?date ?links ?author ?death WHERE {
  VALUES ?kind { wd:Q11424 wd:Q24862 wd:Q202866 wd:Q226730 wd:Q93204 }
  ?film wdt:P31 ?kind ; wdt:P345 ?imdb ; wdt:P577 ?date ; wikibase:sitelinks ?links .
  FILTER(YEAR(?date) <= ${publishedUpTo})
  { ?film p:P10 ?st . ?st ps:P10 ?video . FILTER NOT EXISTS { ?st pq:P3831 wd:Q622550 } }
  UNION { ?film wdt:P724 ?ia }
  OPTIONAL { ?film wdt:P4947 ?tmdb }
  OPTIONAL { ?film wdt:P57|wdt:P58|wdt:P86 ?author . OPTIONAL { ?author wdt:P570 ?death } }
}`;
}

const yearOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = /^(-?\d{1,4})-\d{2}-\d{2}/.exec(value);
  return match === null ? undefined : Number(match[1]);
};

const cell = (row: Record<string, unknown>, name: string): string | undefined => {
  const value = row[name];
  return isRecord(value) && typeof value.value === 'string' ? value.value : undefined;
};

interface Draft {
  imdb: string;
  tmdb?: number;
  years: number[];
  links: number;
  videos: Set<string>;
  archives: Set<string>;
  /** Auteur → années de décès lues (vide : date absente ou illisible). */
  authors: Map<string, Set<number>>;
}

/** URL Commons utilisable, en https, ou undefined (autre hôte, format non vidéo). */
function commonsUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'commons.wikimedia.org' || !url.pathname.startsWith('/wiki/Special:FilePath/')) return undefined;
    if (!VIDEO_EXT.test(decodeURIComponent(url.pathname))) return undefined;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Préférence : WebM (lu partout sauf vieux Safari), puis MP4, puis Ogg. */
const commonsRank = (url: string): number => (/\.webm$/i.test(url) ? 0 : /\.mp4$/i.test(url) ? 1 : 2);

/**
 * Réponse SPARQL → films qui passent la règle « libre partout », du plus connu au moins connu. Les fichiers Archive ne
 * sont pas encore choisis (voir `resolveArchiveFiles`).
 */
export function parseLibres(json: unknown, now: number): LibreFilm[] {
  const { publishedUpTo, deathUpTo } = libreBounds(now);
  const rows = isRecord(json) && isRecord(json.results) && Array.isArray(json.results.bindings) ? json.results.bindings.filter(isRecord) : [];
  const drafts = new Map<string, Draft>();
  for (const row of rows) {
    const film = cell(row, 'film');
    const imdb = cell(row, 'imdb');
    if (film === undefined || imdb === undefined || !IMDB_ID.test(imdb)) continue;
    let draft = drafts.get(film);
    if (draft === undefined) {
      draft = { imdb, years: [], links: 0, videos: new Set(), archives: new Set(), authors: new Map() };
      drafts.set(film, draft);
    }
    const tmdb = Number(cell(row, 'tmdb'));
    if (Number.isSafeInteger(tmdb) && tmdb > 0) draft.tmdb ??= tmdb;
    const year = yearOf(cell(row, 'date'));
    if (year !== undefined) draft.years.push(year);
    const links = Number(cell(row, 'links'));
    if (Number.isFinite(links)) draft.links = Math.max(draft.links, links);
    const video = cell(row, 'video');
    const commons = video === undefined ? undefined : commonsUrl(video);
    if (commons !== undefined) draft.videos.add(commons);
    const ia = cell(row, 'ia');
    if (ia !== undefined && ARCHIVE_ID.test(ia)) draft.archives.add(ia);
    const author = cell(row, 'author');
    if (author !== undefined) {
      const deaths = draft.authors.get(author) ?? new Set<number>();
      const death = yearOf(cell(row, 'death'));
      if (death !== undefined) deaths.add(death);
      draft.authors.set(author, deaths);
    }
  }
  // Un même IMDb peut porter deux éléments Wikidata (doublon) : le premier qui passe la règle est gardé.
  const seen = new Set<string>();
  const films: LibreFilm[] = [];
  for (const draft of drafts.values()) {
    if (seen.has(draft.imdb) || draft.years.length === 0) continue;
    const year = Math.min(...draft.years);
    if (year > publishedUpTo) continue;
    if (draft.authors.size === 0) continue;
    const allDead = [...draft.authors.values()].every((deaths) => deaths.size > 0 && Math.max(...deaths) <= deathUpTo);
    if (!allDead) continue;
    if (draft.videos.size === 0 && draft.archives.size === 0) continue;
    const film: LibreFilm = { imdb: draft.imdb, year, links: draft.links };
    if (draft.tmdb !== undefined) film.tmdb = draft.tmdb;
    const commons = [...draft.videos].sort((a, b) => commonsRank(a) - commonsRank(b) || a.localeCompare(b))[0];
    if (commons !== undefined) film.commons = commons;
    const archive = [...draft.archives].sort()[0];
    if (archive !== undefined) film.archive = archive;
    seen.add(draft.imdb);
    films.push(film);
  }
  return films.sort((a, b) => b.links - a.links || a.year - b.year || a.imdb.localeCompare(b.imdb));
}

/**
 * Fichier MP4 à lire dans une fiche Archive (`/metadata/<id>`) : le plus lourd des MP4 entre 5 Mo et 8 Go, hors
 * bande-annonce. Élément retiré (`is_dark`) ou sans MP4 utilisable : undefined.
 */
export function pickArchiveFile(json: unknown): { name: string; size: number } | undefined {
  if (!isRecord(json) || json.is_dark === true || !Array.isArray(json.files)) return undefined;
  let best: { name: string; size: number } | undefined;
  for (const file of json.files) {
    if (!isRecord(file) || typeof file.name !== 'string') continue;
    const name = file.name;
    if (!/\.mp4$/i.test(name) || /trailer|bande[-_ ]?annonce/i.test(name) || name.includes('/')) continue;
    const size = Number(file.size);
    if (!Number.isFinite(size) || size < ARCHIVE_MIN_BYTES || size > ARCHIVE_MAX_BYTES) continue;
    if (best === undefined || size > best.size) best = { name, size };
  }
  return best;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchFn: FetchFn, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: { Accept: 'application/sparql-results+json, application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return await response.json();
}

/**
 * Choisit le fichier MP4 de chaque élément Archive. Un fichier connu de l'index précédent est repris tel quel ; les autres
 * sont lus (6 en parallèle, 2000 au plus). Un film sans vidéo lisible (ni Commons, ni MP4 Archive) est retiré.
 */
async function resolveArchiveFiles(films: LibreFilm[], fetchFn: FetchFn, previous?: LibresIndex): Promise<LibreFilm[]> {
  const known = new Map<string, { name: string; size: number }>();
  for (const film of previous?.films ?? []) {
    if (film.archive !== undefined && film.archiveFile !== undefined) known.set(film.archive, { name: film.archiveFile, size: film.archiveSize ?? 0 });
  }
  const todo = films.filter((film) => film.archive !== undefined && !known.has(film.archive)).slice(0, ARCHIVE_MAX_LOOKUPS);
  for (let i = 0; i < todo.length; i += ARCHIVE_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + ARCHIVE_CONCURRENCY).map(async (film) => {
        const id = film.archive as string;
        try {
          const file = pickArchiveFile(await getJson(fetchFn, ARCHIVE_METADATA + encodeURIComponent(id), 20_000));
          if (file !== undefined) known.set(id, file);
        } catch {
          // Fiche illisible : l'élément est ignoré à cette reconstruction.
        }
      }),
    );
  }
  const out: LibreFilm[] = [];
  for (const film of films) {
    const next: LibreFilm = { ...film };
    const file = film.archive === undefined ? undefined : known.get(film.archive);
    if (file !== undefined) {
      next.archiveFile = file.name;
      if (file.size > 0) next.archiveSize = file.size;
    } else {
      delete next.archive;
    }
    if (next.commons === undefined && next.archive === undefined) continue;
    out.push(next);
  }
  return out;
}

/** Construit l'index complet : requête Wikidata, règle « libre partout », fichiers Archive. */
export async function buildLibresIndex(fetchFn: FetchFn, now: number, previous?: LibresIndex): Promise<LibresIndex> {
  const bounds = libreBounds(now);
  const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(libresQuery(bounds.publishedUpTo))}`;
  const films = parseLibres(await getJson(fetchFn, url, 90_000), now);
  return { version: 1, generatedAt: now, ...bounds, films: await resolveArchiveFiles(films, fetchFn, previous) };
}

/** Index lu dans un corps stocké, ou undefined s'il est illisible. */
function parseLibresIndex(body: string): LibresIndex | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.films)) return undefined;
    return parsed as unknown as LibresIndex;
  } catch {
    return undefined;
  }
}

// ---------- Streams ----------

/** Champs `laststream` attendus par l'app (data/stream.ts) : film muet ou ancien, langue d'origine, qualité inconnue. */
function libreInfo(origin: string, sizeBytes?: number): Record<string, unknown> {
  return {
    resolution: 'unknown',
    height: 0,
    source: 'web',
    codec: '',
    hdr: [],
    languages: ['original'],
    cached: false,
    score: 0,
    estBitrateKbps: null,
    copies: 1,
    origins: [{ kind: 'addon', name: 'Classiques libres' }],
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    libre: { source: origin },
  };
}

/** Liens directs d'un film libre : Archive (MP4, lu partout) d'abord, puis Commons. */
export function libreStreams(film: LibreFilm): StremioStream[] {
  const streams: StremioStream[] = [];
  if (film.archive !== undefined && film.archiveFile !== undefined) {
    const url = `${ARCHIVE_DOWNLOAD}${encodeURIComponent(film.archive)}/${film.archiveFile.split('/').map(encodeURIComponent).join('/')}`;
    streams.push({
      name: 'Classique libre',
      description: 'Internet Archive · MP4\nLibre de droits, offert par Laststream',
      url,
      behaviorHints: { filename: film.archiveFile, bingeGroup: 'libres-archive', ...(film.archiveSize === undefined ? {} : { videoSize: film.archiveSize }) },
      laststream: libreInfo('archive', film.archiveSize),
    });
  }
  if (film.commons !== undefined) {
    const filename = decodeURIComponent(film.commons.split('/Special:FilePath/')[1] ?? '');
    streams.push({
      name: 'Classique libre',
      description: `Wikimedia Commons · ${/\.webm$/i.test(filename) ? 'WebM' : /\.mp4$/i.test(filename) ? 'MP4' : 'Ogg'}\nLibre de droits, offert par Laststream`,
      url: film.commons,
      behaviorHints: { filename, bingeGroup: 'libres-commons', ...(/\.ogv$/i.test(filename) ? { notWebReady: true } : {}) },
      laststream: libreInfo('commons'),
    });
  }
  return streams;
}

// ---------- Service ----------

export interface LibresService {
  /** Index en mémoire (relu dans le stockage au plus une fois par heure), sans jamais le construire. */
  current(): Promise<LibresIndex | undefined>;
  /** Film libre de cet IMDb, ou undefined. */
  film(imdb: string): Promise<LibreFilm | undefined>;
  /** Page (1…) des films ayant une fiche TMDB. Sans stockage, lance la construction en arrière-plan à la première demande. */
  page(page: number): Promise<{ results: { tmdb: number; imdb: string; year: number }[]; total: number }>;
  /** Reconstruit l'index s'il manque ou date de plus d'une semaine (Cron, ou arrière-plan sous Node). */
  refresh(force?: boolean): Promise<'written' | 'fresh' | 'failed'>;
}

export interface LibresRuntime {
  store: RowBlobStore | undefined;
  fetch: FetchFn;
  now: () => number;
  background: (work: Promise<unknown>) => void;
}

/** Service des classiques libres. Sous Node sans stockage, l'index vit seulement en mémoire. */
export function createLibres(rt: LibresRuntime): LibresService {
  let memory: { index: LibresIndex | undefined; at: number } | undefined;
  let building: Promise<'written' | 'fresh' | 'failed'> | undefined;

  const load = async (): Promise<LibresIndex | undefined> => {
    if (memory !== undefined && (rt.store === undefined || rt.now() - memory.at < MEMORY_TTL_MS)) return memory.index;
    if (rt.store === undefined) return undefined;
    try {
      const blob = await rt.store.get(LIBRES_KEY);
      const index = blob === undefined ? undefined : parseLibresIndex(blob.body);
      memory = { index, at: rt.now() };
      return index;
    } catch {
      return memory?.index;
    }
  };

  const refresh = (force = false): Promise<'written' | 'fresh' | 'failed'> => {
    building ??= (async () => {
      const previous = await load();
      if (!force && previous !== undefined && rt.now() - previous.generatedAt < LIBRES_MAX_AGE_MS) return 'fresh' as const;
      try {
        const index = await buildLibresIndex(rt.fetch, rt.now(), previous);
        // Une reconstruction vide (Wikidata en panne partielle) ne remplace jamais un index existant.
        if (index.films.length === 0 && previous !== undefined) return 'failed' as const;
        const body = JSON.stringify(index);
        if (rt.store !== undefined) await rt.store.put(LIBRES_KEY, { body, etag: etagOf(body), generatedAt: index.generatedAt });
        memory = { index, at: rt.now() };
        return 'written' as const;
      } catch (err) {
        console.warn(`[lt][libres] reconstruction échouée (${err instanceof Error ? err.message.slice(0, 40) : 'inconnue'})`);
        return 'failed' as const;
      }
    })().finally(() => {
      building = undefined;
    });
    return building;
  };

  let byImdb: { index: LibresIndex; map: Map<string, LibreFilm> } | undefined;
  return {
    current: load,
    async film(imdb) {
      const index = await load();
      if (index === undefined) return undefined;
      if (byImdb?.index !== index) byImdb = { index, map: new Map(index.films.map((film) => [film.imdb, film])) };
      return byImdb.map.get(imdb);
    },
    async page(page) {
      const index = await load();
      // Sous Node (sans stockage), la première demande lance la construction, puis une reconstruction par semaine.
      if (rt.store === undefined) rt.background(refresh());
      const withTmdb = (index?.films ?? []).filter((film): film is LibreFilm & { tmdb: number } => film.tmdb !== undefined);
      const start = (page - 1) * PAGE_SIZE;
      return {
        results: withTmdb.slice(start, start + PAGE_SIZE).map((film) => ({ tmdb: film.tmdb, imdb: film.imdb, year: film.year })),
        total: withTmdb.length,
      };
    },
    refresh,
  };
}

const services = new WeakMap<object, LibresService>();

/**
 * Service partagé d'une application (clé : ses dépendances), créé au premier besoin, quand la plateforme est installée.
 * `store` : stockage des rangées (R2 sous Workers, absent sous Node).
 */
function libresFor(key: object, make: () => LibresRuntime): LibresService {
  let service = services.get(key);
  if (service === undefined) {
    service = createLibres(make());
    services.set(key, service);
  }
  return service;
}

/** Service de l'application : stockage des rangées (R2 sous Workers, absent sous Node), fetch injecté ou global. */
export function libresOfDeps(deps: { rowBlobs?: RowBlobStore; fetch?: typeof fetch }): LibresService {
  return libresFor(deps, () => ({
    store: deps.rowBlobs ?? platform().rowBlobs,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: () => Date.now(),
    background: (work) => platform().scheduler.background(work),
  }));
}
