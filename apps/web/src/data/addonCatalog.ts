/* Catalogues des addons Stremio (ODY-252) : modèle de données, adresses des routes `catalog` / `meta` / `stream`, identifiants
 * (IMDb, TMDB, préfixes propres à l'addon) et registre local des addons dont les catalogues s'affichent sur l'accueil.
 * Aucun appel réseau à l'import. Les pages de catalogue sont lues depuis l'appareil, comme les flux (`deviceFetch`) : seule
 * l'URL du catalogue demandé est autorisée. Le registre est vide par défaut : rien ne s'affiche tant que l'utilisateur n'a rien activé. */

import { addonKey, deviceHttp } from '../sources/deviceFetch';
import type { HttpFn } from '../sources/debrid/http';

// ---------- Modèle ----------

/** Paramètre d'un catalogue (`extra` du manifest) : options proposées et obligation. */
interface CatalogExtra {
  name: string;
  options?: string[];
  isRequired?: boolean;
}

export interface Catalog {
  type: string;
  id: string;
  name: string;
  extra: CatalogExtra[];
}

/** Addon du registre : le manifest réduit à ce que l'app utilise, et le choix d'afficher ses catalogues sur l'accueil. */
export interface AddonCatalogEntry {
  manifestUrl: string;
  name: string;
  logo?: string;
  home: boolean;
  catalogs: Catalog[];
  idPrefixes: string[];
  types: string[];
  resources: { meta: boolean; stream: boolean };
  /** Moment de la lecture du manifest (ms). */
  at: number;
}

/** Fiche d'un catalogue : identifiant et nom obligatoires, autres champs de l'addon conservés tels quels. */
export interface Meta {
  id: string;
  name: string;
  type?: string;
  poster?: string;
  [key: string]: unknown;
}

export interface ManifestCatalogs {
  catalogs: Catalog[];
  idPrefixes: string[];
  types: string[];
  resources: { meta: boolean; stream: boolean };
}

/** Valeurs passées à une route `catalog` ; les vides et les nuls sont omis. */
export interface CatalogExtraValues {
  skip?: number;
  genre?: string;
  search?: string;
}

/** `home` : sur l'accueil ; `search-only` : seulement dans la recherche ; `hidden` : pas affiché (paramètre requis sans valeur par défaut). */
export type CatalogDisplay = 'home' | 'search-only' | 'hidden';

export type CatalogError = 'timeout' | 'network' | 'http' | 'too_large' | 'invalid';

export interface CatalogPage {
  metas: Meta[];
  error?: CatalogError;
}

export interface MappedIds {
  imdb?: string;
  tmdb?: number;
}

// ---------- Utilitaires ----------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** Chaînes non vides d'une liste ; les autres valeurs sont ignorées. */
const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter(nonEmpty).map((s) => s.trim()) : []);
const uniq = (list: string[]): string[] => [...new Set(list)];
const enc = encodeURIComponent;

// ---------- Manifest ----------

/** `extra` du manifest ; à défaut, l'ancien format (`extraSupported` / `extraRequired`, listes de noms). */
function extrasOf(raw: Record<string, unknown>): CatalogExtra[] {
  const byName = new Map<string, CatalogExtra>();
  const put = (name: string): CatalogExtra => {
    const found = byName.get(name);
    if (found) return found;
    const created: CatalogExtra = { name };
    byName.set(name, created);
    return created;
  };
  if (Array.isArray(raw.extra)) {
    for (const e of raw.extra) {
      if (!isObject(e) || !nonEmpty(e.name)) continue;
      const item = put(e.name.trim());
      const options = stringsOf(e.options);
      if (options.length) item.options = options;
      if (e.isRequired === true) item.isRequired = true;
    }
  }
  for (const name of stringsOf(raw.extraSupported)) put(name);
  for (const name of stringsOf(raw.extraRequired)) put(name).isRequired = true;
  return [...byName.values()];
}

function catalogsOf(raw: unknown): Catalog[] {
  if (!Array.isArray(raw)) return [];
  const out: Catalog[] = [];
  for (const c of raw) {
    if (!isObject(c) || !nonEmpty(c.type) || !nonEmpty(c.id)) continue;
    const name = nonEmpty(c.name) ? c.name.trim() : c.id;
    out.push({ type: c.type, id: c.id, name, extra: extrasOf(c) });
  }
  return out;
}

