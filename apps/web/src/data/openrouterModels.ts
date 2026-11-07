/**
 * Catalogue public des modèles OpenRouter (GET /api/v1/models, sans clé) pour le choix du modèle dans Réglages > Serveur.
 * Lecture défensive (prix en chaînes, $ par token, champs manquants), dédoublonnage, cache localStorage de 24 h.
 * Aucune clé API n'est jamais envoyée à cet endpoint : la requête part sans en-tête d'authentification ni cookie.
 */
import { appFetch } from './crossFetch';

export const MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const CACHE_KEY = 'ls_openrouter_models_v1';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

/** Hypothèses de l'estimation affichée sous le champ : une recommandation ≈ 1 500 tokens lus et 400 écrits. */
export const ESTIMATE_RUNS = 100;
export const ESTIMATE_INPUT_TOKENS = 1500;
export const ESTIMATE_OUTPUT_TOKENS = 400;

/** Seuils des badges : « Économique » si entrée + sortie ≤ 1 $ par million, « Long contexte » à partir de 500 000 tokens. */
const ECO_MAX_PER_M = 1;
const LONG_CONTEXT_MIN = 500_000;

export interface OrModel {
  id: string;
  name: string;
  provider: string;
  /** Fenêtre de contexte en tokens (0 si inconnue). */
  ctx: number;
  /** Prix en $ par million de tokens ; null si inconnu ou variable (routeurs). */
  inPrice: number | null;
  outPrice: number | null;
}

export type SortKey = 'price' | 'ctx' | 'name';

/** $ par token (chaîne ou nombre) → $ par million ; null si absent, négatif (prix variable) ou illisible. */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

const titleCase = (slug: string) => slug.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Réponse brute → modèles triés par nom, sans doublon d'identifiant. Toute entrée sans identifiant est ignorée. */
export function parseModels(json: unknown): OrModel[] {
  const data = json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : [];
  const raw: { id: string; name: string; slug: string; label: string; ctx: number; inPrice: number | null; outPrice: number | null }[] = [];
  const seen = new Set<string>();
  const slugLabel = new Map<string, string>();
  for (const it of data) {
    if (!it || typeof it !== 'object') continue;
    const m = it as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const slug = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
    const full = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id;
    const colon = full.indexOf(': ');
    const prefix = colon > 0 ? full.slice(0, colon).trim() : '';
    if (prefix && slug && !slugLabel.has(slug)) slugLabel.set(slug, prefix);
    const name = (colon > 0 ? full.slice(colon + 2) : full).replace(/\s*\(free\)\s*$/i, '').trim() || id;
    const pricing = m.pricing && typeof m.pricing === 'object' ? (m.pricing as Record<string, unknown>) : {};
    const top = m.top_provider && typeof m.top_provider === 'object' ? (m.top_provider as Record<string, unknown>) : {};
    const ctxRaw = Number(m.context_length ?? top.context_length);
    raw.push({ id, name, slug, label: prefix, ctx: Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : 0, inPrice: perMillion(pricing.prompt), outPrice: perMillion(pricing.completion) });
  }
  return raw.map((r) => ({
    id: r.id, name: r.name, ctx: r.ctx, inPrice: r.inPrice, outPrice: r.outPrice,
    provider: r.label || slugLabel.get(r.slug) || titleCase(r.slug || 'autres'),
  })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function isFreeModel(m: OrModel): boolean {
  return /:free$/i.test(m.id) || (m.inPrice === 0 && m.outPrice === 0);
}

export function badges(m: OrModel): { free: boolean; eco: boolean; long: boolean } {
  const free = isFreeModel(m);
  const priced = m.inPrice !== null && m.outPrice !== null;
  return { free, eco: !free && priced && (m.inPrice as number) + (m.outPrice as number) <= ECO_MAX_PER_M, long: m.ctx >= LONG_CONTEXT_MIN };
}

const NBSP = ' ';

/** Montant en dollars, format français : « 0,15 $ », « 0,075 $ » sous 0,10, « 0 $ » pour zéro. */
export function money(n: number): string {
  if (n === 0) return '0' + NBSP + '$';
  const digits = n < 0.1 ? 3 : 2;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: digits }) + NBSP + '$';
}

/** « 0,15 $ / 0,60 $ » (par million, entrée / sortie), « Gratuit », ou « Prix variable » (routeurs). */
export function priceLabel(m: OrModel): string {
  if (isFreeModel(m)) return 'Gratuit';
  if (m.inPrice === null || m.outPrice === null) return 'Prix variable';
  return money(m.inPrice) + ' / ' + money(m.outPrice);
}

