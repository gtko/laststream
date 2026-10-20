/*
 * Catalogue de collections : chargement à la demande (import dynamique du JSON, ~900 Ko), recherche du hub,
 * rotation quotidienne des rangées d'accueil et rotation tous les 14 jours des visuels « En vedette ».
 * Collections inspirées de Focale (MIT, © 2026 Shika34, voir LICENSE-FOCALE.txt) et Kaptain.
 */
import type { Folder, Source } from './engine';

export interface Category {
  id: string;
  title: string;
  folders: Folder[];
}

export interface Catalog {
  categories: Category[];
  byId: Map<string, Folder>;
  /** Dossier -> catégorie. */
  catOf: Map<string, Category>;
  /** Dossiers sans source TMDB mais avec visuel (page Découvrir), hors hub. */
  art: Map<string, Folder>;
}

export const CREDIT = 'Collections inspirées de Focale (MIT) et Kaptain';
export const SERVICES_CATEGORY = 'collection-ERFS5GWK';
const SPOTLIGHT_CATEGORY = 'collection-SPOTLIGHTS';
const DISCOVER_CATEGORY = 'collection-UGED6TEZ';
/** Rangées d'accueil : catégories qui tournent (hors services, vedette et découvrir, déjà montrés ailleurs). */
const ROTATING_EXCLUDED = new Set([SERVICES_CATEGORY, SPOTLIGHT_CATEGORY, DISCOVER_CATEGORY]);

const KINDS = new Set(['DISCOVER', 'LIST', 'COLLECTION', 'COMPANY']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
/** Adresse d'image : http(s) seulement (pas de data:, javascript:…). */
const httpUrl = (v: unknown): string | undefined => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined);

function cleanSource(raw: unknown): Source | null {
  if (!isObj(raw) || !KINDS.has(String(raw.kind))) return null; // trakt, addon : ignorés
  if (raw.provider !== undefined && raw.provider !== 'tmdb') return null;
  const media = raw.media === 'tv' ? 'tv' : 'movie';
  const src: Source = { kind: raw.kind as Source['kind'], media };
  if (str(raw.name)) src.name = raw.name as string;
  if (str(raw.sort)) src.sort = raw.sort as string;
  if (typeof raw.id === 'number') src.id = raw.id;
  if (isObj(raw.filters)) src.filters = raw.filters as Source['filters'];
  return src;
}

/** Construit le catalogue : les dossiers sans aucune source TMDB sont masqués. Pur (testable). */
export function buildCatalog(raw: unknown): Catalog {
  const cats: Category[] = [];
  const byId = new Map<string, Folder>();
  const catOf = new Map<string, Category>();
  const art = new Map<string, Folder>();
  const list = isObj(raw) && Array.isArray(raw.categories) ? raw.categories : [];
  for (const c of list) {
    if (!isObj(c) || !str(c.id) || !str(c.title) || !Array.isArray(c.folders)) continue;
    const cat: Category = { id: c.id as string, title: c.title as string, folders: [] };
    for (const f of c.folders) {
      if (!isObj(f) || !str(f.id) || !str(f.title)) continue;
      const sources = (Array.isArray(f.sources) ? f.sources : []).map(cleanSource).filter((s): s is Source => !!s);
      const folder: Folder = { id: f.id as string, title: f.title as string, sources };
      for (const k of ['cover', 'gif', 'logo', 'hero'] as const) { const u = httpUrl(f[k]); if (u) folder[k] = u; }
      if (f.hidden === true || !sources.length) {
        if (f.hidden === true) art.set(folder.id, folder);
        continue;
      }
      if (byId.has(folder.id)) continue;
      cat.folders.push(folder);
      byId.set(folder.id, folder);
      catOf.set(folder.id, cat);
    }
    if (cat.folders.length) cats.push(cat);
  }
  return { categories: cats, byId, catOf, art };
}

let memo: Promise<Catalog> | null = null;
/** Charge (une fois) le JSON de collections, à la demande : il n'alourdit pas le premier chargement. */
export function loadCatalog(): Promise<Catalog> {
  if (!memo) {
    memo = import('./focale.json').then((m) => buildCatalog((m as { default: unknown }).default));
    memo.catch(() => { memo = null; });
  }
  return memo;
}

// ---- Hub : pastilles de catégorie et recherche ----

/** Minuscules sans accents : « Réalisateurs » se trouve avec « realisateur ». */
export const normalizeText = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export interface HubGroup {
  category: Category;
  folders: Folder[];
  /** Nombre de dossiers de la catégorie avant recherche. */
  total: number;
}

/** Catégories (ou une seule) et dossiers qui correspondent à la recherche (nom du dossier, de la catégorie ou d'une de ses sources). */
export function searchCatalog(cat: Catalog, o: { category?: string; query?: string } = {}): HubGroup[] {
  const q = normalizeText(o.query ?? '');
  const out: HubGroup[] = [];
  for (const c of cat.categories) {
    if (o.category && o.category !== 'all' && c.id !== o.category) continue;
    const catHit = !!q && normalizeText(c.title).includes(q);
    const folders = !q || catHit ? c.folders : c.folders.filter((f) =>
      normalizeText(f.title).includes(q) || f.sources.some((s) => !!s.name && normalizeText(s.name).includes(q)));
    if (folders.length) out.push({ category: c, folders, total: c.folders.length });
  }
  return out;
}