/** Ressources du manifest : chaînes (`"meta"`) ou objets `{ name, types, idPrefixes }`. */
function resourcesOf(raw: unknown): { meta: boolean; stream: boolean; idPrefixes: string[]; types: string[] } {
  const out = { meta: false, stream: false, idPrefixes: [] as string[], types: [] as string[] };
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    let name: unknown;
    if (typeof r === 'string') {
      name = r;
    } else if (isObject(r)) {
      name = r.name;
      out.idPrefixes.push(...stringsOf(r.idPrefixes));
      out.types.push(...stringsOf(r.types));
    }
    if (name === 'meta') out.meta = true;
    if (name === 'stream') out.stream = true;
  }
  return out;
}

/** Catalogues, préfixes d'identifiants, types et ressources d'un manifest. Tolérant : un champ absent ou mal formé donne une liste vide. */
export function parseManifestCatalogs(manifest: unknown): ManifestCatalogs {
  const m: Record<string, unknown> = isObject(manifest) ? manifest : {};
  const res = resourcesOf(m.resources);
  return {
    catalogs: catalogsOf(m.catalogs),
    idPrefixes: uniq([...stringsOf(m.idPrefixes), ...res.idPrefixes]),
    types: uniq([...stringsOf(m.types), ...res.types]),
    resources: { meta: res.meta, stream: res.stream },
  };
}

// ---------- Adresses ----------

/** Adresse de base de l'addon : origine et chemin sans `manifest.json` ni slash final (le préfixe de configuration est gardé). Vide si invalide. */
export function addonBaseOf(manifestUrl: string): string {
  // `addonKey` garde le slash de l'origine pour une adresse racine (`https://h/`) : on le retire ici.
  return addonKey(manifestUrl).replace(/\/+$/, '');
}

/** Clé stable de l'addon dans le registre (même valeur que sa base). */
export function addonKeyOf(manifestUrl: string): string {
  return addonBaseOf(manifestUrl);
}

/** Route `catalog`. Les paramètres s'ajoutent en `genre=…&search=…&skip=…` avant `.json`, valeurs encodées. */
export function catalogUrl(base: string, type: string, id: string, extra: CatalogExtraValues = {}): string {
  const params: string[] = [];
  const genre = extra.genre?.trim();
  if (genre) params.push(`genre=${enc(genre)}`);
  const search = extra.search?.trim();
  if (search) params.push(`search=${enc(search)}`);
  const skip = typeof extra.skip === 'number' && Number.isFinite(extra.skip) ? Math.floor(extra.skip) : 0;
  if (skip > 0) params.push(`skip=${skip}`);
  const path = `${base}/catalog/${enc(type)}/${enc(id)}`;
  return params.length ? `${path}/${params.join('&')}.json` : `${path}.json`;
}

/** Route `meta` d'une fiche. */
export function metaUrl(base: string, type: string, id: string): string {
  return `${base}/meta/${enc(type)}/${enc(id)}.json`;
}

/** Route `stream` d'un titre (l'identifiant est encodé : `fk:1` devient `fk%3A1`). */
export function streamUrl(base: string, type: string, id: string): string {
  return `${base}/stream/${enc(type)}/${enc(id)}.json`;
}

// ---------- Identifiants ----------

/** Identifiants gérés par IMDb, TMDB ou Kitsu : ce ne sont pas des identifiants propres à un addon. */
export function isTmdbOrImdb(id: string): boolean {
  return /^(?:tt\d+|tmdb:|kitsu:)/.test(id);
}

/** Vrai si l'identifiant commence par un préfixe déclaré par l'addon, sans être un identifiant IMDb, TMDB ou Kitsu. */
export function isAddonId(id: string, prefixes: readonly string[]): boolean {
  return !isTmdbOrImdb(id) && prefixes.some((p) => p !== '' && id.startsWith(p));
}