/** « 128 k », « 1 M », « 1,05 M » ; '' si inconnu. */
export function ctxLabel(ctx: number): string {
  if (!ctx) return '';
  if (ctx >= 1e6) return (Math.round(ctx / 1e4) / 100).toLocaleString('fr-FR') + NBSP + 'M';
  return Math.round(ctx / 1000) + NBSP + 'k';
}

/** Coût estimé de ESTIMATE_RUNS recommandations, en $ (null si le prix est inconnu). */
export function estimateCost(m: OrModel): number | null {
  if (isFreeModel(m)) return 0;
  if (m.inPrice === null || m.outPrice === null) return null;
  return (ESTIMATE_RUNS * (ESTIMATE_INPUT_TOKENS * m.inPrice + ESTIMATE_OUTPUT_TOKENS * m.outPrice)) / 1e6;
}

export function estimateText(m: OrModel | undefined): string {
  const per = ' pour ' + ESTIMATE_RUNS + ' recommandations';
  if (m && isFreeModel(m)) return '≈ 0' + NBSP + '$' + per + ' (modèle gratuit, débit limité par OpenRouter).';
  const cost = m ? estimateCost(m) : null;
  if (cost === null) return 'Coût inconnu pour cet identifiant : vérifie son prix sur openrouter.ai.';
  if (cost < 0.005) return '≈ moins de 0,01' + NBSP + '$' + per + '.';
  return '≈ ' + cost.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + NBSP + '$' + per + '.';
}

/** Minuscules sans accents, pour une recherche tolérante. */
export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filtre sur le nom, le fournisseur et l'identifiant (tous les mots doivent apparaître). */
export function filterModels(list: OrModel[], query: string): OrModel[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((m) => {
    const hay = normalize(m.name + ' ' + m.provider + ' ' + m.id);
    return words.every((w) => hay.includes(w));
  });
}

const totalPrice = (m: OrModel) => (isFreeModel(m) ? 0 : m.inPrice === null || m.outPrice === null ? Infinity : m.inPrice + m.outPrice);
const COMPARE: Record<SortKey, (a: OrModel, b: OrModel) => number> = {
  price: (a, b) => totalPrice(a) - totalPrice(b) || a.name.localeCompare(b.name, 'fr'),
  ctx: (a, b) => b.ctx - a.ctx || a.name.localeCompare(b.name, 'fr'),
  name: (a, b) => a.name.localeCompare(b.name, 'fr') || a.id.localeCompare(b.id),
};

/** Groupes par fournisseur (ordre alphabétique), modèles triés dans chaque groupe. */
export function groupModels(list: OrModel[], sort: SortKey): { provider: string; models: OrModel[] }[] {
  const groups = new Map<string, OrModel[]>();
  for (const m of list) {
    const g = groups.get(m.provider);
    if (g) g.push(m); else groups.set(m.provider, [m]);
  }
  return Array.from(groups, ([provider, models]) => ({ provider, models: models.slice().sort(COMPARE[sort]) }))
    .sort((a, b) => a.provider.localeCompare(b.provider, 'fr', { sensitivity: 'base' }));
}

interface CacheEntry { at: number; models: OrModel[] }

const LEGACY_CACHE_KEY = 'ls_openrouter_models';
let legacyCleared = false;

function readCache(): CacheEntry | null {
  if (!legacyCleared) {
    legacyCleared = true;
    try { globalThis.localStorage?.removeItem(LEGACY_CACHE_KEY); } catch { /* stockage indisponible */ }
  }
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CacheEntry;
    if (!c || typeof c.at !== 'number' || !Array.isArray(c.models)) return null;
    const models = c.models.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string');
    return { at: c.at, models };
  } catch {
    return null;
  }
}

/** Liste en cache encore fraîche (moins de 24 h), sans requête. */
export function cachedModels(now = Date.now()): OrModel[] | null {
  const c = readCache();
  // Horloge reculée (date future) : cache rejeté.
  return c && now - c.at >= 0 && now - c.at < CACHE_TTL_MS && c.models.length ? c.models : null;
}

/**
 * Liste des modèles : cache frais, sinon requête publique (sans clé, sans cookie). En cas d'échec, la dernière liste
 * connue (même périmée) sert de repli ; sans elle, l'erreur remonte et l'interface passe en saisie libre.
 */
export async function loadModels(opts: { force?: boolean; now?: number } = {}): Promise<OrModel[]> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    const fresh = cachedModels(now);
    if (fresh) return fresh;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await appFetch(MODELS_URL, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const models = parseModels(await res.json());
    if (!models.length) throw new Error('Liste vide');
    try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ at: now, models } satisfies CacheEntry)); } catch { /* quota : pas de cache */ }
    return models;
  } catch (err) {
    const stale = readCache();
    if (stale && stale.models.length) return stale.models;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
