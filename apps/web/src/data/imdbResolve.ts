import { appFetch } from './crossFetch';
import { tmdb } from './lt';

/* Résolution de l'identifiant IMDb d'un titre TMDB (ODY-248). lastAddon cherche les sources par `tt…` : quand TMDB n'en donne
 * pas (`external_ids.imdb_id` vide), on retrouve l'identifiant par une chaîne de repli, toujours depuis l'appareil et sans
 * clé ni débridage : TMDB, Wikidata (CC0), TVmaze (CC BY-SA, attribution dans les crédits). Le résultat est mémorisé par titre. */

type ImdbSource = 'tmdb' | 'wikidata' | 'tvmaze' | 'tvmaze-title';

export interface ImdbResolution {
  imdb: string | null;
  /** Méthodes essayées, dans l'ordre (libellés lisibles) ; sert au message quand rien n'est trouvé. */
  tried: string[];
  source?: ImdbSource;
  /** Une étape a échoué (réseau, 5xx, 429) : l'absence d'identifiant n'est pas établie, rien n'est mémorisé. */
  failed?: boolean;
}

const SOURCE_LABEL: Record<ImdbSource, string> = {
  tmdb: 'TMDB', wikidata: 'Wikidata', tvmaze: 'TVmaze (identifiant TVDB)', 'tvmaze-title': 'TVmaze (titre et année)',
};

const STORE_PREFIX = 'laststream.imdbId:';
/** Un identifiant trouvé change peu : 30 jours. Un échec est retenté plus tôt (la base de l'une des sources peut se compléter). */
const FOUND_TTL_MS = 30 * 24 * 3_600_000;
export const MISS_TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 8_000;
const IMDB_RE = /^tt\d{1,12}$/;

const imdbOf = (v: unknown): string | null => (typeof v === 'string' && IMDB_RE.test(v) ? v : null);

interface Stored { imdb: string | null; tried: string[]; source?: ImdbSource; at: number }

const memory = new Map<string, Stored>();
const inflight = new Map<string, Promise<ImdbResolution>>();

const keyOf = (type: 'movie' | 'tv', id: string | number): string => `${type}:${id}`;

function readStored(key: string, now: number): Stored | null {
  let e = memory.get(key);
  if (!e) {
    try {
      const raw = globalThis.localStorage?.getItem(STORE_PREFIX + key);
      const parsed = raw ? (JSON.parse(raw) as Stored | null) : null;
      if (parsed && typeof parsed.at === 'number' && Array.isArray(parsed.tried) && (parsed.imdb === null || imdbOf(parsed.imdb))) e = parsed;
    } catch { /* stockage indisponible : pas de cache */ }
  }
  if (!e) return null;
  if (now - e.at > (e.imdb ? FOUND_TTL_MS : MISS_TTL_MS)) return null;
  memory.set(key, e);
  return e;
}

function writeStored(key: string, e: Stored): void {
  memory.set(key, e);
  try { globalThis.localStorage?.setItem(STORE_PREFIX + key, JSON.stringify(e)); } catch { /* quota ou stockage désactivé */ }
}

/** Vide la mémoire (tests). */
export function clearImdbResolveCache(): void {
  memory.clear();
  inflight.clear();
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k?.startsWith(STORE_PREFIX)) ls.removeItem(k);
    }
  } catch { /* ignoré */ }
}

/** Réponse JSON, `null` si le service ne connaît pas la ressource (404 et autres 4xx) ; lève sur coupure, délai, 429 ou 5xx. */
async function getJson<T>(url: string, accept = 'application/json'): Promise<T | null> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await appFetch(url, { headers: { Accept: accept }, ...(ctl ? { signal: ctl.signal } : {}) });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Étape Wikidata : propriété IMDb (P345) d'un élément retrouvé par identifiant TMDB (P4947 film, P4983 série) puis TVDB (P4835 série). */
async function wikidataImdb(type: 'movie' | 'tv', tmdbId: string | number, tvdbId?: string | number | null): Promise<string | null> {
  const clauses: string[] = [];
  const num = (v: string | number): string | null => (/^\d{1,12}$/.test(String(v)) ? String(v) : null);
  const t = num(tmdbId);
  if (t) clauses.push(`{ ?i wdt:${type === 'tv' ? 'P4983' : 'P4947'} "${t}" }`);
  const v = tvdbId != null ? num(tvdbId) : null;
  if (v && type === 'tv') clauses.push(`{ ?i wdt:P4835 "${v}" }`);
  if (!clauses.length) return null;
  const query = `SELECT ?imdb WHERE { ${clauses.join(' UNION ')} ?i wdt:P345 ?imdb } LIMIT 1`;
  const data = await getJson<{ results?: { bindings?: { imdb?: { value?: string } }[] } }>(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, 'application/sparql-results+json');
  return imdbOf(data?.results?.bindings?.[0]?.imdb?.value);
}

interface TvmazeShow { name?: string; premiered?: string | null; externals?: { imdb?: string | null } | null }