const tmdbOf = (v: unknown): number | undefined => {
  const n: unknown = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

/** Identifiants IMDb et TMDB d'une fiche (absents s'ils sont invalides). */
export function mappedIds(meta: { imdb_id?: unknown; moviedb_id?: unknown; tmdb_id?: unknown }): MappedIds {
  const out: MappedIds = {};
  if (typeof meta.imdb_id === 'string' && /^tt\d+$/.test(meta.imdb_id)) out.imdb = meta.imdb_id;
  const tmdb = tmdbOf(meta.moviedb_id) ?? tmdbOf(meta.tmdb_id);
  if (tmdb !== undefined) out.tmdb = tmdb;
  return out;
}

// ---------- Affichage ----------

/**
 * Où afficher un catalogue. Un paramètre requis autre que `search` et `genre` le masque ; un `genre` requis n'est utilisable
 * que s'il propose des options (la première sert de valeur par défaut) ; un `search` requis le réserve à la recherche.
 */
export function catalogDisplay(cat: Pick<Catalog, 'extra'>): CatalogDisplay {
  const required = cat.extra.filter((e) => e.isRequired);
  if (required.some((e) => e.name !== 'search' && e.name !== 'genre')) return 'hidden';
  if (required.some((e) => e.name === 'genre' && !e.options?.length)) return 'hidden';
  if (required.some((e) => e.name === 'search')) return 'search-only';
  return 'home';
}

// ---------- Registre (stockage local) ----------

/** Clé du registre dans le stockage local. */
export const ADDON_CATALOGS_KEY = 'laststream.addonCatalogs';
const REGISTRY_VERSION = 1;

const isEntry = (v: unknown): v is AddonCatalogEntry =>
  isObject(v) &&
  typeof v.manifestUrl === 'string' &&
  typeof v.name === 'string' &&
  typeof v.home === 'boolean' &&
  Array.isArray(v.catalogs) &&
  Array.isArray(v.idPrefixes) &&
  Array.isArray(v.types) &&
  isObject(v.resources) &&
  typeof v.at === 'number';

/** Entrées du registre (clé → addon). Absent, illisible, d'une autre version ou mal formé : registre vide, sans exception. */
export function readAddonCatalogs(): Record<string, AddonCatalogEntry> {
  try {
    const raw = globalThis.localStorage?.getItem(ADDON_CATALOGS_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (!isObject(data) || data.v !== REGISTRY_VERSION) return {};
    const addons = data.addons;
    if (!isObject(addons)) return {};
    const out: Record<string, AddonCatalogEntry> = {};
    for (const [key, entry] of Object.entries(addons)) {
      if (isEntry(entry)) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAddonCatalogs(addons: Record<string, AddonCatalogEntry>): void {
  try {
    globalThis.localStorage?.setItem(ADDON_CATALOGS_KEY, JSON.stringify({ v: REGISTRY_VERSION, addons }));
  } catch {
    // Stockage indisponible ou plein : rien n'est conservé, l'app reste utilisable.
  }
}

/** Ajoute ou remplace l'entrée d'un addon ; `null` la retire. */
export function setAddonCatalog(key: string, entry: AddonCatalogEntry | null): void {
  const addons = readAddonCatalogs();
  if (entry) addons[key] = entry;
  else delete addons[key];
  writeAddonCatalogs(addons);
}

/** Retire du registre les addons absents de `keys` (désinstallés ou retirés des réglages). */
export function pruneAddonCatalogs(keys: readonly string[]): void {
  const addons = readAddonCatalogs();
  const known = new Set(keys);
  const stale = Object.keys(addons).filter((k) => !known.has(k));
  if (!stale.length) return;
  for (const k of stale) delete addons[k];
  writeAddonCatalogs(addons);
}

// ---------- Lecture d'une page ----------

/** Délai d'une page de catalogue lue depuis l'appareil. */
export const CATALOG_TIMEOUT_MS = 10_000;
/** Taille maximale d'une réponse de catalogue. */
export const CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024;

const isMeta = (v: unknown): v is Meta => isObject(v) && nonEmpty(v.id) && nonEmpty(v.name);

/**
 * Une page de catalogue. `http` est injectable ; par défaut le transport de `deviceFetch`, limité à cette seule URL.
 * Ne rejette jamais : l'échec est renvoyé dans `error`. Ne garde que les fiches qui ont un identifiant et un nom.
 */
export async function fetchCatalogPage(
  entry: Pick<AddonCatalogEntry, 'manifestUrl'>,
  cat: Pick<Catalog, 'type' | 'id'>,
  extra: CatalogExtraValues = {},
  http?: HttpFn,
): Promise<CatalogPage> {
  const base = addonBaseOf(entry.manifestUrl);
  if (!base) return { metas: [], error: 'invalid' };
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = catalogUrl(base, cat.type, cat.id, extra);
    const transport = http ?? deviceHttp(new Set([url]));
    const work = (async () => transport({ url, headers: { Accept: 'application/json' }, timeoutMs: CATALOG_TIMEOUT_MS, signal: ctl.signal }))();
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
        reject(new Error('timeout'));
      }, CATALOG_TIMEOUT_MS);
    });
    const res = await Promise.race([work, expired]);
    if (res.status < 200 || res.status >= 300) return { metas: [], error: 'http' };
    const size = res.body?.byteLength;
    if (typeof size !== 'number') return { metas: [], error: 'invalid' };
    if (size > CATALOG_MAX_BODY_BYTES) return { metas: [], error: 'too_large' };
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      return { metas: [], error: 'invalid' };
    }
    if (!isObject(data) || !Array.isArray(data.metas)) return { metas: [], error: 'invalid' };
    return { metas: data.metas.filter(isMeta) };
  } catch {
    return { metas: [], error: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
