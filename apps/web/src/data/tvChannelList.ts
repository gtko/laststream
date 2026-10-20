/* Panneau « Chaînes » du lecteur TV : puces de catégorie, recherche instantanée, favoris par profil, fenêtre de rendu.
 * Logique pure, testée. */
import { normText } from './tvRank';

export type ChipId = 'all' | 'fav' | 'box' | 'news' | 'sport' | 'kids' | 'cinema' | 'music' | 'fun' | 'docs';

const CHIPS: ReadonlyArray<{ id: ChipId; label: string }> = [
  { id: 'all', label: 'Toutes' },
  { id: 'fav', label: 'Favoris' },
  { id: 'box', label: 'Box' },
  { id: 'news', label: 'Info' },
  { id: 'sport', label: 'Sport' },
  { id: 'kids', label: 'Jeunesse' },
  { id: 'cinema', label: 'Cinéma' },
  { id: 'music', label: 'Musique' },
  { id: 'fun', label: 'Divertissement' },
  { id: 'docs', label: 'Documentaires' },
];

export interface PanelChannel {
  id: string;
  name?: string;
  num?: number | null;
  cat?: string;
  group?: string;
  source?: string;
  boxOnly?: boolean;
  box?: unknown;
  categories?: Array<{ id?: string; label?: string }>;
}

const RULES: Array<[ChipId, RegExp]> = [
  ['news', /info|news|actualit|politi/],
  ['sport', /sport|foot|rugby|tennis|golf|motor/],
  ['kids', /kid|child|jeunesse|enfant|anim|cartoon|junior/],
  ['cinema', /cinema|movie|film|serie|series/],
  ['music', /music|musique|clip|radio/],
  ['fun', /entertain|divertiss|general|generaliste|comedy|humour|lifestyle|culture|cuisine|telerealite/],
  ['docs', /documentar|science|nature|histoire|history|decouverte|education/],
];

const isBox = (c: PanelChannel): boolean => !!(c.box || c.boxOnly || c.source === 'box');

/** Puces auxquelles appartient une chaîne (hors « Toutes » et « Favoris », qui dépendent de l'utilisateur). */
function chipsOf(c: PanelChannel): Set<ChipId> {
  const out = new Set<ChipId>();
  if (isBox(c)) out.add('box');
  const labels = (c.categories ?? []).flatMap((k) => [k.id, k.label]).concat(c.cat, c.group).map((s) => normText(s)).filter(Boolean);
  for (const [id, re] of RULES) if (labels.some((l) => re.test(l))) out.add(id);
  return out;
}

export interface ChannelQuery {
  chip: ChipId;
  q: string;
  favs: ReadonlySet<string>;
}

const tokens = (q: string): string[] => String(q ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9+]+/).map((t) => normText(t)).filter(Boolean);

/** Rang d'une chaîne pour une recherche : 0 = numéro exact, 1 = nom qui commence par la saisie, 2 = contient, -1 = écartée. */
function searchRank(c: PanelChannel, q: string): number {
  const toks = tokens(q);
  if (!toks.length) return 2;
  const name = normText(c.name);
  const num = c.num ? String(c.num) : '';
  const hay = `${name}${normText(c.cat)}`;
  if (toks.length === 1 && /^\d+$/.test(toks[0]) && num === toks[0]) return 0;
  if (!toks.every((t) => hay.includes(t))) return -1;
  return name.startsWith(toks.join('')) || name.startsWith(toks[0]) ? 1 : 2;
}

/** Chaînes correspondant à la puce et à la recherche, dans l'ordre d'origine (la recherche remonte les meilleurs rangs). */
export function filterChannels<T extends PanelChannel>(list: readonly T[], query: ChannelQuery): T[] {
  const rows: Array<{ c: T; i: number; r: number }> = [];
  list.forEach((c, i) => {
    if (query.chip === 'fav' && !query.favs.has(c.id)) return;
    if (query.chip !== 'all' && query.chip !== 'fav' && !chipsOf(c).has(query.chip)) return;
    const r = searchRank(c, query.q);
    if (r >= 0) rows.push({ c, i, r });
  });
  if (tokens(query.q).length) rows.sort((a, b) => a.r - b.r || a.i - b.i);
  return rows.map((x) => x.c);
}

/** Puces à afficher avec leur effectif : « Toutes » et « Favoris » toujours, les autres seulement si elles contiennent des chaînes. */
export function chipList(list: readonly PanelChannel[], favs: ReadonlySet<string>): Array<{ id: ChipId; label: string; count: number }> {
  const count = new Map<ChipId, number>();
  list.forEach((c) => chipsOf(c).forEach((id) => count.set(id, (count.get(id) ?? 0) + 1)));
  return CHIPS.map((k) => ({
    ...k,
    count: k.id === 'all' ? list.length : k.id === 'fav' ? list.filter((c) => favs.has(c.id)).length : count.get(k.id) ?? 0,
  })).filter((k) => k.id === 'all' || k.id === 'fav' || k.count > 0);
}

// ---------- Favoris par profil ----------

const FAV_KEY = 'ls_tv_fav';

/** Clé de stockage des favoris : celle d'avant (sans profil) tant qu'aucun profil n'est actif, sinon une clé par profil. */
export const favStorageKey = (profileId?: string | null): string => (profileId ? `${FAV_KEY}:${profileId}` : FAV_KEY);

/** Ajoute ou retire un id ; renvoie la nouvelle liste (ordre d'ajout conservé) et si l'id est désormais favori. */
export function toggleId(list: readonly string[], id: string): { list: string[]; on: boolean } {
  const i = list.indexOf(id);
  if (i >= 0) return { list: list.filter((x) => x !== id), on: false };
  return { list: list.concat(id), on: true };
}

// ---------- Rendu fenêtré ----------

/**
 * Lignes à dessiner pour une liste de hauteur fixe : celles visibles plus une marge. Hors navigateur (hauteur de vue
 * inconnue), une fenêtre de `fallbackRows` lignes depuis le haut.
 */
export function windowRange(scrollTop: number, viewH: number, rowH: number, total: number, overscan = 6, fallbackRows = 14): { start: number; end: number } {
  if (total <= 0 || rowH <= 0) return { start: 0, end: 0 };
  const h = viewH > 0 ? viewH : fallbackRows * rowH;
  const first = Math.floor(Math.max(0, scrollTop) / rowH);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + Math.ceil(h / rowH) + overscan);
  return { start, end };
}

/** Position de défilement qui centre la ligne `index` dans une vue de hauteur `viewH`. */
export function centerScroll(index: number, rowH: number, viewH: number, total: number): number {
  const max = Math.max(0, total * rowH - viewH);
  return Math.min(max, Math.max(0, index * rowH - (viewH - rowH) / 2));
}