/** Étape TVmaze par identifiant TVDB : `/lookup/shows?thetvdb=` (redirige vers la fiche). */
async function tvmazeImdbByTvdb(tvdbId: string | number): Promise<string | null> {
  if (!/^\d{1,12}$/.test(String(tvdbId))) return null;
  const show = await getJson<TvmazeShow>(`https://api.tvmaze.com/lookup/shows?thetvdb=${tvdbId}`);
  return imdbOf(show?.externals?.imdb);
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Étape TVmaze par titre : n'est retenue que la fiche dont le titre est identique (après normalisation) à l'un des titres
 * connus ET dont l'année de première diffusion est à ±1 an de celle de TMDB. Sans année, aucune recherche par titre (trop risqué).
 */
async function tvmazeImdbByTitle(titles: readonly string[], year: number | null): Promise<string | null> {
  if (year == null) return null;
  const wanted = new Set(titles.map(norm).filter(Boolean));
  for (const title of titles) {
    if (!title) continue;
    const show = await getJson<TvmazeShow>(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
    if (!show?.name || !wanted.has(norm(show.name))) continue;
    const y = Number((show.premiered ?? '').slice(0, 4));
    if (!Number.isFinite(y) || y === 0 || Math.abs(y - year) > 1) continue;
    const imdb = imdbOf(show.externals?.imdb);
    if (imdb) return imdb;
  }
  return null;
}

interface TmdbExternalIds { imdb_id?: string | null; tvdb_id?: number | null }
interface TmdbDetails { name?: string; original_name?: string; first_air_date?: string }

async function resolveUncached(type: 'movie' | 'tv', tmdbId: string | number): Promise<ImdbResolution> {
  const tried: string[] = [];
  let failed = false;
  const done = (imdb: string, source: ImdbSource): ImdbResolution => ({ imdb, tried, source });
  /** Exécute une étape ; une erreur la saute (la chaîne continue) mais interdit de conclure à « pas d'identifiant ». */
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    tried.push(label);
    try { return await run(); } catch { failed = true; return null; }
  };

  const ext = await step(SOURCE_LABEL.tmdb, () => tmdb<TmdbExternalIds>(`${type}/${tmdbId}/external_ids`));
  const direct = imdbOf(ext?.imdb_id);
  if (direct) return done(direct, 'tmdb');
  const tvdbId = typeof ext?.tvdb_id === 'number' && ext.tvdb_id > 0 ? ext.tvdb_id : null;

  const wd = await step(SOURCE_LABEL.wikidata, () => wikidataImdb(type, tmdbId, tvdbId));
  if (wd) return done(wd, 'wikidata');

  if (type === 'tv') {
    if (tvdbId) {
      const tm = await step(SOURCE_LABEL.tvmaze, () => tvmazeImdbByTvdb(tvdbId));
      if (tm) return done(tm, 'tvmaze');
    }
    const byTitle = await step(SOURCE_LABEL['tvmaze-title'], async () => {
      const d = await tmdb<TmdbDetails>(`tv/${tmdbId}`);
      const titles = [...new Set([d?.name, d?.original_name].filter((s): s is string => typeof s === 'string' && s !== ''))];
      const y = Number((d?.first_air_date ?? '').slice(0, 4));
      return titles.length ? await tvmazeImdbByTitle(titles, Number.isFinite(y) && y > 0 ? y : null) : null;
    });
    if (byTitle) return done(byTitle, 'tvmaze-title');
  }
  return { imdb: null, tried, ...(failed ? { failed: true } : {}) };
}

/**
 * Identifiant IMDb d'un titre TMDB, avec repli. Mémorisé par titre (30 jours si trouvé, 6 h si toutes les étapes ont répondu sans résultat) ; les appels simultanés
 * pour un même titre partagent la même résolution. Ne lève jamais : `imdb` est null, `tried` liste les méthodes essayées et `failed` signale une étape en erreur (rien n'est alors mémorisé).
 */
export function resolveImdbId(type: 'movie' | 'tv', tmdbId: string | number, now = Date.now()): Promise<ImdbResolution> {
  const key = keyOf(type, tmdbId);
  const known = readStored(key, now);
  if (known) return Promise.resolve({ imdb: known.imdb, tried: known.tried, ...(known.source ? { source: known.source } : {}) });
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = resolveUncached(type, tmdbId)
    .then((r) => { if (!r.failed) writeStored(key, { ...r, at: now }); return r; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

/** Erreur de `loadSources` quand aucun identifiant IMDb n'est trouvé ; `message` reste `no-imdb` (testé par le sélecteur). */
export class NoImdbError extends Error {
  readonly tried: string[];
  constructor(tried: string[]) {
    super('no-imdb');
    this.name = 'NoImdbError';
    this.tried = tried;
  }
}

/** Texte du sélecteur de sources quand aucun identifiant n'a été trouvé : dit ce qui a été essayé. */
export function noImdbMessage(tried: readonly string[]): string {
  return `Aucun identifiant IMDb trouvé pour ce titre${tried.length ? ` (essayé : ${tried.join(', ')})` : ''} : impossible de chercher des sources. Réessaie plus tard.`;
}
