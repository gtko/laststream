/*
 * Avatars par collections (Pokémon, Disney, Marvel…) servis par lastAddon sous `<base>/avatars/` :
 *   - `catalog.json` : familles, collections, « les plus choisis » ;
 *   - `c/<colId>.json` : personnages d'une collection (ordre de popularité) ;
 *   - `i/<colId>/<charId>.webp` : vignette carrée.
 * Un profil garde `col:<colId>:<charId>` (format pur dans avatars.ts). Tout ce qui est lu ici est gardé en mémoire ;
 * le catalogue seul (1 h) aussi en sessionStorage. Le rendu de l'image est dans ui/avatar-art.js.
 */
import { getBase } from './config';
import { appFetch } from './crossFetch';
import { isValidAvatar, parseColAvatar } from './avatars';
import { userStore } from './userStore';

export { COL_PATTERN, formatColAvatar, parseColAvatar, type ParsedColAvatar } from './avatars';

/** Famille du catalogue (section du sélecteur). Ne pas confondre avec `AvatarFamily` de avatars.ts (onglets DiceBear). */
export interface AvatarFamily { id: string; label: string }

/** Collection : un jeu de personnages, ou un style d'un univers (voir `group`). */
export interface AvatarCollection {
  id: string;
  family: string;
  name: string;
  source: string;
  license: string;
  free: boolean;
  /** Visible sur un profil enfant. */
  kid: boolean;
  total: number;
  /** Titres alternatifs (anglais, romaji, français) pour rapprocher la collection de ce que l'on regarde. */
  aliases: string[];
  /** Univers commun à plusieurs collections (ex. les styles Pokémon). */
  group?: string;
  /** Libellé du style, quand la collection fait partie d'un groupe. */
  style?: string;
  /** charId des personnages les plus connus (8 au plus). */
  previews: string[];
}

export interface Catalog {
  version: string;
  families: AvatarFamily[];
  collections: AvatarCollection[];
  /** Avatars « Les plus choisis » : valeurs `col:<colId>:<charId>`. */
  featured: string[];
}

export interface CatalogCharacter { id: string; name: string }

export interface CollectionCharacters { id: string; characters: CatalogCharacter[] }

/** Une entrée du sélecteur par univers : `styles` = collections à afficher avec un choix de style. */
export interface CollectionGroup { id: string; name: string; family: string; styles: AvatarCollection[] }

/** Personnage trouvé par `searchCharacters`. */
export interface CharacterHit { colId: string; charId: string; name: string; colName: string }

export interface SearchOptions { kidOnly?: boolean; limit?: number }

/** Erreur du catalogue : `code` = not_configured | offline | http_<status> | bad_catalog | bad_collection | bad_json | invalid_id. */
export class AvatarCatalogError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'AvatarCatalogError';
    this.code = code;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_KEY = 'laststream.avatars.catalog';
const RECENT_MAX = 12;
const SUGGEST_MAX = 12;
const CONCURRENCY = 6;
const MIN_QUERY = 2;
const MIN_TITLE_KEY = 3;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const idList = (v: unknown): string[] => strList(v).filter((x) => ID_RE.test(x));

/** Texte comparable : minuscules, sans accents ni ponctuation (« Pokémon : Journeys » -> « pokemon journeys »). */
export function normalizeText(raw: string): string {
  return raw.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ---------- Validation des données reçues ----------

function normalizeCollection(raw: unknown): AvatarCollection | null {
  const o = obj(raw);
  if (!o) return null;
  const id = str(o.id);
  if (!ID_RE.test(id) || !str(o.name)) return null;
  const group = str(o.group);
  const style = str(o.style);
  return {
    id,
    family: str(o.family),
    name: str(o.name),
    source: str(o.source),
    license: str(o.license),
    free: o.free === true,
    kid: o.kid === true,
    total: typeof o.total === 'number' && Number.isFinite(o.total) ? o.total : 0,
    aliases: strList(o.aliases),
    ...(group ? { group } : {}),
    ...(style ? { style } : {}),
    previews: idList(o.previews).slice(0, 8),
  };
}

function normalizeCatalog(raw: unknown): Catalog | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.families) || !Array.isArray(o.collections)) return null;
  const families = o.families.flatMap((f): AvatarFamily[] => {
    const x = obj(f);
    return x && str(x.id) && str(x.label) ? [{ id: str(x.id), label: str(x.label) }] : [];
  });
  const collections = o.collections.flatMap((c): AvatarCollection[] => {
    const n = normalizeCollection(c);
    return n ? [n] : [];
  });
  return {
    version: str(o.version),
    families,
    collections,
    featured: strList(o.featured).filter((v) => parseColAvatar(v) !== null),
  };
}

