/* Émissions diffusées en deux parties (ou plus) : « Les auditions (1) » puis « Les auditions (2) » sont deux épisodes
 * d'une même émission. Détection d'après les titres d'épisodes, pour dire « Partie 1/2 » et enchaîner la suite. */

export interface EpisodePart {
  /** Rang de la partie (1 pour la première). */
  index: number;
  /** Nombre de parties de l'émission. */
  total: number;
  /** Titre de l'épisode sans son suffixe de partie (« Émission 3 : les auditions »). */
  title: string;
}

interface Parsed { stem: string; index: number; total: number | null }

// « (1) », « [2] », « (1/2) », « - partie 2 », « Partie 1/2 », « 1/2 » en fin de titre.
const BARE_FRACTION = /\s+(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;
const SUFFIXES: RegExp[] = [
  /\s*[([]\s*(\d{1,2})\s*(?:\/\s*(\d{1,2}))?\s*[)\]]\s*$/,
  /[\s,:–—-]*\bpartie\s*(\d{1,2})(?:\s*(?:\/|sur)\s*(\d{1,2}))?\s*$/i,
  BARE_FRACTION,
];
const MAX_PARTS = 6;

function parse(name: string): Parsed | null {
  for (const re of SUFFIXES) {
    const m = re.exec(name);
    if (!m) continue;
    const stem = name.slice(0, m.index).trim();
    const index = Number(m[1]);
    const total = m[2] ? Number(m[2]) : null;
    // « 1/4 » nu en fin de titre est plus souvent un tour de compétition qu'une partie : les fractions nues s'arrêtent à 3.
    if (re === BARE_FRACTION && total !== null && total > 3) return null;
    if (!stem || index < 1 || index > MAX_PARTS || (total !== null && (total < index || total > MAX_PARTS))) return null;
    return { stem, index, total };
  }
  return null;
}

const key = (stem: string): string => stem.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Parties d'émission dans une liste d'épisodes (saisons mêlées admises), résultat aligné sur l'entrée (null : épisode seul).
 * Un titre « … 1/2 » est une partie à lui seul ; un titre « … (1) » n'en est une que s'il est suivi, dans la même saison,
 * de l'épisode suivant au même titre « … (2) » (évite de prendre pour une partie un titre qui finit par un chiffre).
 */
export function episodeParts(list: readonly { season?: number; episode: number; name: string }[]): (EpisodePart | null)[] {
  const out: (EpisodePart | null)[] = list.map(() => null);
  const order = list.map((_, i) => i).sort((a, b) => (list[a].season ?? 0) - (list[b].season ?? 0) || list[a].episode - list[b].episode);
  const parsed = order.map((i) => parse(list[i].name));
  for (let k = 0; k < order.length; k++) {
    const first = parsed[k];
    if (!first || first.index !== 1) continue;
    const run = [k];
    for (let j = k + 1; j < order.length; j++) {
      const p = parsed[j];
      const prev = list[order[j - 1]];
      const cur = list[order[j]];
      if (!p || p.index !== run.length + 1 || key(p.stem) !== key(first.stem) || (cur.season ?? 0) !== (prev.season ?? 0) || cur.episode !== prev.episode + 1) break;
      run.push(j);
    }
    const explicit = first.total;
    if (run.length < 2 && !(explicit && explicit >= 2)) continue;
    const total = Math.max(run.length, explicit ?? 0);
    run.forEach((j, n) => { out[order[j]] = { index: n + 1, total, title: parsed[j]!.stem }; });
    k += run.length - 1;
  }
  // « 2/2 » dont la partie 1 n'est pas dans la liste (fenêtre tronquée) : l'indication reste fiable.
  order.forEach((i, k) => {
    const p = parsed[k];
    if (!out[i] && p && p.total && p.total >= 2) out[i] = { index: p.index, total: p.total, title: p.stem };
  });
  return out;
}

/** « Partie 1/2 ». */
export const partLabel = (p: Pick<EpisodePart, 'index' | 'total'>): string => `Partie ${p.index}/${p.total}`;
