/* Palette de commandes de la console d'administration : logique pure (ni DOM, ni réseau).
 * Score flou insensible à la casse et aux accents, assemblage des groupes Comptes / Sections / Actions, navigation au clavier. */

type PaletteGroupId = 'accounts' | 'sections' | 'actions';

/** Ordre et titres des groupes de résultats. */
const PALETTE_GROUPS: readonly { id: PaletteGroupId; title: string }[] = [
  { id: 'accounts', title: 'Comptes' },
  { id: 'sections', title: 'Sections' },
  { id: 'actions', title: 'Actions' },
];

/** Délai avant la recherche de comptes côté serveur : une frappe rapide ne lance qu'un appel. */
export const PALETTE_SEARCH_DEBOUNCE_MS = 200;
/** Nombre maximal de comptes proposés par recherche. */
export const PALETTE_ACCOUNT_LIMIT = 8;

export interface PaletteEntry<R = unknown> {
  key: string;
  label: string;
  hint: string;
  ref: R;
}

export interface PaletteGroup<R = unknown> {
  id: PaletteGroupId;
  title: string;
  entries: PaletteEntry<R>[];
}

export type PaletteParts<R = unknown> = Record<PaletteGroupId, PaletteEntry<R>[]>;

const COMBINING_MARKS = /[̀-ͯ]/g;
const APOSTROPHES = /[‘’ʼ`´]/g;
const WORD_START = /[\s'\-_/.:(«»]/;

/** Forme de comparaison : NFD sans diacritiques, apostrophes droites, minuscules, espaces réduits. */
export function foldText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(APOSTROPHES, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function atWordStart(text: string, index: number): boolean {
  return index === 0 || WORD_START.test(text.charAt(index - 1));
}

/**
 * Score de correspondance (plus haut = meilleur), ou null si `query` n'est pas une sous-séquence de `text`.
 * Ordre : égalité > préfixe > sous-chaîne (début de mot de préférence) > sous-séquence espacée.
 * Une requête vide vaut 0 (tout correspond).
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query);
  if (q === '') return 0;
  const t = foldText(text);
  if (t === q) return 1000;
  const at = t.indexOf(q);
  if (at === 0) return 900 - Math.min(t.length - q.length, 100);
  if (at > 0) return (atWordStart(t, at) ? 700 : 600) - Math.min(at, 100);
  let from = 0;
  let first = -1;
  let last = -1;
  let starts = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (first < 0) first = i;
    if (atWordStart(t, i)) starts += 1;
    last = i;
    from = i + 1;
  }
  const gaps = last - first + 1 - q.length;
  // Plafonné sous 500 : une sous-séquence ne doit jamais battre une sous-chaîne.
  return Math.max(1, Math.min(450, 300 - gaps * 4 - Math.min(first, 50) + starts * 5));
}

/** Filtre et trie les entrées par score flou décroissant ; à score égal, l'ordre d'origine est conservé. Requête vide : tout, dans l'ordre. */
export function rankEntries<R>(entries: readonly PaletteEntry<R>[], query: string): PaletteEntry<R>[] {
  if (foldText(query) === '') return entries.slice();
  return entries
    .map((entry, index) => ({ entry, index, score: fuzzyScore(query, entry.label) }))
    .filter((r): r is { entry: PaletteEntry<R>; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.entry);
}

/**
 * Assemble les groupes affichés. Les comptes viennent déjà filtrés par le serveur : ils ne sont pas refiltrés.
 * Sections et actions sont filtrées localement. Un groupe vide disparaît.
 */
export function buildPaletteGroups<R>(query: string, parts: PaletteParts<R>): PaletteGroup<R>[] {
  return PALETTE_GROUPS.map(({ id, title }) => ({
    id,
    title,
    entries: id === 'accounts' ? parts.accounts.slice() : rankEntries(parts[id], query),
  })).filter((g) => g.entries.length > 0);
}

/**
 * Index actif après un déplacement ↑ (step -1) ou ↓ (step 1), avec retour en boucle. -1 si la liste est vide.
 * Sans index actif (-1), ↓ prend le premier et ↑ le dernier.
 */
export function moveActive(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Ctrl/Cmd+K ouvre la palette partout ; « / » seulement hors champ de saisie et sans modificateur. */
export function isPaletteShortcut(e: ShortcutEvent, inField: boolean): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return true;
  return e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !inField;
}