// ---------- Réseau et caches ----------

/** Lit du JSON depuis lastAddon ; lève AvatarCatalogError (offline, http_<status>, bad_json). */
async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await appFetch(url);
  } catch {
    throw new AvatarCatalogError('offline');
  }
  if (!res.ok) throw new AvatarCatalogError('http_' + res.status);
  try {
    return await res.json();
  } catch {
    throw new AvatarCatalogError('bad_json');
  }
}

function readSession(key: string): unknown {
  try {
    return JSON.parse(globalThis.sessionStorage?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Stockage indisponible (navigation privée, quota) : le cache mémoire suffit.
  }
}

let catalogMem: { base: string; at: number; data: Catalog } | null = null;
let catalogPending: { base: string; promise: Promise<Catalog> } | null = null;
const collectionMem = new Map<string, Promise<CollectionCharacters>>();

/** Catalogue encore frais (mémoire puis sessionStorage) pour cette adresse, sinon null. */
function freshCatalog(base: string): Catalog | null {
  const now = Date.now();
  if (catalogMem && catalogMem.base === base && now - catalogMem.at >= 0 && now - catalogMem.at < CATALOG_TTL_MS) return catalogMem.data;
  const s = obj(readSession(CATALOG_KEY));
  if (s && s.base === base && typeof s.at === 'number' && now - s.at >= 0 && now - s.at < CATALOG_TTL_MS) {
    const data = normalizeCatalog(s.data);
    if (data) {
      catalogMem = { base, at: s.at, data };
      return data;
    }
  }
  return null;
}

/**
 * Catalogue des avatars (`/avatars/catalog.json`), mis en cache 1 h. Rejette avec AvatarCatalogError si lastAddon est
 * injoignable, répond une erreur ou envoie des données inexploitables : l'appelant affiche alors un message, rien d'autre.
 */
export function loadCatalog(): Promise<Catalog> {
  const base = getBase();
  if (!base) return Promise.reject(new AvatarCatalogError('not_configured'));
  const fresh = freshCatalog(base);
  if (fresh) return Promise.resolve(fresh);
  if (catalogPending && catalogPending.base === base) return catalogPending.promise;
  const promise: Promise<Catalog> = getJson(base + '/avatars/catalog.json')
    .then((raw) => {
      const data = normalizeCatalog(raw);
      if (!data) throw new AvatarCatalogError('bad_catalog');
      const at = Date.now();
      catalogMem = { base, at, data };
      writeSession(CATALOG_KEY, { base, at, data });
      return data;
    })
    .finally(() => {
      if (catalogPending?.promise === promise) catalogPending = null;
    });
  catalogPending = { base, promise };
  return promise;
}

/** Personnages d'une collection (`/avatars/c/<colId>.json`, ordre de popularité). Mis en cache en mémoire ; un échec n'est pas gardé. */
export function loadCollection(colId: string): Promise<CollectionCharacters> {
  const base = getBase();
  if (!base) return Promise.reject(new AvatarCatalogError('not_configured'));
  if (!ID_RE.test(colId)) return Promise.reject(new AvatarCatalogError('invalid_id'));
  const key = base + '|' + colId;
  const hit = collectionMem.get(key);
  if (hit) return hit;
  const promise = getJson(base + '/avatars/c/' + colId + '.json').then((raw): CollectionCharacters => {
    const o = obj(raw);
    if (!o || !Array.isArray(o.characters)) throw new AvatarCatalogError('bad_collection');
    const characters = o.characters.flatMap((c): CatalogCharacter[] => {
      const x = obj(c);
      return x && ID_RE.test(str(x.id)) && str(x.name) ? [{ id: str(x.id), name: str(x.name) }] : [];
    });
    return { id: colId, characters };
  });
  collectionMem.set(key, promise);
  promise.catch(() => collectionMem.delete(key));
  return promise;
}

/** Vide les caches en mémoire et de session (tests, changement de serveur). */
export function resetAvatarCatalog(): void {
  catalogMem = null;
  catalogPending = null;
  collectionMem.clear();
  try {
    globalThis.sessionStorage?.removeItem(CATALOG_KEY);
  } catch {
    // Rien à effacer.
  }
}

/**
 * URL de la vignette d'un personnage, sur l'adresse lastAddon réglée. '' si l'adresse n'est pas configurée ou si un
 * identifiant est invalide : l'appelant garde alors l'initiale sur la couleur du profil.
 */
export function avatarImageUrl(colId: string, charId: string): string {
  const base = getBase();
  if (!base || !ID_RE.test(colId) || !ID_RE.test(charId)) return '';
  return base + '/avatars/i/' + colId + '/' + charId + '.webp';
}

// ---------- Regroupement et filtres ----------

/**
 * Regroupe les collections par `group` : une entrée par univers, avec ses styles (dans l'ordre du catalogue). Une
 * collection sans `group` forme son propre groupe.
 */
export function groupCollections(cat: Catalog): CollectionGroup[] {
  const groups = new Map<string, CollectionGroup>();
  for (const c of cat.collections) {
    const key = c.group ? 'group:' + c.group : 'col:' + c.id;
    let g = groups.get(key);
    if (!g) {
      g = { id: c.group || c.id, name: c.name, family: c.family, styles: [] };
      groups.set(key, g);
    }
    g.styles.push(c);
  }
  return [...groups.values()];
}

/** Collections visibles sur un profil enfant. */
export function kidCollections(cat: Catalog): AvatarCollection[] {
  return cat.collections.filter((c) => c.kid);
}

/**
 * Vrai si la valeur d'avatar peut être portée par un profil enfant. `col:` : la collection doit exister et être `kid`.
 * DiceBear et Héros : règle inchangée (valides = autorisés). Absence d'avatar : toujours permise.
 */
export function isKidAllowed(cat: Catalog, value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  const col = parseColAvatar(value);
  if (!col) return isValidAvatar(value);
  return cat.collections.some((c) => c.id === col.colId && c.kid);
}

// ---------- Récents (par profil) ----------

const recentKey = (profileId: string): string => 'laststream.avatars.recent.' + profileId;

/** Derniers avatars choisis par ce profil (le plus récent d'abord, 12 au plus). Valeurs invalides ignorées. */
export function recentAvatars(profileId: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(recentKey(profileId));
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === 'string' && isValidAvatar(v)).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Ajoute un avatar choisi en tête des récents (sans doublon, 12 au plus). Valeur invalide : rien. */
export function pushRecentAvatar(profileId: string, value: string): void {
  if (!isValidAvatar(value)) return;
  try {
    const next = [value, ...recentAvatars(profileId).filter((v) => v !== value)].slice(0, RECENT_MAX);
    globalThis.localStorage?.setItem(recentKey(profileId), JSON.stringify(next));
  } catch {
    // Stockage indisponible : les récents ne sont simplement pas gardés.
  }
}

// ---------- Recherche et suggestions ----------

/** 0 : le nom ou un alias commence par la requête ; 1 : un mot commence par elle ; 2 : sous-chaîne ; -1 : aucun. */
function nameScore(keys: string[], q: string, substring: boolean): number {
  if (keys.some((k) => k.startsWith(q))) return 0;
  if (keys.some((k) => (' ' + k).includes(' ' + q))) return 1;
  if (substring && keys.some((k) => k.includes(q))) return 2;
  return -1;
}

const collectionKeys = (c: AvatarCollection): string[] => [c.name, ...c.aliases].map(normalizeText).filter((k) => k !== '');

/** Recherche de collections sur le nom et les alias (synchrone). Requête de 2 caractères au moins, 30 résultats au plus. */
export function searchCatalog(cat: Catalog, query: string, opts: SearchOptions = {}): AvatarCollection[] {
  const q = normalizeText(query);
  if (q.length < MIN_QUERY) return [];
  const scored: { c: AvatarCollection; score: number }[] = [];
  for (const c of cat.collections) {
    if (opts.kidOnly && !c.kid) continue;
    const score = nameScore(collectionKeys(c), q, true);
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, opts.limit ?? 30).map((x) => x.c);
}

/**
 * Recherche de personnages : charge les fichiers `c/<colId>.json` (6 à la fois, en cache) et filtre par nom. Les
 * collections dont le nom ou un alias correspond à la requête passent en premier et voient tous leurs personnages.
 * Les collections en échec sont ignorées. Renvoie `limit` résultats au plus.
 */
export async function searchCharacters(cat: Catalog, query: string, limit = 60): Promise<CharacterHit[]> {
  const q = normalizeText(query);
  if (q.length < MIN_QUERY || limit <= 0) return [];
  const byName = cat.collections.map((c) => ({ c, named: nameScore(collectionKeys(c), q, false) >= 0 }));
  const ordered = [...byName.filter((x) => x.named), ...byName.filter((x) => !x.named)];
  const hits: CharacterHit[] = [];
  for (let i = 0; i < ordered.length && hits.length < limit; i += CONCURRENCY) {
    const batch = ordered.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(batch.map(({ c }) => loadCollection(c.id).catch(() => null)));
    loaded.forEach((data, k) => {
      if (!data) return;
      const { c, named } = batch[k];
      for (const ch of data.characters) {
        if (hits.length >= limit) break;
        if (named || normalizeText(ch.name).includes(q)) hits.push({ colId: c.id, charId: ch.id, name: ch.name, colName: c.name });
      }
    });
  }
  return hits;
}

/**
 * Avatars suggérés « D'après ce que tu regardes » : une collection est retenue si un de ses noms (nom, alias) apparaît en
 * mots entiers dans un titre (titres normalisés, les plus récents d'abord, clés de 3 caractères au moins). Ses aperçus
 * sont ensuite pris à tour de rôle entre collections retenues, sans doublon : 12 avatars au plus.
 */
export function suggestFromWatching(cat: Catalog, titles: string[]): { colId: string; charId: string }[] {
  const keysOf = cat.collections.map((c) => ({ c, keys: collectionKeys(c).filter((k) => k.length >= MIN_TITLE_KEY) }));
  const matched: AvatarCollection[] = [];
  const seen = new Set<string>();
  for (const raw of titles) {
    const t = ' ' + normalizeText(raw) + ' ';
    if (t.trim() === '') continue;
    for (const { c, keys } of keysOf) {
      if (seen.has(c.id)) continue;
      if (keys.some((k) => t.includes(' ' + k + ' '))) {
        seen.add(c.id);
        matched.push(c);
      }
    }
  }
  const out: { colId: string; charId: string }[] = [];
  const used = new Set<string>();
  const rounds = Math.max(0, ...matched.map((c) => c.previews.length));
  for (let i = 0; i < rounds && out.length < SUGGEST_MAX; i += 1) {
    for (const c of matched) {
      const charId = c.previews[i];
      if (!charId || used.has(c.id + ':' + charId)) continue;
      used.add(c.id + ':' + charId);
      out.push({ colId: c.id, charId });
      if (out.length >= SUGGEST_MAX) break;
    }
  }
  return out;
}

/**
 * Titres regardés du profil courant : « continuer à regarder » puis bibliothèque (les plus récents d'abord), sans doublon.
 * Lit le `userStore` (local ou serveur) ; [] en cas d'erreur.
 */
export async function watchingTitles(): Promise<string[]> {
  try {
    const cont = userStore.continueWatching(20).map((e) => e.title);
    const lib = [...userStore.getLibrary()].sort((a, b) => b.addedAt - a.addedAt).slice(0, 30).map((e) => e.title);
    return [...new Set([...cont, ...lib].map((t) => (t ?? '').trim()).filter((t) => t !== ''))];
  } catch {
    return [];
  }
}