// ---- Rotations ----

const CYCLE_MS = 14 * 24 * 60 * 60 * 1000;
/** Dernière rotation connue des visuels (2 octobre 2026) : origine des cycles de quatorze jours. */
const CYCLE_ANCHOR_MS = Date.UTC(2026, 9, 2);

/** Numéro du cycle de 14 jours en cours (0 avant la première rotation). */
export function spotlightArtVersion(now: Date = new Date()): string {
  return String(Math.max(0, Math.floor((now.getTime() - CYCLE_ANCHOR_MS) / CYCLE_MS)));
}

/** Pose `?v=<cycle>` sur les visuels des spotlights (l'adresse ne change pas à la rotation : le cache doit être forcé). */
export function versionArt(folder: Folder, version: string): Folder {
  const v = (u?: string) => (u && u.includes('/art/spotlights/') ? `${u.split('?')[0]}?v=${version}` : u);
  return { ...folder, cover: v(folder.cover), gif: v(folder.gif), logo: v(folder.logo), hero: v(folder.hero) };
}

/** Les dossiers « En vedette » : visuels versionnés ; l'ordre tourne d'un cran à chaque cycle de 14 jours. */
export function featuredFolders(cat: Catalog, now: Date = new Date()): Folder[] {
  const spot = cat.categories.find((c) => c.id === SPOTLIGHT_CATEGORY);
  if (!spot) return [];
  const version = spotlightArtVersion(now);
  const shift = spot.folders.length ? Number(version) % spot.folders.length : 0;
  const rotated = spot.folders.slice(shift).concat(spot.folders.slice(0, shift));
  return rotated.map((f) => versionArt(f, version));
}

/** Entier stable pour un jour (yyyymmdd local). */
const daySeed = (d: Date = new Date()): number => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

/** Générateur déterministe (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const a = items.slice();
  const r = rng(seed);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Rangées de collections du jour : `rows` catégories variées, `perRow` dossiers chacune ; même choix toute la journée. */
export function rotatingRows(cat: Catalog, now: Date = new Date(), rows = 3, perRow = 12): Array<{ category: Category; folders: Folder[] }> {
  const seed = daySeed(now);
  const pool = cat.categories.filter((c) => !ROTATING_EXCLUDED.has(c.id) && c.folders.length >= 4);
  return seededShuffle(pool, seed).slice(0, rows).map((category, i) => ({
    category,
    folders: seededShuffle(category.folders, seed + i + 1).slice(0, perRow),
  }));
}

// ---- Services de streaming ----

/** Pages service existantes (#/service/{slug}) -> titre du dossier du catalogue. */
const SERVICE_SLUGS: Record<string, string> = {
  netflix: 'netflix', 'prime video': 'prime-video', 'disney+': 'disney-plus', 'hbo max': 'max', 'apple tv+': 'apple-tv-plus',
  'paramount+': 'paramount-plus', crunchyroll: 'crunchyroll', mubi: 'mubi', 'pluto tv': 'pluto-tv',
};
export const serviceSlug = (folder: Folder): string | null => SERVICE_SLUGS[folder.title.toLowerCase()] ?? null;

export function serviceFolders(cat: Catalog): Folder[] {
  return cat.categories.find((c) => c.id === SERVICES_CATEGORY)?.folders ?? [];
}

/** Dossiers de la page Découvrir, dans l'ordre de l'interface (art seul pour « Pour vous » et « Meilleures séries »). */
const DISCOVER_ORDER = ['folder-25429024', 'folder-9D1C5A0D', 'folder-c2fa6b78', 'folder-F5BC0453', 'folder-4a9b21f7', 'folder-IHPHVHSB', 'folder-XUX2DKEX'];
export const FOR_YOU_ID = 'folder-25429024';
const BEST_SERIES_ID = 'folder-XUX2DKEX';

/** Source TMDB de remplacement pour « Meilleures séries » (la source d'origine est Trakt). */
const BEST_SERIES_SOURCE: Source = { kind: 'DISCOVER', media: 'tv', name: 'Meilleures séries', sort: 'vote_average.desc', filters: { voteCountGte: 500, withoutGenres: '16,10764,10767,10763' } };

/** Dossier ouvrable par #/collection/{id} : un dossier du hub, ou « Meilleures séries » (remplacé par une requête TMDB). « Pour vous » : null (recommandations). */
export function folderById(cat: Catalog, id: string): Folder | null {
  if (id === FOR_YOU_ID) return null;
  return cat.byId.get(id) ?? discoverFolders(cat).find((f) => f.id === id) ?? null;
}

export function discoverFolders(cat: Catalog): Folder[] {
  const out: Folder[] = [];
  for (const id of DISCOVER_ORDER) {
    const f = cat.byId.get(id) ?? cat.art.get(id);
    if (!f) continue;
    out.push(id === BEST_SERIES_ID ? { ...f, hidden: false, sources: [BEST_SERIES_SOURCE] } : f);
  }
  return out;
}
